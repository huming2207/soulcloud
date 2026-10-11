// Cloud -> device request methods. Each method validates its params before
// anything is sent; methods the device firmware doesn't know simply fail there.
// Anything outside this list can still be sent as a custom method.

import { z } from "zod";
import { LOG_LEVELS } from "../logs/levels.ts";

export interface MethodSpec {
  description: string;
  params: z.ZodType;
  /** Issued by the platform itself (e.g. OTA), not through the commands API. */
  internal?: boolean;
  defaultTtlSec: number;
}

const level = z.enum(LOG_LEVELS);

export const methods: Record<string, MethodSpec> = {
  shell: {
    description: "Run one debug shell line on the device. Result: { code, output }.",
    params: z.object({ line: z.string().min(1).max(512) }),
    defaultTtlSec: 60,
  },
  reboot: {
    description: "Restart the device after an optional delay.",
    params: z.object({ delayMs: z.number().int().min(0).max(60_000).optional() }),
    defaultTtlSec: 300,
  },
  info: {
    description: "Report app description, ELF hash, partitions and heap.",
    params: z.object({}),
    defaultTtlSec: 60,
  },
  "log.config": {
    description: "Change log levels and which log uplinks (text, bin) are enabled.",
    params: z.object({
      level: level.optional(),
      tags: z.record(z.string().max(64), level).optional(),
      text: z.boolean().optional(),
      bin: z.boolean().optional(),
    }),
    defaultTtlSec: 300,
  },
  "ota.start": {
    description: "Download and install firmware from a signed URL.",
    params: z.object({
      url: z.url(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      size: z.number().int().positive(),
      version: z.string(),
      taskId: z.uuid(),
    }),
    internal: true,
    defaultTtlSec: 3600,
  },
  "ota.cancel": {
    description: "Abort an OTA download in progress.",
    params: z.object({ taskId: z.uuid() }),
    internal: true,
    defaultTtlSec: 300,
  },
};

export const METHOD_NAME = /^[a-z][a-z0-9_-]{0,31}(\.[a-z][a-z0-9_-]{0,31}){0,3}$/;
const customParams = z.record(z.string(), z.unknown());

export type ParamsCheck = { ok: true; params: Record<string, unknown>; ttlSec: number } | { ok: false; error: string };

/** Validates params for a public command request. */
export function checkCommand(method: string, params: unknown, allowInternal = false): ParamsCheck {
  if (!METHOD_NAME.test(method)) return { ok: false, error: "invalid method name" };
  const spec = methods[method];
  if (spec?.internal && !allowInternal) return { ok: false, error: `method ${method} is managed by the platform` };
  const parsed = (spec?.params ?? customParams).safeParse(params ?? {});
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  return { ok: true, params: parsed.data as Record<string, unknown>, ttlSec: spec?.defaultTtlSec ?? 120 };
}

/** What devices publish on `up/res` (with the request's correlation data). */
export const deviceResponseSchema = z.union([
  z.object({ ok: z.literal(true), result: z.unknown().optional() }),
  z.object({ ok: z.literal(false), error: z.string().max(2000), result: z.unknown().optional() }),
]);
