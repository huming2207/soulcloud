import { createRoute, z } from "@hono/zod-openapi";
import { models } from "../../db.ts";
import { checkCommand, methods } from "../../rpc/methods.ts";
import { ownedDevice } from "../auth.ts";
import { ApiError, badRequest, errors, notFound } from "../errors.ts";
import { CommandSchema, DeviceIdParam, commandDto } from "../schemas.ts";
import type { ApiDeps } from "../deps.ts";
import type { App } from "../types.ts";

const MAX_WAIT_SEC = 60;
const waitQuery = z.object({
  wait: z.coerce
    .number()
    .int()
    .min(0)
    .max(MAX_WAIT_SEC)
    .default(0)
    .openapi({ description: "Seconds to wait for the device's response before returning" }),
});

const MethodSchema = z.object({ name: z.string(), description: z.string() }).openapi("Method");

const ShellResultSchema = z
  .object({
    command: CommandSchema,
    code: z.number().nullable().openapi({ description: "Exit code reported by the device" }),
    output: z.string().nullable(),
  })
  .openapi("ShellResult");

export function commandRoutes(app: App, deps: ApiDeps) {
  async function activeDevice(c: Parameters<Parameters<App["openapi"]>[1]>[0], id: string) {
    const device = await ownedDevice(c.get("user"), id);
    if (device.status !== "active") throw new ApiError(409, "device_inactive", "device is not paired any more");
    return device;
  }

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/methods",
      tags: ["commands"],
      summary: "Built-in device methods",
      description: "Other method names are sent to the device as-is with free-form params.",
      security: [{ bearer: [] }],
      responses: { 200: { content: { "application/json": { schema: z.array(MethodSchema) } }, description: "Methods" }, ...errors },
    }),
    (c) =>
      c.json(
        Object.entries(methods)
          .filter(([, m]) => !m.internal)
          .map(([name, m]) => ({ name, description: m.description })),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/devices/{id}/commands",
      tags: ["commands"],
      summary: "Send a request to a device (MQTT 5 request/response)",
      description:
        "The command is delivered when the device is (or next comes) online, until it expires. " +
        "With `wait`, the call returns as soon as the device answers or the wait elapses.",
      security: [{ bearer: [] }],
      request: {
        params: DeviceIdParam,
        query: waitQuery,
        body: {
          content: {
            "application/json": {
              schema: z.object({
                method: z.string().openapi({ example: "shell" }),
                params: z.record(z.string(), z.unknown()).optional().openapi({ example: { line: "get free_heap internal" } }),
                ttlSec: z.number().int().min(5).max(86_400).optional(),
              }),
            },
          },
          required: true,
        },
      },
      responses: { 201: { content: { "application/json": { schema: CommandSchema } }, description: "Command" }, ...errors },
    }),
    async (c) => {
      const device = await activeDevice(c, c.req.valid("param").id);
      const body = c.req.valid("json");
      const check = checkCommand(body.method, body.params);
      if (!check.ok) throw badRequest(check.error);
      let command = await deps.commands.create({
        deviceId: device.id,
        method: body.method,
        params: check.params,
        ttlSec: body.ttlSec ?? check.ttlSec,
        requestedById: c.get("user").id,
      });
      const { wait } = c.req.valid("query");
      if (wait) command = (await deps.commands.waitForCompletion(command.id, wait * 1000, c.req.raw.signal)) ?? command;
      return c.json(commandDto(command), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/devices/{id}/shell",
      tags: ["commands"],
      summary: "Run a debug shell line and wait for its output",
      security: [{ bearer: [] }],
      request: {
        params: DeviceIdParam,
        body: {
          content: {
            "application/json": {
              schema: z.object({
                line: z.string().min(1).max(512).openapi({ example: "get free_heap internal" }),
                timeoutSec: z.number().int().min(1).max(MAX_WAIT_SEC).default(15),
              }),
            },
          },
          required: true,
        },
      },
      responses: { 200: { content: { "application/json": { schema: ShellResultSchema } }, description: "Result (output is null if the device didn't answer in time)" }, ...errors },
    }),
    async (c) => {
      const device = await activeDevice(c, c.req.valid("param").id);
      const { line, timeoutSec = 15 } = c.req.valid("json");
      const created = await deps.commands.create({
        deviceId: device.id,
        method: "shell",
        params: { line },
        ttlSec: timeoutSec,
        requestedById: c.get("user").id,
      });
      const command = (await deps.commands.waitForCompletion(created.id, timeoutSec * 1000, c.req.raw.signal)) ?? created;
      const result = (command.result ?? {}) as { code?: unknown; output?: unknown };
      return c.json(
        {
          command: commandDto(command),
          code: typeof result.code === "number" ? result.code : null,
          output: typeof result.output === "string" ? result.output : null,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/devices/{id}/commands",
      tags: ["commands"],
      summary: "Command history, newest first",
      security: [{ bearer: [] }],
      request: {
        params: DeviceIdParam,
        query: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          before: z.uuid().optional().openapi({ description: "Return commands older than this command id" }),
        }),
      },
      responses: { 200: { content: { "application/json": { schema: z.array(CommandSchema) } }, description: "Commands" }, ...errors },
    }),
    async (c) => {
      const device = await ownedDevice(c.get("user"), c.req.valid("param").id);
      const q = c.req.valid("query");
      // uuid v7 ids sort by creation time.
      let query = models.Command.where({ deviceId: device.id }).orderBy((x) => x.id.desc()).limit(q.limit);
      if (q.before) {
        const before = q.before;
        query = query.where((x) => x.id.lt(before));
      }
      return c.json((await query.all()).map(commandDto), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/devices/{id}/commands/{commandId}",
      tags: ["commands"],
      summary: "One command; with `wait`, long-poll until it completes",
      security: [{ bearer: [] }],
      request: {
        params: DeviceIdParam.extend({ commandId: z.uuid().openapi({ param: { name: "commandId", in: "path" } }) }),
        query: waitQuery,
      },
      responses: { 200: { content: { "application/json": { schema: CommandSchema } }, description: "Command" }, ...errors },
    }),
    async (c) => {
      const { id, commandId } = c.req.valid("param");
      const device = await ownedDevice(c.get("user"), id);
      let command = await models.Command.where({ id: commandId, deviceId: device.id }).first();
      if (!command) throw notFound("command");
      const { wait } = c.req.valid("query");
      if (wait && (command.status === "queued" || command.status === "sent")) {
        command = (await deps.commands.waitForCompletion(command.id, wait * 1000, c.req.raw.signal)) ?? command;
      }
      return c.json(commandDto(command), 200);
    },
  );
}
