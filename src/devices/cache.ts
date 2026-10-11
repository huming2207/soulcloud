// Short-lived cache of the device fields the ingest path needs on every
// message, so a chatty device doesn't cost a database read per log batch.

import { models } from "../db.ts";

export interface IngestDevice {
  id: string;
  ownerId: string;
  status: string;
  platform: string;
  currentFirmwareId: string | null;
  bootId: number | null;
}

const TTL_MS = 10_000;
const entries = new Map<string, { at: number; device: IngestDevice | null }>();

export async function getIngestDevice(id: string): Promise<IngestDevice | null> {
  const hit = entries.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.device;
  const device = await models.Device.select("id", "ownerId", "status", "platform", "currentFirmwareId", "bootId")
    .where({ id })
    .first();
  entries.set(id, { at: Date.now(), device });
  if (entries.size > 50_000) entries.clear();
  return device;
}

export function invalidateDevice(id: string): void {
  entries.delete(id);
}
