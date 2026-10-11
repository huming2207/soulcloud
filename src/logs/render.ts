// Turns stored log rows into API entries. Binary rows are rendered against the
// ELF of the firmware that was running when they arrived; the parsed ELFs are
// kept in a small LRU cache.

import { models } from "../db.ts";
import type { BlobStore } from "../firmware/storage.ts";
import { logDto, type LogEntry } from "../http/schemas.ts";
import { log } from "../log.ts";
import { ElfStrings } from "./on9log/elf.ts";
import { renderPacket } from "./on9log/render.ts";

const CACHE_SIZE = 8;

export interface LogRow {
  id: number;
  receivedAt: Date;
  loggedAt: Date | null;
  kind: string;
  level: number;
  tag: string | null;
  message: string | null;
  deviceTimeMs: number | null;
  seq: number | null;
  bootId: number | null;
  raw: Uint8Array | null;
  firmwareId: string | null;
}

export class LogRenderer {
  private readonly blobs: BlobStore;
  private readonly cache = new Map<string, Promise<ElfStrings | null>>();

  constructor(blobs: BlobStore) {
    this.blobs = blobs;
  }

  async render(rows: LogRow[]): Promise<LogEntry[]> {
    const out: LogEntry[] = [];
    for (const row of rows) {
      if (row.kind !== "bin" || !row.raw) {
        out.push(logDto(row));
        continue;
      }
      const elf = row.firmwareId ? await this.elf(row.firmwareId) : null;
      const r = renderPacket(row.raw, elf);
      out.push(
        logDto(row, {
          tag: r.tag,
          message: r.message,
          decoded: r.decoded,
          raw: r.decoded ? null : Buffer.from(row.raw).toString("base64"),
        }),
      );
    }
    return out;
  }

  /** Forget a cached ELF, e.g. after one was attached to a firmware. */
  invalidate(firmwareId: string): void {
    this.cache.delete(firmwareId);
  }

  private elf(firmwareId: string): Promise<ElfStrings | null> {
    let entry = this.cache.get(firmwareId);
    if (entry) {
      // Refresh LRU position.
      this.cache.delete(firmwareId);
      this.cache.set(firmwareId, entry);
      return entry;
    }
    entry = this.load(firmwareId);
    this.cache.set(firmwareId, entry);
    if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
    return entry;
  }

  private async load(firmwareId: string): Promise<ElfStrings | null> {
    const fw = await models.Firmware.select("elfKey").where({ id: firmwareId }).first();
    if (!fw?.elfKey) return null;
    const bytes = await this.blobs.get(fw.elfKey);
    if (!bytes) return null;
    try {
      return ElfStrings.parse(bytes);
    } catch (err) {
      log.warn({ err, firmwareId }, "stored ELF could not be parsed");
      return null;
    }
  }
}
