// Bearer session tokens for human users. Tokens are random and stored as SHA-256.

import { createMiddleware } from "hono/factory";
import { config } from "../config.ts";
import { randomToken, sha256Hex } from "../crypto.ts";
import { models } from "../db.ts";
import { ApiError, forbidden, notFound } from "./errors.ts";
import type { AppEnv, SessionUser } from "./types.ts";

const TOUCH_INTERVAL_MS = 5 * 60_000;

export async function createSession(userId: string) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 3600_000);
  await models.Session.create({ userId, tokenHash: sha256Hex(token), expiresAt });
  return { token, expiresAt };
}

export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new ApiError(401, "unauthorized", "missing bearer token");

  const session = await models.Session.where({ tokenHash: sha256Hex(token) }).first();
  if (!session || session.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(401, "unauthorized", "invalid or expired session");
  }
  const user = await models.User.select("id", "email", "name", "role").where({ id: session.userId }).first();
  if (!user) throw new ApiError(401, "unauthorized", "invalid or expired session");

  if (Date.now() - session.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
    await models.Session.where({ id: session.id }).update({ lastUsedAt: new Date() });
  }
  c.set("user", { ...user, sessionId: session.id } as SessionUser);
  await next();
});

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("user").role !== "admin") throw forbidden("admin only");
  await next();
});

/** Loads a device the user may act on (owner, or any device for admins). */
export async function ownedDevice(user: SessionUser, id: string) {
  const device = await models.Device.where({ id }).first();
  if (!device || (device.ownerId !== user.id && user.role !== "admin")) throw notFound("device");
  return device;
}

export function canAccess(user: SessionUser, ownerId: string): boolean {
  return user.role === "admin" || ownerId === user.id;
}
