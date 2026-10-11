// Plain-text device logs: newline-separated lines, usually ESP-IDF formatted,
// e.g. `I (1234) wifi: connected` or `W (12:34:56.789) app: low heap`.

export interface TextLogLine {
  level: number;
  tag: string | null;
  deviceTimeMs: number | null;
  message: string;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const LEVELS: Record<string, number> = { E: 1, W: 2, I: 3, D: 4, V: 5 };
const ESP_LINE = /^([EWIDV]) \((\d+|\d{2}:\d{2}:\d{2}\.\d{3})\) ([^:]{1,64}): ?(.*)$/s;

export const MAX_TEXT_LINE = 4096;
export const MAX_TEXT_LINES_PER_MESSAGE = 2000;

export function parseTextLine(raw: string): TextLogLine {
  const line = raw.replace(ANSI, "").replace(/\r$/, "");
  const m = ESP_LINE.exec(line);
  if (!m) return { level: 3, tag: null, deviceTimeMs: null, message: line.slice(0, MAX_TEXT_LINE) };
  const [, lvl, ts, tag, message] = m;
  // Only the milliseconds-since-boot form is a device clock we can use.
  const deviceTimeMs = ts && /^\d+$/.test(ts) ? Number(ts) : null;
  return { level: LEVELS[lvl!] ?? 3, tag: tag!.trim(), deviceTimeMs, message: message!.slice(0, MAX_TEXT_LINE) };
}

export function parseTextLog(payload: Buffer): TextLogLine[] {
  return payload
    .toString("utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(0, MAX_TEXT_LINES_PER_MESSAGE)
    .map(parseTextLine);
}
