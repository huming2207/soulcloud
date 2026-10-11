import { createRoute, z } from "@hono/zod-openapi";
import { models } from "../../db.ts";
import { revokeDevice } from "../../devices/enrollment.ts";
import { ownedDevice } from "../auth.ts";
import { errors } from "../errors.ts";
import { DeviceIdParam, DeviceSchema, HeartbeatSchema, deviceDto, heartbeatDto } from "../schemas.ts";
import type { ApiDeps } from "../deps.ts";
import type { App } from "../types.ts";

const ListQuery = z.object({
  status: z.enum(["active", "revoked", "superseded", "all"]).default("active"),
  online: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export function deviceRoutes(app: App, deps: ApiDeps) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/devices",
      tags: ["devices"],
      summary: "List your devices (admins see all)",
      security: [{ bearer: [] }],
      request: { query: ListQuery },
      responses: { 200: { content: { "application/json": { schema: z.array(DeviceSchema) } }, description: "Devices" }, ...errors },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const user = c.get("user");
      let query = models.Device.orderBy([(d) => d.createdAt.desc(), (d) => d.id.asc()]).limit(q.limit).offset(q.offset);
      if (user.role !== "admin") query = query.where({ ownerId: user.id });
      if (q.status !== "all") query = query.where({ status: q.status });
      if (q.online) query = query.where({ online: q.online === "true" });
      return c.json((await query.all()).map(deviceDto), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/devices/{id}",
      tags: ["devices"],
      summary: "Device details, status and health",
      security: [{ bearer: [] }],
      request: { params: DeviceIdParam },
      responses: { 200: { content: { "application/json": { schema: DeviceSchema } }, description: "Device" }, ...errors },
    }),
    async (c) => c.json(deviceDto(await ownedDevice(c.get("user"), c.req.valid("param").id)), 200),
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/devices/{id}",
      tags: ["devices"],
      summary: "Rename a device",
      security: [{ bearer: [] }],
      request: {
        params: DeviceIdParam,
        body: { content: { "application/json": { schema: z.object({ name: z.string().min(1).max(100) }) } }, required: true },
      },
      responses: { 200: { content: { "application/json": { schema: DeviceSchema } }, description: "Updated" }, ...errors },
    }),
    async (c) => {
      const device = await ownedDevice(c.get("user"), c.req.valid("param").id);
      const updated = await models.Device.where({ id: device.id }).update({ name: c.req.valid("json").name });
      return c.json(deviceDto(updated ?? device), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/devices/{id}",
      tags: ["devices"],
      summary: "Unpair a device",
      description: "Its credentials stop working immediately and its connection is closed. History is kept.",
      security: [{ bearer: [] }],
      request: { params: DeviceIdParam },
      responses: { 204: { description: "Unpaired" }, ...errors },
    }),
    async (c) => {
      const device = await ownedDevice(c.get("user"), c.req.valid("param").id);
      await revokeDevice(device.id, deps.management);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/devices/{id}/heartbeats",
      tags: ["devices"],
      summary: "Recent heartbeats (uptime and health history), newest first",
      security: [{ bearer: [] }],
      request: {
        params: DeviceIdParam,
        query: z.object({
          limit: z.coerce.number().int().min(1).max(1000).default(100),
          since: z.iso.datetime().optional(),
        }),
      },
      responses: { 200: { content: { "application/json": { schema: z.array(HeartbeatSchema) } }, description: "Heartbeats" }, ...errors },
    }),
    async (c) => {
      const device = await ownedDevice(c.get("user"), c.req.valid("param").id);
      const q = c.req.valid("query");
      let query = models.DeviceHeartbeat.where({ deviceId: device.id }).orderBy((h) => h.id.desc()).limit(q.limit);
      if (q.since) {
        const since = new Date(q.since);
        query = query.where((h) => h.receivedAt.gte(since));
      }
      return c.json((await query.all()).map(heartbeatDto), 200);
    },
  );
}
