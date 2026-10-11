// Device -> cloud traffic other than logs and status:
//  - requests on d/<id>/up/req/<method>, answered on d/<id>/down/res with the
//    request's correlation data;
//  - events on d/<id>/up/evt/<name>.
// Features register handlers here (e.g. OTA registers `ota.check` and `ota`).

import type { Broker } from "../broker/amqp.ts";
import { deviceTopics } from "../broker/topics.ts";
import type { IngestDevice } from "../devices/cache.ts";
import { log } from "../log.ts";

export type RequestHandler = (device: IngestDevice, params: unknown) => Promise<unknown>;
export type EventHandler = (device: IngestDevice, payload: unknown) => Promise<void>;

export class RequestError extends Error {}

export class DeviceApi {
  private readonly broker: Broker;
  private readonly requests = new Map<string, RequestHandler>();
  private readonly events = new Map<string, EventHandler>();

  constructor(broker: Broker) {
    this.broker = broker;
    this.onRequest("time", async () => ({ epochMs: Date.now() }));
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requests.set(method, handler);
  }

  onEvent(name: string, handler: EventHandler): void {
    this.events.set(name, handler);
  }

  async handleRequest(device: IngestDevice, method: string, correlationId: string | undefined, payload: Buffer) {
    let reply: { ok: true; result: unknown } | { ok: false; error: string };
    const handler = this.requests.get(method);
    if (!handler) {
      reply = { ok: false, error: `unknown method ${method}` };
    } else {
      try {
        const params = payload.length ? JSON.parse(payload.toString("utf8")) : {};
        reply = { ok: true, result: (await handler(device, params)) ?? null };
      } catch (err) {
        if (!(err instanceof RequestError || err instanceof SyntaxError)) throw err;
        reply = { ok: false, error: err.message };
      }
    }
    await this.broker.publish(deviceTopics.downResponse(device.id), reply, {
      correlationId,
      properties: { method },
      ttlMs: 60_000,
    });
  }

  async handleEvent(device: IngestDevice, name: string, payload: Buffer): Promise<void> {
    const handler = this.events.get(name);
    if (!handler) {
      log.debug({ deviceId: device.id, name }, "ignoring unknown device event");
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(payload.toString("utf8"));
    } catch {
      log.warn({ deviceId: device.id, name }, "device event is not JSON");
      return;
    }
    await handler(device, body);
  }
}
