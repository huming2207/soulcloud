import { createRoute, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { models } from "../../db.ts";
import { bus } from "../../events.ts";
import { LOG_LEVELS, levelFromName } from "../../logs/levels.ts";
import { FRAME_ON9LOG, slipFrame } from "../../logs/on9log/slip.ts";
import { ownedDevice } from "../auth.ts";
import { errors } from "../errors.ts";
import { DeviceIdParam, LogEntrySchema } from "../schemas.ts";
import type { ApiDeps } from "../deps.ts";
import type { App } from "../types.ts";

const KEEPALIVE_MS = 15_000;
const RAW_EXPORT_LIMIT = 100_000;

const LogFilter = z.object({
  level: z.enum(LOG_LEVELS).optional().openapi({ description: "Most verbose level to include, e.g. `warn` returns errors and warnings" }),
  kind: z.enum(["text", "bin"]).optional(),
  tag: z.string().max(64).optional().openapi({ description: "Exact tag (text logs and platform entries)" }),
});

const LogPage = z
  .object({
    items: z.array(LogEntrySchema),
    nextBefore: z.number().nullable().openapi({ description: "Pass as `before` for the next (older) page" }),
  })
  .openapi("LogPage");

export function logRoutes(app: App, deps: ApiDeps) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/devices/{id}/logs",
      tags: ["logs"],
      summary: "Device logs, newest first (or oldest first with `after`)",
      description: "Binary (on9log) entries are decoded with the ELF uploaded for the firmware the device was running.",
      security: [{ bearer: [] }],
      request: {
        params: DeviceIdParam,
        query: LogFilter.extend({
          limit: z.coerce.number().int().min(1).max(1000).default(200),
          before: z.coerce.number().int().optional().openapi({ description: "Only entries with a smaller id" }),
          after: z.coerce.number().int().optional().openapi({ description: "Only entries with a larger id, oldest first" }),
          from: z.iso.datetime().optional(),
          to: z.iso.datetime().optional(),
        }),
      },
      responses: { 200: { content: { "application/json": { schema: LogPage } }, description: "Logs" }, ...errors },
    }),
    async (c) => {
      const device = await ownedDevice(c.get("user"), c.req.valid("param").id);
      const q = c.req.valid("query");
      const max = q.level ? levelFromName(q.level) : undefined;
      let query = models.DeviceLog.where({ deviceId: device.id });
      if (max !== undefined) query = query.where((l) => l.level.lte(max));
      if (q.kind) query = query.where({ kind: q.kind });
      if (q.tag) query = query.where({ tag: q.tag });
      if (q.before !== undefined) query = query.where((l) => l.id.lt(q.before!));
      if (q.after !== undefined) query = query.where((l) => l.id.gt(q.after!));
      if (q.from) query = query.where((l) => l.receivedAt.gte(new Date(q.from!)));
      if (q.to) query = query.where((l) => l.receivedAt.lte(new Date(q.to!)));
      const rows = await query
        .orderBy((l) => (q.after !== undefined ? l.id.asc() : l.id.desc()))
        .limit(q.limit)
        .all();
      const items = await deps.logRenderer.render(rows);
      const last = rows[rows.length - 1];
      const nextBefore = q.after === undefined && rows.length === q.limit && last ? last.id : null;
      return c.json({ items, nextBefore }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/devices/{id}/logs/stream",
      tags: ["logs"],
      summary: "Live log tail (Server-Sent Events)",
      description: "Each `log` event carries one LogEntry as JSON. A comment line is sent every 15 s to keep proxies open.",
      security: [{ bearer: [] }],
      request: { params: DeviceIdParam, query: LogFilter },
      responses: { 200: { content: { "text/event-stream": { schema: z.string() } }, description: "Event stream" }, ...errors },
    }),
    (async (c: Parameters<Parameters<App["openapi"]>[1]>[0]) => {
      const device = await ownedDevice(c.get("user"), c.req.param("id")!);
      const filter = LogFilter.parse(c.req.query());
      const max = filter.level ? levelFromName(filter.level) : undefined;
      return streamSSE(c, async (stream) => {
        const pending: number[][] = [];
        let wake: (() => void) | null = null;
        const off = bus.on("device.logs", (e) => {
          if (e.deviceId !== device.id) return;
          pending.push(e.ids);
          wake?.();
        });
        stream.onAbort(() => {
          off();
          wake?.();
        });
        while (!stream.aborted) {
          const ids = pending.splice(0).flat();
          if (ids.length) {
            let query = models.DeviceLog.where((l) => l.id.in(ids));
            if (max !== undefined) query = query.where((l) => l.level.lte(max));
            if (filter.kind) query = query.where({ kind: filter.kind });
            if (filter.tag) query = query.where({ tag: filter.tag });
            const rows = await query.orderBy((l) => l.id.asc()).all();
            for (const entry of await deps.logRenderer.render(rows)) {
              await stream.writeSSE({ event: "log", id: String(entry.id), data: JSON.stringify(entry) });
            }
            continue;
          }
          // Sleep until new logs arrive or the keep-alive is due, whichever is first.
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, KEEPALIVE_MS);
            function done() {
              clearTimeout(timer);
              wake = null;
              resolve();
            }
            wake = done;
          });
          if (!pending.length && !stream.aborted) await stream.write(": keep-alive\n\n");
        }
        off();
      });
    }) as never,
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/devices/{id}/logs/raw",
      tags: ["logs"],
      summary: "Raw on9log stream for offline decoding",
      description:
        "Binary log packets as typed SLIP frames, the format the on9log host CLI replays: " +
        "`on9log --log-bin <file> --elf <firmware.elf>`.",
      security: [{ bearer: [] }],
      request: {
        params: DeviceIdParam,
        query: z.object({ from: z.iso.datetime().optional(), to: z.iso.datetime().optional() }),
      },
      responses: { 200: { content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } }, description: "Stream" }, ...errors },
    }),
    (async (c: Parameters<Parameters<App["openapi"]>[1]>[0]) => {
      const device = await ownedDevice(c.get("user"), c.req.param("id")!);
      const { from, to } = c.req.query();
      let query = models.DeviceLog.select("raw").where({ deviceId: device.id, kind: "bin" }).where((l) => l.raw.isNotNull());
      if (from) query = query.where((l) => l.receivedAt.gte(new Date(from)));
      if (to) query = query.where((l) => l.receivedAt.lte(new Date(to)));
      const rows = await query.orderBy((l) => l.id.asc()).limit(RAW_EXPORT_LIMIT).all();
      const body = Buffer.concat(rows.map((r) => slipFrame(FRAME_ON9LOG, r.raw!)));
      return c.body(body, 200, {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${device.id}.on9log"`,
      });
    }) as never,
  );
}
