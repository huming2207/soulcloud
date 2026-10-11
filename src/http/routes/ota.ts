import { createRoute, z } from "@hono/zod-openapi";
import { models } from "../../db.ts";
import { canAccess, ownedDevice } from "../auth.ts";
import { errors, notFound } from "../errors.ts";
import { DeviceIdParam, OtaJobSchema, OtaTaskSchema, UuidParam, otaTaskDto } from "../schemas.ts";
import type { ApiDeps } from "../deps.ts";
import type { App, SessionUser } from "../types.ts";

async function jobWithTasks(user: SessionUser, id: string) {
  const job = await models.OtaJob.where({ id }).first();
  if (!job || !canAccess(user, job.ownerId)) throw notFound("OTA job");
  const tasks = await models.OtaTask.where({ jobId: job.id }).orderBy((t) => t.deviceId.asc()).all();
  return {
    id: job.id,
    ownerId: job.ownerId,
    firmwareId: job.firmwareId,
    note: job.note,
    createdAt: job.createdAt.toISOString(),
    tasks: tasks.map(otaTaskDto),
  };
}

export function otaRoutes(app: App, deps: ApiDeps) {
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/ota-jobs",
      tags: ["ota"],
      summary: "Roll firmware out to devices",
      description: "Online devices start right away; offline ones start when they next connect or ask (ota.check).",
      security: [{ bearer: [] }],
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                firmwareId: z.uuid(),
                deviceIds: z.array(z.string()).min(1).max(1000),
                note: z.string().max(500).optional(),
              }),
            },
          },
          required: true,
        },
      },
      responses: { 201: { content: { "application/json": { schema: OtaJobSchema } }, description: "Job created" }, ...errors },
    }),
    async (c) => {
      const user = c.get("user");
      const body = c.req.valid("json");
      const { job } = await deps.ota.createJob(user.id, body.firmwareId, body.deviceIds, body.note ?? null, user.role === "admin");
      return c.json(await jobWithTasks(user, job.id), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/ota-jobs",
      tags: ["ota"],
      summary: "OTA jobs, newest first",
      security: [{ bearer: [] }],
      responses: { 200: { content: { "application/json": { schema: z.array(OtaJobSchema) } }, description: "Jobs" }, ...errors },
    }),
    async (c) => {
      const user = c.get("user");
      let query = models.OtaJob.orderBy((j) => j.createdAt.desc()).limit(100);
      if (user.role !== "admin") query = query.where({ ownerId: user.id });
      const jobs = await query.all();
      return c.json(await Promise.all(jobs.map((j) => jobWithTasks(user, j.id))), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/ota-jobs/{id}",
      tags: ["ota"],
      summary: "One OTA job with per-device progress",
      security: [{ bearer: [] }],
      request: { params: UuidParam },
      responses: { 200: { content: { "application/json": { schema: OtaJobSchema } }, description: "Job" }, ...errors },
    }),
    async (c) => c.json(await jobWithTasks(c.get("user"), c.req.valid("param").id), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/ota-jobs/{id}/cancel",
      tags: ["ota"],
      summary: "Cancel the job's unfinished tasks",
      description: "Devices already verifying or rebooting into the new image are left to finish.",
      security: [{ bearer: [] }],
      request: { params: UuidParam },
      responses: { 200: { content: { "application/json": { schema: OtaJobSchema } }, description: "Job" }, ...errors },
    }),
    async (c) => {
      const user = c.get("user");
      const { id } = c.req.valid("param");
      await jobWithTasks(user, id); // access check
      await deps.ota.cancelJob(id);
      return c.json(await jobWithTasks(user, id), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/devices/{id}/ota-tasks",
      tags: ["ota"],
      summary: "A device's OTA history, newest first",
      security: [{ bearer: [] }],
      request: { params: DeviceIdParam },
      responses: { 200: { content: { "application/json": { schema: z.array(OtaTaskSchema) } }, description: "Tasks" }, ...errors },
    }),
    async (c) => {
      const device = await ownedDevice(c.get("user"), c.req.valid("param").id);
      const tasks = await models.OtaTask.where({ deviceId: device.id }).orderBy((t) => t.createdAt.desc()).limit(100).all();
      return c.json(tasks.map(otaTaskDto), 200);
    },
  );
}
