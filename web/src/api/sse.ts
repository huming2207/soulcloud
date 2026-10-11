import { authFetch } from "./client";

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/**
 * Reads a Server-Sent Events stream with fetch (EventSource can't send the
 * Authorization header). Resolves when the stream ends; rejects on errors.
 */
export async function readSse(path: string, onEvent: (e: SseEvent) => void, signal: AbortSignal): Promise<void> {
  const response = await authFetch(path, { signal, headers: { Accept: "text/event-stream" } });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event: SseEvent = { event: "message", data: "" };
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const val = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event.event = val;
        else if (field === "data") data.push(val);
        else if (field === "id") event.id = val;
      }
      if (data.length) onEvent({ ...event, data: data.join("\n") });
    }
  }
}
