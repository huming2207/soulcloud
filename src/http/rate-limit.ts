import { createMiddleware } from "hono/factory";
import { ApiError } from "./errors.ts";

/** Fixed-window, in-memory rate limit per client IP (behind Traefik: X-Forwarded-For). */
export function rateLimit(limit: number, windowMs: number) {
  const hits = new Map<string, { start: number; count: number }>();
  return createMiddleware(async (c, next) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "local";
    const now = Date.now();
    const entry = hits.get(ip);
    if (!entry || now - entry.start >= windowMs) {
      hits.set(ip, { start: now, count: 1 });
      if (hits.size > 10_000) for (const [k, v] of hits) if (now - v.start >= windowMs) hits.delete(k);
    } else if (++entry.count > limit) {
      throw new ApiError(429, "rate_limited", "too many requests, slow down");
    }
    await next();
  });
}
