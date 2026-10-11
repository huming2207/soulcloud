// Response shapes of the public API and the row -> DTO mappers.

import { z } from "@hono/zod-openapi";
import { LOG_LEVELS, levelName } from "../logs/levels.ts";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const dateTime = () => z.iso.datetime();

export const DeviceIdParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, example: "7KQ2M-XH9PA" }),
});

export const UuidParam = z.object({
  id: z.uuid().openapi({ param: { name: "id", in: "path" } }),
});

// --- users -------------------------------------------------------------------

export const UserSchema = z
  .object({
    id: z.uuid(),
    email: z.email(),
    name: z.string().nullable(),
    role: z.enum(["user", "admin"]),
    createdAt: dateTime(),
  })
  .openapi("User");

export function userDto(u: { id: string; email: string; name: string | null; role: string; createdAt: Date }) {
  return { id: u.id, email: u.email, name: u.name, role: u.role as "user" | "admin", createdAt: u.createdAt.toISOString() };
}

// --- devices -----------------------------------------------------------------

export const DeviceSchema = z
  .object({
    id: z.string().openapi({ example: "7KQ2M-XH9PA", description: "Also the MQTT username and client id" }),
    name: z.string(),
    ownerId: z.uuid(),
    hardwareId: z.string(),
    platform: z.string().openapi({ example: "esp32" }),
    chip: z.string().nullable().openapi({ example: "esp32s3" }),
    status: z.enum(["active", "revoked", "superseded"]),
    online: z.boolean(),
    lastSeenAt: dateTime().nullable(),
    lastConnectedAt: dateTime().nullable(),
    lastDisconnectedAt: dateTime().nullable(),
    uptimeMs: z.number().nullable(),
    bootId: z.number().nullable(),
    resetReason: z.string().nullable().openapi({ example: "power_on" }),
    fwVersion: z.string().nullable(),
    elfSha256: z.string().nullable(),
    currentFirmwareId: z.uuid().nullable(),
    health: z.unknown().nullable().openapi({ description: "Heap, RSSI and device-defined extras from the last heartbeat" }),
    createdAt: dateTime(),
    revokedAt: dateTime().nullable(),
  })
  .openapi("Device");

type DeviceRow = {
  id: string;
  name: string;
  ownerId: string;
  hardwareId: string;
  platform: string;
  chip: string | null;
  status: string;
  online: boolean;
  lastSeenAt: Date | null;
  lastConnectedAt: Date | null;
  lastDisconnectedAt: Date | null;
  uptimeMs: number | null;
  bootId: number | null;
  resetReason: string | null;
  fwVersion: string | null;
  elfSha256: string | null;
  currentFirmwareId: string | null;
  health: unknown;
  createdAt: Date;
  revokedAt: Date | null;
};

export function deviceDto(d: DeviceRow): z.infer<typeof DeviceSchema> {
  return {
    id: d.id,
    name: d.name,
    ownerId: d.ownerId,
    hardwareId: d.hardwareId,
    platform: d.platform,
    chip: d.chip,
    status: d.status as "active" | "revoked" | "superseded",
    online: d.online,
    lastSeenAt: iso(d.lastSeenAt),
    lastConnectedAt: iso(d.lastConnectedAt),
    lastDisconnectedAt: iso(d.lastDisconnectedAt),
    uptimeMs: d.uptimeMs,
    bootId: d.bootId,
    resetReason: d.resetReason,
    fwVersion: d.fwVersion,
    elfSha256: d.elfSha256,
    currentFirmwareId: d.currentFirmwareId,
    health: d.health ?? null,
    createdAt: d.createdAt.toISOString(),
    revokedAt: iso(d.revokedAt),
  };
}

export const HeartbeatSchema = z
  .object({ id: z.number(), receivedAt: dateTime(), uptimeMs: z.number().nullable(), data: z.unknown() })
  .openapi("Heartbeat");

export function heartbeatDto(h: { id: number; receivedAt: Date; uptimeMs: number | null; data: unknown }) {
  return { id: h.id, receivedAt: h.receivedAt.toISOString(), uptimeMs: h.uptimeMs, data: h.data };
}

// --- commands ----------------------------------------------------------------

export const CommandSchema = z
  .object({
    id: z.uuid().openapi({ description: "Sent to the device as MQTT 5 correlation data" }),
    deviceId: z.string(),
    method: z.string().openapi({ example: "shell" }),
    params: z.unknown().nullable(),
    status: z.enum(["queued", "sent", "succeeded", "failed", "expired"]),
    result: z.unknown().nullable(),
    error: z.string().nullable(),
    requestedById: z.uuid().nullable(),
    createdAt: dateTime(),
    sentAt: dateTime().nullable(),
    completedAt: dateTime().nullable(),
    expiresAt: dateTime(),
  })
  .openapi("Command");

type CommandRow = {
  id: string;
  deviceId: string;
  method: string;
  params: unknown;
  status: string;
  result: unknown;
  error: string | null;
  requestedById: string | null;
  createdAt: Date;
  sentAt: Date | null;
  completedAt: Date | null;
  expiresAt: Date;
};

export function commandDto(c: CommandRow): z.infer<typeof CommandSchema> {
  return {
    id: c.id,
    deviceId: c.deviceId,
    method: c.method,
    params: c.params ?? null,
    status: c.status as z.infer<typeof CommandSchema>["status"],
    result: c.result ?? null,
    error: c.error,
    requestedById: c.requestedById,
    createdAt: c.createdAt.toISOString(),
    sentAt: iso(c.sentAt),
    completedAt: iso(c.completedAt),
    expiresAt: c.expiresAt.toISOString(),
  };
}

// --- logs ----------------------------------------------------------------------

export const LogEntrySchema = z
  .object({
    id: z.number(),
    receivedAt: dateTime(),
    loggedAt: dateTime().nullable().openapi({ description: "Estimated wall-clock time (binary logs with a time sync)" }),
    kind: z.enum(["text", "bin"]),
    level: z.enum(LOG_LEVELS),
    tag: z.string().nullable(),
    message: z.string().nullable(),
    deviceTimeMs: z.number().nullable().openapi({ description: "Device milliseconds since boot" }),
    seq: z.number().nullable(),
    bootId: z.number().nullable(),
    decoded: z.boolean().openapi({ description: "False for binary entries that could not be rendered (e.g. no ELF)" }),
    raw: z.string().nullable().openapi({ description: "Base64 packet bytes of binary entries that were not decoded" }),
  })
  .openapi("LogEntry");

export type LogEntry = z.infer<typeof LogEntrySchema>;

export function logDto(
  l: {
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
  },
  rendered?: { tag: string | null; message: string | null; decoded: boolean; raw: string | null },
): LogEntry {
  return {
    id: l.id,
    receivedAt: l.receivedAt.toISOString(),
    loggedAt: iso(l.loggedAt),
    kind: l.kind as "text" | "bin",
    level: levelName(l.level),
    tag: rendered?.tag ?? l.tag,
    message: rendered?.message ?? l.message,
    deviceTimeMs: l.deviceTimeMs,
    seq: l.seq,
    bootId: l.bootId,
    decoded: rendered?.decoded ?? true,
    raw: rendered?.raw ?? null,
  };
}

// --- firmware & OTA ------------------------------------------------------------

export const FirmwareSchema = z
  .object({
    id: z.uuid(),
    ownerId: z.uuid(),
    platform: z.string(),
    chip: z.string(),
    projectName: z.string(),
    version: z.string(),
    sdkVersion: z.string().nullable(),
    buildTime: z.string().nullable(),
    elfSha256: z.string(),
    binSha256: z.string(),
    size: z.number(),
    hasElf: z.boolean().openapi({ description: "Whether binary logs from this firmware can be decoded" }),
    notes: z.string().nullable(),
    createdAt: dateTime(),
  })
  .openapi("Firmware");

export function firmwareDto(f: {
  id: string;
  ownerId: string;
  platform: string;
  chip: string;
  projectName: string;
  version: string;
  idfVersion: string | null;
  buildTime: string | null;
  elfSha256: string;
  binSha256: string;
  size: number;
  elfKey: string | null;
  notes: string | null;
  createdAt: Date;
}): z.infer<typeof FirmwareSchema> {
  return {
    id: f.id,
    ownerId: f.ownerId,
    platform: f.platform,
    chip: f.chip,
    projectName: f.projectName,
    version: f.version,
    sdkVersion: f.idfVersion,
    buildTime: f.buildTime,
    elfSha256: f.elfSha256,
    binSha256: f.binSha256,
    size: f.size,
    hasElf: f.elfKey !== null,
    notes: f.notes,
    createdAt: f.createdAt.toISOString(),
  };
}

export const OtaTaskSchema = z
  .object({
    id: z.uuid(),
    jobId: z.uuid(),
    deviceId: z.string(),
    status: z.enum(["pending", "sent", "downloading", "verifying", "rebooting", "succeeded", "failed", "cancelled"]),
    progress: z.number().openapi({ description: "0-100" }),
    error: z.string().nullable(),
    createdAt: dateTime(),
    updatedAt: dateTime(),
    completedAt: dateTime().nullable(),
  })
  .openapi("OtaTask");

export function otaTaskDto(t: {
  id: string;
  jobId: string;
  deviceId: string;
  status: string;
  progress: number;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}): z.infer<typeof OtaTaskSchema> {
  return {
    id: t.id,
    jobId: t.jobId,
    deviceId: t.deviceId,
    status: t.status as z.infer<typeof OtaTaskSchema>["status"],
    progress: t.progress,
    error: t.error,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    completedAt: iso(t.completedAt),
  };
}

export const OtaJobSchema = z
  .object({
    id: z.uuid(),
    ownerId: z.uuid(),
    firmwareId: z.uuid(),
    note: z.string().nullable(),
    createdAt: dateTime(),
    tasks: z.array(OtaTaskSchema),
  })
  .openapi("OtaJob");
