// Log levels shared by text and binary logs (on9log_level_t values).
export const LOG_LEVELS = ["none", "error", "warn", "info", "debug", "verbose"] as const;
export type LogLevelName = (typeof LOG_LEVELS)[number];

export function levelName(level: number): LogLevelName {
  return LOG_LEVELS[level] ?? "none";
}

export function levelFromName(name: string): number | undefined {
  const i = LOG_LEVELS.indexOf(name as LogLevelName);
  return i === -1 ? undefined : i;
}
