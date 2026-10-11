// Dispatches everything devices publish (queue soulcloud.device.up).

import { ZodError } from "zod";
import type { InboundMessage } from "./broker/amqp.ts";
import { parseUpRoutingKey } from "./broker/topics.ts";
import { getIngestDevice } from "./devices/cache.ts";
import { handleStatus } from "./devices/status.ts";
import { log } from "./log.ts";
import { ingestBinaryLog, ingestTextLog } from "./logs/ingest.ts";
import type { Commands } from "./rpc/commands.ts";
import type { DeviceApi } from "./rpc/device-api.ts";

/** Serialise per device so logs and responses keep their order. */
export function ingestKey(msg: InboundMessage): string {
  return msg.routingKey.split(".")[1] ?? "";
}

export function createIngestHandler(commands: Commands, deviceApi: DeviceApi) {
  return async (msg: InboundMessage): Promise<void> => {
    const up = parseUpRoutingKey(msg.routingKey);
    if (!up) {
      log.debug({ routingKey: msg.routingKey }, "ignoring message outside the topic scheme");
      return;
    }
    const device = await getIngestDevice(up.deviceId);
    if (!device || device.status !== "active") return;

    try {
      switch (up.kind) {
        case "status":
          return await handleStatus(device, msg.body);
        case "log":
          return up.format === "text" ? await ingestTextLog(device, msg.body) : await ingestBinaryLog(device, msg.body);
        case "res":
          return await commands.complete(device.id, msg.correlationId, msg.body);
        case "req":
          return await deviceApi.handleRequest(device, up.method, msg.correlationId, msg.body);
        case "evt":
          return await deviceApi.handleEvent(device, up.name, msg.body);
      }
    } catch (err) {
      // Bad device input is dropped; anything else (database, broker) is retried.
      if (err instanceof ZodError || err instanceof SyntaxError) {
        log.warn({ deviceId: device.id, routingKey: msg.routingKey, err: err.message }, "rejected malformed device message");
        return;
      }
      throw err;
    }
  };
}
