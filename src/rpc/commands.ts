// Command lifecycle: queued -> sent -> succeeded | failed | expired.
//
// A command is stored first, then published to d/<id>/down/req/<method> with
// MQTT 5 Correlation Data = command id and Response Topic = d/<id>/up/res.
// If the device has a persistent session the broker holds it until the device
// returns; if it has none yet, the command stays queued and is flushed when
// the device next connects. Expired commands are never delivered.

import type { Broker } from "../broker/amqp.ts";
import { deviceTopics, mqttTopicToRoutingKey } from "../broker/topics.ts";
import { models } from "../db.ts";
import { bus } from "../events.ts";
import { toJson } from "../json.ts";
import { log } from "../log.ts";
import { deviceResponseSchema } from "./methods.ts";

export interface NewCommand {
  deviceId: string;
  method: string;
  params: Record<string, unknown>;
  ttlSec: number;
  requestedById?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Commands {
  private readonly broker: Broker;

  constructor(broker: Broker) {
    this.broker = broker;
  }

  async create(cmd: NewCommand) {
    const command = await models.Command.create({
      deviceId: cmd.deviceId,
      method: cmd.method,
      params: toJson(cmd.params),
      requestedById: cmd.requestedById ?? null,
      expiresAt: new Date(Date.now() + cmd.ttlSec * 1000),
    });
    return (await this.send(command)) ?? command;
  }

  /** Publishes a queued command; returns the updated row if it was routed. */
  private async send(command: { id: string; deviceId: string; method: string; params: unknown; expiresAt: Date }) {
    const ttlMs = command.expiresAt.getTime() - Date.now();
    if (ttlMs <= 0) return null;
    const routed = await this.broker.publish(deviceTopics.downRequest(command.deviceId, command.method), command.params ?? {}, {
      correlationId: command.id,
      replyToRoutingKey: mqttTopicToRoutingKey(deviceTopics.upResponseTopic(command.deviceId)),
      ttlMs,
      properties: { "expires-at": command.expiresAt.toISOString() },
    });
    if (!routed) return null;
    const updated = await models.Command.where({ id: command.id, status: "queued" }).update({ status: "sent", sentAt: new Date() });
    if (updated) bus.emit("command.updated", { commandId: updated.id, deviceId: updated.deviceId, status: updated.status });
    return updated;
  }

  /** Sends commands that were queued while the device had no session. */
  async flushQueued(deviceId: string): Promise<void> {
    const queued = await models.Command.where({ deviceId, status: "queued" })
      .where((c) => c.expiresAt.gt(new Date()))
      .orderBy((c) => c.createdAt.asc())
      .limit(100)
      .all();
    for (const command of queued) await this.send(command);
  }

  /** Handles a device's `up/res` message. */
  async complete(deviceId: string, correlationId: string | undefined, payload: Buffer): Promise<void> {
    if (!correlationId || !UUID.test(correlationId)) {
      log.warn({ deviceId, correlationId }, "response without a valid correlation id");
      return;
    }
    let response;
    try {
      response = deviceResponseSchema.parse(JSON.parse(payload.toString("utf8")));
    } catch {
      response = { ok: false as const, error: "malformed response from device" };
    }
    const updated = await models.Command.where({ id: correlationId, deviceId })
      .where((c) => c.status.in(["queued", "sent"]))
      .update({
        status: response.ok ? "succeeded" : "failed",
        result: response.result === undefined ? null : toJson(response.result),
        error: response.ok ? null : response.error,
        completedAt: new Date(),
      });
    if (updated) bus.emit("command.updated", { commandId: updated.id, deviceId, status: updated.status });
  }

  async expireOverdue(): Promise<number> {
    const expired = await models.Command.where((c) => c.status.in(["queued", "sent"]))
      .where((c) => c.expiresAt.lte(new Date()))
      .select("id", "deviceId", "status")
      .updateAll({ status: "expired", completedAt: new Date() });
    for (const c of expired) bus.emit("command.updated", { commandId: c.id, deviceId: c.deviceId, status: c.status });
    return expired.length;
  }

  /** Waits until the command leaves queued/sent, up to `timeoutMs`. */
  async waitForCompletion(commandId: string, timeoutMs: number, signal?: AbortSignal) {
    const stop = new AbortController();
    signal?.addEventListener("abort", () => stop.abort());
    const finished = bus.waitFor("command.updated", (e) => e.commandId === commandId && e.status !== "sent", timeoutMs, stop.signal);
    // The response may have landed before we subscribed.
    const current = await models.Command.where({ id: commandId }).first();
    if (!current || (current.status !== "queued" && current.status !== "sent")) {
      stop.abort();
      return current;
    }
    await finished;
    return models.Command.where({ id: commandId }).first();
  }
}
