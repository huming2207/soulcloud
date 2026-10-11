import { createRoute, z } from "@hono/zod-openapi";
import { config } from "../../config.ts";
import { models } from "../../db.ts";
import { createEnrollmentToken, enrollDevice } from "../../devices/enrollment.ts";
import { notFound, errors } from "../../http/errors.ts";
import { rateLimit } from "../rate-limit.ts";
import { UuidParam } from "../schemas.ts";
import type { ApiDeps } from "../deps.ts";
import type { App } from "../types.ts";

const EnrollmentSchema = z
  .object({
    id: z.uuid(),
    deviceName: z.string().nullable(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    usedAt: z.iso.datetime().nullable(),
    deviceId: z.string().nullable().openapi({ description: "The device created when the token was redeemed" }),
  })
  .openapi("Enrollment");

const NewEnrollmentSchema = EnrollmentSchema.extend({
  token: z.string().openapi({ example: "K7QD-M3XA-9PZT-4HNC", description: "Shown once. Hand it to the device during provisioning." }),
}).openapi("NewEnrollment");

const DeviceEnrollRequest = z
  .object({
    token: z.string().min(16).max(32),
    hardwareId: z.string().min(1).max(128).openapi({ description: "Stable hardware identity, e.g. the base MAC address", example: "24:6f:28:aa:bb:cc" }),
    platform: z.string().min(1).max(32).openapi({ example: "esp32" }),
    chip: z.string().max(32).optional().openapi({ example: "esp32s3" }),
    name: z.string().max(100).optional(),
    fwVersion: z.string().max(64).optional(),
  })
  .openapi("DeviceEnrollRequest");

const DeviceEnrollResponse = z
  .object({
    deviceId: z.string().openapi({ example: "7KQ2M-XH9PA" }),
    name: z.string(),
    mqtt: z.object({
      url: z.string().openapi({ example: "wss://iot.example.com/ws", description: "MQTT 5 over WebSocket" }),
      username: z.string(),
      password: z.string().openapi({ description: "Shown once; store it in NVS" }),
      clientId: z.string().openapi({ description: "Must equal the username" }),
      protocolVersion: z.literal(5),
    }),
    topics: z.object({
      prefix: z.string().openapi({ example: "d/7KQ2M-XH9PA/" }),
      publish: z.string().openapi({ example: "d/7KQ2M-XH9PA/up/#" }),
      subscribe: z.string().openapi({ example: "d/7KQ2M-XH9PA/down/#" }),
    }),
  })
  .openapi("DeviceEnrollResponse");

function enrollmentDto(e: { id: string; deviceName: string | null; createdAt: Date; expiresAt: Date; usedAt: Date | null; deviceId: string | null }) {
  return {
    id: e.id,
    deviceName: e.deviceName,
    createdAt: e.createdAt.toISOString(),
    expiresAt: e.expiresAt.toISOString(),
    usedAt: e.usedAt?.toISOString() ?? null,
    deviceId: e.deviceId,
  };
}

export function enrollmentRoutes(app: App, deps: ApiDeps) {
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/enrollments",
      tags: ["enrollment"],
      summary: "Create a single-use pairing token for a new device",
      security: [{ bearer: [] }],
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                deviceName: z.string().max(100).optional(),
                ttlMinutes: z.number().int().min(1).max(1440).default(10),
              }),
            },
          },
        },
      },
      responses: { 201: { content: { "application/json": { schema: NewEnrollmentSchema } }, description: "Token created" }, ...errors },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const { row, token } = await createEnrollmentToken(c.get("user").id, body.deviceName ?? null, body.ttlMinutes ?? 10);
      return c.json({ ...enrollmentDto(row), token }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/enrollments",
      tags: ["enrollment"],
      summary: "Recent pairing tokens",
      security: [{ bearer: [] }],
      responses: { 200: { content: { "application/json": { schema: z.array(EnrollmentSchema) } }, description: "Tokens" }, ...errors },
    }),
    async (c) => {
      const rows = await models.EnrollmentToken.where({ ownerId: c.get("user").id })
        .orderBy((e) => e.createdAt.desc())
        .limit(50)
        .all();
      return c.json(rows.map(enrollmentDto), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/enrollments/{id}",
      tags: ["enrollment"],
      summary: "Cancel an unused pairing token",
      security: [{ bearer: [] }],
      request: { params: UuidParam },
      responses: { 204: { description: "Cancelled" }, ...errors },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const deleted = await models.EnrollmentToken.where({ id, ownerId: c.get("user").id, usedAt: null }).delete();
      if (!deleted) throw notFound("unused enrollment");
      return c.body(null, 204);
    },
  );

  // Public: called by the device itself.
  app.use("/v1/device/enroll", rateLimit(10, 60_000));
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/device/enroll",
      tags: ["device"],
      summary: "Redeem a pairing token (called by the device)",
      description: "Returns fresh MQTT credentials. Every enrollment yields a new device id and password.",
      request: { body: { content: { "application/json": { schema: DeviceEnrollRequest } }, required: true } },
      responses: { 201: { content: { "application/json": { schema: DeviceEnrollResponse } }, description: "Enrolled" }, ...errors },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const result = await enrollDevice(body, deps.management);
      const id = result.deviceId;
      return c.json(
        {
          deviceId: id,
          name: result.name,
          mqtt: { url: config.DEVICE_MQTT_URL, username: id, password: result.password, clientId: id, protocolVersion: 5 as const },
          topics: { prefix: `d/${id}/`, publish: `d/${id}/up/#`, subscribe: `d/${id}/down/#` },
        },
        201,
      );
    },
  );
}
