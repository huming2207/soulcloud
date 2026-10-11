// OTA rollout. One task per device and job; a device works on one task at a time.
//
//   pending ──(device online / ota.check)──▶ sent ──▶ downloading ──▶ verifying ──▶ rebooting
//      │                                       │            (evt/ota progress events)        │
//      └──────────────▶ cancelled              └──▶ failed ◀───────────────────────────────── ┤
//                                                            succeeded ◀── birth reports the new ELF hash
//
// The device gets `ota.start` with a short-lived signed HTTPS URL and pulls the
// image itself (e.g. esp_https_ota), so the broker never carries firmware.

import { z } from "zod";
import { models } from "../db.ts";
import { bus } from "../events.ts";
import { signedDownloadUrl } from "../firmware/service.ts";
import { ApiError, badRequest, notFound } from "../http/errors.ts";
import { log } from "../log.ts";
import { elfShaMatches } from "../platforms/index.ts";
import type { Commands } from "../rpc/commands.ts";
import type { DeviceApi } from "../rpc/device-api.ts";
import type { IngestDevice } from "../devices/cache.ts";

const ACTIVE = ["sent", "downloading", "verifying", "rebooting"] as const;
const DOWNLOAD_URL_TTL_SEC = 3600;
const START_TTL_SEC = 3600;

const otaEventSchema = z.object({
  taskId: z.uuid(),
  state: z.enum(["downloading", "verifying", "rebooting", "failed"]),
  progress: z.number().min(0).max(100).optional(),
  error: z.string().max(500).optional(),
});

type Task = { id: string; jobId: string; deviceId: string; status: string };

export class OtaService {
  private readonly commands: Commands;

  constructor(commands: Commands, deviceApi: DeviceApi) {
    this.commands = commands;
    deviceApi.onEvent("ota", (device, payload) => this.onEvent(device, payload));
    deviceApi.onRequest("ota.check", (device) => this.check(device));
  }

  /** Wires bus listeners; call once in the process that runs ingest. */
  listen(): void {
    bus.on("device.connected", ({ deviceId }) => void this.dispatch(deviceId).catch((err) => log.error({ err, deviceId }, "OTA dispatch failed")));
    bus.on("device.status", (e) => void this.onStatus(e.deviceId, e.elfSha256, e.birth).catch((err) => log.error({ err }, "OTA status check failed")));
    bus.on("command.updated", (e) => {
      if (e.status === "failed" || e.status === "expired") void this.onCommandFailed(e.commandId, e.status).catch((err) => log.error({ err }, "OTA command check failed"));
    });
  }

  async createJob(ownerId: string, firmwareId: string, deviceIds: string[], note: string | null, isAdmin: boolean) {
    const firmware = await models.Firmware.where({ id: firmwareId }).first();
    if (!firmware || (!isAdmin && firmware.ownerId !== ownerId)) throw notFound("firmware");
    const unique = [...new Set(deviceIds)];
    const devices = await models.Device.where((d) => d.id.in(unique)).all();
    const problems: Record<string, string> = {};
    for (const id of unique) {
      const d = devices.find((x) => x.id === id);
      if (!d || (!isAdmin && d.ownerId !== ownerId)) problems[id] = "not found";
      else if (d.status !== "active") problems[id] = "not paired";
      else if (d.platform !== firmware.platform || (d.chip && d.chip !== firmware.chip)) problems[id] = `device is ${d.chip ?? d.platform}, firmware is for ${firmware.chip}`;
    }
    if (Object.keys(problems).length) throw badRequest("some devices can't take this firmware", problems);

    const job = await models.OtaJob.create({ ownerId, firmwareId, note });
    const tasks = await models.OtaTask.createAll(unique.map((deviceId) => ({ jobId: job.id, deviceId })));
    for (const d of devices) if (d.online) await this.dispatch(d.id);
    return { job, tasks };
  }

  /** Starts the device's oldest pending task unless one is already running. */
  async dispatch(deviceId: string) {
    const running = await models.OtaTask.where({ deviceId }).where((t) => t.status.in([...ACTIVE])).first();
    if (running) return null;
    const next = await models.OtaTask.where({ deviceId, status: "pending" }).orderBy((t) => t.createdAt.asc()).first();
    return next ? this.start(next) : null;
  }

  private async start(task: Task) {
    const job = await models.OtaJob.where({ id: task.jobId }).first();
    const firmware = job && (await models.Firmware.where({ id: job.firmwareId }).first());
    const device = await models.Device.select("elfSha256").where({ id: task.deviceId }).first();
    if (!firmware || !device) return null;
    const params = this.startParams(task, firmware);
    const command = await this.commands.create({ deviceId: task.deviceId, method: "ota.start", params, ttlSec: START_TTL_SEC });
    await models.OtaTask.where({ id: task.id, status: "pending" }).update({
      status: "sent",
      commandId: command.id,
      previousElfSha256: device.elfSha256,
    });
    log.info({ taskId: task.id, deviceId: task.deviceId, version: firmware.version }, "OTA started");
    return params;
  }

  private startParams(task: Task, firmware: { id: string; binSha256: string; size: number; version: string }) {
    return {
      url: signedDownloadUrl(firmware.id, task.deviceId, DOWNLOAD_URL_TTL_SEC),
      sha256: firmware.binSha256,
      size: firmware.size,
      version: firmware.version,
      taskId: task.id,
    };
  }

  /** Device asks (e.g. at boot) whether there is an update for it. */
  private async check(device: IngestDevice) {
    const active = await models.OtaTask.where({ deviceId: device.id }).where((t) => t.status.in(["sent", "downloading"])).first();
    if (active) {
      const job = await models.OtaJob.where({ id: active.jobId }).first();
      const firmware = job && (await models.Firmware.where({ id: job.firmwareId }).first());
      return { update: firmware ? this.startParams(active, firmware) : null };
    }
    return { update: await this.dispatch(device.id) };
  }

  private async onEvent(device: IngestDevice, payload: unknown) {
    const e = otaEventSchema.parse(payload);
    const failed = e.state === "failed";
    const updated = await models.OtaTask.where({ id: e.taskId, deviceId: device.id })
      .where((t) => t.status.in([...ACTIVE]))
      .update({
        status: e.state,
        ...(e.progress !== undefined && { progress: Math.round(e.progress) }),
        ...(failed && { error: e.error ?? "device reported failure", completedAt: new Date() }),
      });
    if (updated && failed) await this.dispatch(device.id);
  }

  private async onStatus(deviceId: string, elfSha256: string | null, birth: boolean) {
    const tasks = await models.OtaTask.where({ deviceId }).where((t) => t.status.in([...ACTIVE])).all();
    for (const task of tasks) {
      const job = await models.OtaJob.where({ id: task.jobId }).first();
      const firmware = job && (await models.Firmware.where({ id: job.firmwareId }).first());
      if (!firmware) continue;
      if (elfShaMatches(firmware.elfSha256, elfSha256)) {
        await models.OtaTask.where({ id: task.id }).update({ status: "succeeded", progress: 100, completedAt: new Date(), error: null });
        log.info({ taskId: task.id, deviceId }, "OTA succeeded");
      } else if (birth && (task.status === "verifying" || task.status === "rebooting")) {
        await models.OtaTask.where({ id: task.id }).update({
          status: "failed",
          error: "device restarted without the new firmware (rolled back?)",
          completedAt: new Date(),
        });
      }
    }
    if (tasks.length) await this.dispatch(deviceId);
  }

  private async onCommandFailed(commandId: string, status: string) {
    const task = await models.OtaTask.where({ commandId, status: "sent" }).first();
    if (!task) return;
    const command = await models.Command.select("error").where({ id: commandId }).first();
    await models.OtaTask.where({ id: task.id, status: "sent" }).update({
      status: "failed",
      error: status === "expired" ? "device did not answer ota.start in time" : (command?.error ?? "device refused the update"),
      completedAt: new Date(),
    });
    await this.dispatch(task.deviceId);
  }

  async cancelJob(jobId: string) {
    const tasks = await models.OtaTask.where({ jobId }).where((t) => t.status.in(["pending", ...ACTIVE])).all();
    for (const task of tasks) {
      if (task.status === "rebooting" || task.status === "verifying") continue; // too late to stop
      await models.OtaTask.where({ id: task.id }).update({ status: "cancelled", completedAt: new Date() });
      if (task.status !== "pending") {
        await this.commands.create({ deviceId: task.deviceId, method: "ota.cancel", params: { taskId: task.id }, ttlSec: 300 });
      }
    }
  }
}

export function assertOwner(isAdmin: boolean, ownerId: string, userId: string) {
  if (!isAdmin && ownerId !== userId) throw new ApiError(404, "not_found", "not found");
}
