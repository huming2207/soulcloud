import { z } from "@hono/zod-openapi";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: ContentfulStatusCode, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found`);
export const forbidden = (message = "forbidden") => new ApiError(403, "forbidden", message);
export const badRequest = (message: string, details?: unknown) => new ApiError(400, "bad_request", message, details);
export const conflict = (message: string) => new ApiError(409, "conflict", message);

export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: "not_found" }),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .openapi("Error");

export function errorBody(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details !== undefined && { details }) } };
}

const errorContent = { "application/json": { schema: ErrorSchema } };

/** Common error responses to spread into a route's `responses`. */
export const errors = {
  400: { content: errorContent, description: "Invalid request" },
  401: { content: errorContent, description: "Not signed in" },
  403: { content: errorContent, description: "Not allowed" },
  404: { content: errorContent, description: "Not found" },
} as const;

export const conflictResponse = { 409: { content: errorContent, description: "Conflict" } } as const;
