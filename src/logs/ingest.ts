// Stores device logs. Text lines are stored parsed; on9log packets are stored
// raw with their header fields and rendered on read (rendering needs the ELF).

import { models } from "../db.ts";
import { bus } from "../events.ts";
import { log } from "../log.ts";
import { resetReasonName } from "../platforms/index.ts";
import { type IngestDevice, invalidateDevice } from "../devices/cache.ts";
import { parseTextLog } from "./text.ts";
import { PacketType, parseBoot, parseDropped, parseTimeSync, splitPackets, type On9logPacket } from "./on9log/packet.ts";

const LEVEL_INFO = 3;
const LEVEL_WARN = 2;

export async function ingestTextLog(device: IngestDevice, payload: Buffer): Promise<void> {
  const lines = parseTextLog(payload);
  if (lines.length === 0) return;
  const rows = await models.DeviceLog.select("id").createAll(
    lines.map((l) => ({
      deviceId: device.id,
      kind: "text" as const,
      level: l.level,
      tag: l.tag,
      deviceTimeMs: l.deviceTimeMs,
      message: l.message,
      bootId: device.bootId,
      firmwareId: device.currentFirmwareId,
    })),
  );
  bus.emit("device.logs", { deviceId: device.id, ids: rows.map((r) => r.id) });
}

/**
 * A batch of back-to-back on9log packets. A TIME_SYNC packet (normally the last
 * one) anchors the batch: its device clock reading corresponds to "now", which
 * gives every other packet in the batch an estimated wall-clock time.
 */
export async function ingestBinaryLog(device: IngestDevice, payload: Buffer): Promise<void> {
  const receivedAt = new Date();
  const { packets, error } = splitPackets(payload);
  if (error) log.warn({ deviceId: device.id, error, parsed: packets.length }, "malformed on9log batch");

  let bootId = device.bootId;
  const sync = packets.find((p) => p.type === PacketType.TimeSync);
  const syncInfo = sync ? parseTimeSync(sync) : null;
  if (syncInfo) bootId = syncInfo.bootId;

  const loggedAt = (p: On9logPacket): Date | null => {
    if (!sync) return null;
    // u32 millisecond counters wrap; interpret the delta modulo 2^32.
    const delta = (sync.timeMs - p.timeMs) >>> 0;
    return delta < 0x80000000 ? new Date(receivedAt.getTime() - delta) : null;
  };

  const rows = [];
  for (const p of packets) {
    const base = {
      deviceId: device.id,
      receivedAt,
      kind: "bin" as const,
      level: p.level,
      deviceTimeMs: p.timeMs,
      loggedAt: loggedAt(p),
      seq: p.seq,
      packetType: p.type,
      firmwareId: device.currentFirmwareId,
    };
    switch (p.type) {
      case PacketType.TimeSync:
        continue;
      case PacketType.Boot: {
        const boot = parseBoot(p);
        if (!boot) continue;
        bootId = boot.bootId;
        const reason = resetReasonName(device.platform, boot.resetReason);
        await models.Device.where({ id: device.id }).update({ bootId: boot.bootId, resetReason: reason });
        invalidateDevice(device.id);
        rows.push({ ...base, level: LEVEL_INFO, bootId, tag: "boot", message: `boot ${boot.bootId} (${reason})` });
        break;
      }
      case PacketType.Dropped: {
        const dropped = parseDropped(p);
        rows.push({ ...base, level: LEVEL_WARN, bootId, tag: "on9log", message: `${dropped?.count ?? "?"} log packets dropped` });
        break;
      }
      default:
        rows.push({ ...base, bootId, raw: new Uint8Array(p.raw) });
    }
  }
  if (rows.length === 0) return;
  const created = await models.DeviceLog.select("id").createAll(rows);
  bus.emit("device.logs", { deviceId: device.id, ids: created.map((r) => r.id) });
}
