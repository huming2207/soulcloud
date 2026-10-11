// `d/<id>/up/status`: birth message after connecting and periodic heartbeat.

import { z } from "zod";
import { models } from "../db.ts";
import { bus } from "../events.ts";
import { resetReasonName } from "../platforms/index.ts";
import type { IngestDevice } from "./cache.ts";
import { invalidateDevice } from "./cache.ts";
import { findFirmwareByElf } from "../firmware/lookup.ts";
import { toJson } from "../json.ts";

export const deviceStatusSchema = z.object({
  /** True on the first status after (re)connecting. */
  birth: z.boolean().optional(),
  uptimeMs: z.number().int().nonnegative(),
  bootId: z.number().int().nonnegative().optional(),
  resetReason: z.union([z.string().max(64), z.number().int()]).optional(),
  fw: z
    .object({
      version: z.string().max(64).optional(),
      elfSha256: z.string().regex(/^[0-9a-fA-F]{8,64}$/).optional(),
      project: z.string().max(64).optional(),
      sdk: z.string().max(64).optional(),
    })
    .optional(),
  chip: z.string().max(32).optional(),
  heap: z.object({ free: z.number().int(), minFree: z.number().int().optional() }).partial().optional(),
  rssi: z.number().int().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

export type DeviceStatus = z.infer<typeof deviceStatusSchema>;

export async function handleStatus(device: IngestDevice, payload: Buffer): Promise<void> {
  const status = deviceStatusSchema.parse(JSON.parse(payload.toString("utf8")));
  const elfSha256 = status.fw?.elfSha256?.toLowerCase() ?? null;
  const firmware = elfSha256 ? await findFirmwareByElf(device.ownerId, elfSha256) : null;
  const health = { heap: status.heap ?? null, rssi: status.rssi ?? null, extra: status.extra ?? null };

  await models.Device.where({ id: device.id }).update({
    lastSeenAt: new Date(),
    uptimeMs: status.uptimeMs,
    ...(status.bootId !== undefined && { bootId: status.bootId }),
    ...(status.resetReason !== undefined && { resetReason: resetReasonName(device.platform, status.resetReason) }),
    ...(status.fw?.version && { fwVersion: status.fw.version }),
    ...(elfSha256 && { elfSha256, currentFirmwareId: firmware?.id ?? null }),
    ...(status.chip && { chip: status.chip }),
    health: toJson(health),
  });
  await models.DeviceHeartbeat.create({ deviceId: device.id, uptimeMs: status.uptimeMs, data: toJson(status) });
  invalidateDevice(device.id);

  bus.emit("device.status", {
    deviceId: device.id,
    elfSha256,
    fwVersion: status.fw?.version ?? null,
    birth: status.birth === true,
  });
}
