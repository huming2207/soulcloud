// In-process event bus. Wakes up `?wait=` HTTP calls and SSE streams when the
// ingest consumer records something. With several platform instances this is
// the seam where Postgres LISTEN/NOTIFY (or a broker fan-out) would plug in.

import { EventEmitter } from "node:events";

export interface BusEvents {
  "command.updated": { commandId: string; deviceId: string; status: string };
  "device.logs": { deviceId: string; ids: number[] };
  "device.status": { deviceId: string; elfSha256: string | null; fwVersion: string | null; birth: boolean };
  "device.connected": { deviceId: string };
  "device.disconnected": { deviceId: string };
}

type Name = keyof BusEvents;

class Bus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit<K extends Name>(name: K, payload: BusEvents[K]): void {
    this.emitter.emit(name, payload);
  }

  on<K extends Name>(name: K, fn: (payload: BusEvents[K]) => void): () => void {
    this.emitter.on(name, fn);
    return () => this.emitter.off(name, fn);
  }

  /** Resolves with the first matching event, or null after `timeoutMs`. */
  waitFor<K extends Name>(name: K, match: (p: BusEvents[K]) => boolean, timeoutMs: number, signal?: AbortSignal) {
    return new Promise<BusEvents[K] | null>((resolve) => {
      const done = (value: BusEvents[K] | null) => {
        clearTimeout(timer);
        off();
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => done(null);
      const off = this.on(name, (p) => match(p) && done(p));
      const timer = setTimeout(() => done(null), timeoutMs);
      signal?.addEventListener("abort", onAbort);
    });
  }
}

export const bus = new Bus();
