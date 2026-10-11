import { createRoute, z } from "@hono/zod-openapi";
import { models } from "../../db.ts";
import { attachElf, deleteFirmware, uploadFirmware, verifyDownload } from "../../firmware/service.ts";
import { canAccess } from "../auth.ts";
import { ApiError, conflictResponse, errors, notFound } from "../errors.ts";
import { FirmwareSchema, UuidParam, firmwareDto } from "../schemas.ts";
import type { ApiDeps } from "../deps.ts";
import type { App, SessionUser } from "../types.ts";

const MAX_UPLOAD = 64 * 1024 * 1024;
const file = (description: string) => z.instanceof(File).openapi({ type: "string", format: "binary", description });

async function bytesOf(f: File | undefined): Promise<Uint8Array | null> {
  if (!f) return null;
  if (f.size > MAX_UPLOAD) throw new ApiError(413, "too_large", `files are limited to ${MAX_UPLOAD} bytes`);
  return new Uint8Array(await f.arrayBuffer());
}

async function ownedFirmware(user: SessionUser, id: string) {
  const fw = await models.Firmware.where({ id }).first();
  if (!fw || !canAccess(user, fw.ownerId)) throw notFound("firmware");
  return fw;
}

/** Parses a `Range: bytes=a-b` header against a file size. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start > end || start >= size ? "invalid" : { start, end };
}

export function firmwareRoutes(app: App, deps: ApiDeps) {
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/firmware",
      tags: ["firmware"],
      summary: "Upload a firmware image (and optionally its ELF)",
      description:
        "Version, chip and ELF hash are read from the image itself. The ELF is needed to decode " +
        "binary (on9log) logs and must be the one the image was built from.",
      security: [{ bearer: [] }],
      request: {
        body: {
          content: {
            "multipart/form-data": {
              schema: z.object({
                bin: file("Application image, e.g. build/<project>.bin"),
                elf: file("Matching ELF, e.g. build/<project>.elf").optional(),
                notes: z.string().max(2000).optional(),
              }),
            },
          },
          required: true,
        },
      },
      responses: { 201: { content: { "application/json": { schema: FirmwareSchema } }, description: "Uploaded" }, ...errors, ...conflictResponse },
    }),
    async (c) => {
      const form = c.req.valid("form");
      const bin = await bytesOf(form.bin);
      const fw = await uploadFirmware(deps.blobs, c.get("user").id, bin!, await bytesOf(form.elf), form.notes ?? null);
      return c.json(firmwareDto(fw), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/firmware",
      tags: ["firmware"],
      summary: "List firmware, newest first",
      security: [{ bearer: [] }],
      request: { query: z.object({ chip: z.string().optional(), project: z.string().optional() }) },
      responses: { 200: { content: { "application/json": { schema: z.array(FirmwareSchema) } }, description: "Firmware" }, ...errors },
    }),
    async (c) => {
      const user = c.get("user");
      const q = c.req.valid("query");
      let query = models.Firmware.orderBy((f) => f.createdAt.desc()).limit(500);
      if (user.role !== "admin") query = query.where({ ownerId: user.id });
      if (q.chip) query = query.where({ chip: q.chip });
      if (q.project) query = query.where({ projectName: q.project });
      return c.json((await query.all()).map(firmwareDto), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/firmware/{id}",
      tags: ["firmware"],
      summary: "One firmware",
      security: [{ bearer: [] }],
      request: { params: UuidParam },
      responses: { 200: { content: { "application/json": { schema: FirmwareSchema } }, description: "Firmware" }, ...errors },
    }),
    async (c) => c.json(firmwareDto(await ownedFirmware(c.get("user"), c.req.valid("param").id)), 200),
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/firmware/{id}/elf",
      tags: ["firmware"],
      summary: "Attach the ELF to an uploaded firmware",
      description: "Binary logs already received from this firmware become decodable.",
      security: [{ bearer: [] }],
      request: {
        params: UuidParam,
        body: { content: { "multipart/form-data": { schema: z.object({ elf: file("Matching ELF") }) } }, required: true },
      },
      responses: { 200: { content: { "application/json": { schema: FirmwareSchema } }, description: "Updated" }, ...errors },
    }),
    async (c) => {
      const fw = await ownedFirmware(c.get("user"), c.req.valid("param").id);
      const updated = await attachElf(deps.blobs, fw, (await bytesOf(c.req.valid("form").elf))!);
      deps.logRenderer.invalidate(fw.id);
      return c.json(firmwareDto(updated ?? fw), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/firmware/{id}",
      tags: ["firmware"],
      summary: "Delete firmware that no OTA job uses",
      security: [{ bearer: [] }],
      request: { params: UuidParam },
      responses: { 204: { description: "Deleted" }, ...errors, ...conflictResponse },
    }),
    async (c) => {
      const fw = await ownedFirmware(c.get("user"), c.req.valid("param").id);
      await deleteFirmware(deps.blobs, fw);
      deps.logRenderer.invalidate(fw.id);
      return c.body(null, 204);
    },
  );

  // Public, signed: the device downloads its update here (supports Range for resume).
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/device/firmware/{id}",
      tags: ["device"],
      summary: "Download a firmware image (signed URL from ota.start)",
      request: {
        params: UuidParam,
        query: z.object({ d: z.string(), exp: z.coerce.number().int(), sig: z.string() }),
      },
      responses: {
        200: { content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } }, description: "Image" },
        206: { content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } }, description: "Partial image" },
        ...errors,
      },
    }),
    (async (c: Parameters<Parameters<App["openapi"]>[1]>[0]) => {
      const id = c.req.param("id")!;
      const { d, exp, sig } = c.req.query();
      if (!d || !sig || !verifyDownload(id, d, Number(exp), sig)) {
        throw new ApiError(403, "bad_signature", "download link is invalid or expired");
      }
      const fw = await models.Firmware.select("binKey", "size", "binSha256").where({ id }).first();
      const size = fw ? await deps.blobs.size(fw.binKey) : null;
      if (!fw || size === null) throw notFound("firmware");

      const headers: Record<string, string> = {
        "content-type": "application/octet-stream",
        "accept-ranges": "bytes",
        etag: `"${fw.binSha256}"`,
      };
      const range = parseRange(c.req.header("range"), size);
      if (range === "invalid") return c.body(null, 416, { ...headers, "content-range": `bytes */${size}` });
      if (range) {
        const chunk = await deps.blobs.readRange(fw.binKey, range.start, range.end - range.start + 1);
        return c.body(Buffer.from(chunk), 206, { ...headers, "content-range": `bytes ${range.start}-${range.end}/${size}` });
      }
      const all = await deps.blobs.get(fw.binKey);
      return c.body(Buffer.from(all!), 200, headers);
    }) as never,
  );
}
