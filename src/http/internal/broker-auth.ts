// Endpoints for rabbitmq_auth_backend_http. Every device connection, vhost
// access, resource access and topic access is decided here. The platform's own
// service account is handled by RabbitMQ's internal backend and never reaches
// this code (we deny it here so a wrong service password can't fall through).
//
// RabbitMQ sends application/x-www-form-urlencoded POST bodies and expects a
// 200 response whose body is `allow`, `allow <tags>` or `deny`.

import { Hono } from "hono";
import type { Config } from "../../config.ts";
import { safeEqual } from "../../crypto.ts";
import { deviceQueueAllowed, deviceTopicAllowed, TOPIC_EXCHANGE } from "../../broker/topics.ts";
import { isCanonicalDeviceId, verifyDevicePassword } from "../../devices/ids.ts";
import { models } from "../../db.ts";
import { log } from "../../log.ts";

type Form = Record<string, string>;

async function form(req: Request): Promise<Form> {
  const body = await req.formData();
  const out: Form = {};
  for (const [k, v] of body) if (typeof v === "string") out[k] = v;
  return out;
}

const allow = () => new Response("allow", { headers: { "content-type": "text/plain" } });
const deny = (reason?: string) =>
  new Response(reason ? `deny ${reason}` : "deny", { headers: { "content-type": "text/plain" } });

async function activeDevice(id: string) {
  if (!isCanonicalDeviceId(id)) return null;
  const device = await models.Device.select("id", "passwordHash", "status").where({ id }).first();
  return device?.status === "active" ? device : null;
}

export function brokerAuthApp(config: Config) {
  const app = new Hono();

  // Reject anything that doesn't carry the shared secret in the path.
  app.use("/broker/:secret/*", async (c, next) => {
    if (!safeEqual(c.req.param("secret"), config.BROKER_AUTH_SECRET)) return c.text("not found", 404);
    await next();
  });

  app.post("/broker/:secret/user", async (c) => {
    const f = await form(c.req.raw);
    const username = f.username ?? "";
    if (username === config.AMQP_USER) return deny();
    const device = await activeDevice(username);
    if (!device || !f.password || !verifyDevicePassword(f.password, device.passwordHash, config.DEVICE_PASSWORD_PEPPER)) {
      log.info({ username }, "broker auth: device login refused");
      return deny();
    }
    // MQTT client id must equal the username so one device can't take over another's session.
    if (f.client_id !== undefined && f.client_id !== username) {
      log.info({ username, clientId: f.client_id }, "broker auth: client id mismatch");
      return deny("client_id must equal username");
    }
    return allow();
  });

  app.post("/broker/:secret/vhost", async (c) => {
    const f = await form(c.req.raw);
    if (f.vhost !== config.AMQP_VHOST) return deny();
    return (await activeDevice(f.username ?? "")) ? allow() : deny();
  });

  app.post("/broker/:secret/resource", async (c) => {
    const f = await form(c.req.raw);
    const id = f.username ?? "";
    if (f.vhost !== config.AMQP_VHOST || !isCanonicalDeviceId(id)) return deny();
    if (f.resource === "exchange" && f.name === TOPIC_EXCHANGE && f.permission !== "configure") return allow();
    if (f.resource === "queue" && deviceQueueAllowed(id, f.name ?? "")) return allow();
    return deny();
  });

  app.post("/broker/:secret/topic", async (c) => {
    const f = await form(c.req.raw);
    const id = f.username ?? "";
    const permission = f.permission;
    if (
      f.vhost !== config.AMQP_VHOST ||
      f.name !== TOPIC_EXCHANGE ||
      (permission !== "read" && permission !== "write") ||
      !isCanonicalDeviceId(id)
    ) {
      return deny();
    }
    const ok = deviceTopicAllowed(id, permission, f.routing_key ?? "");
    if (!ok) log.info({ id, permission, routingKey: f.routing_key }, "broker auth: topic refused");
    return ok ? allow() : deny();
  });

  return app;
}
