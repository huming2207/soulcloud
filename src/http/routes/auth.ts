import { createRoute, z } from "@hono/zod-openapi";
import { config } from "../../config.ts";
import { hashPassword, verifyPassword } from "../../crypto.ts";
import { models, sqlState } from "../../db.ts";
import { createSession } from "../auth.ts";
import { ApiError, conflictResponse, errors, forbidden } from "../errors.ts";
import { rateLimit } from "../rate-limit.ts";
import { UserSchema, userDto } from "../schemas.ts";
import type { App } from "../types.ts";

const SessionSchema = z
  .object({ token: z.string().openapi({ description: "Send as `Authorization: Bearer <token>`" }), expiresAt: z.iso.datetime(), user: UserSchema })
  .openapi("Session");

const Credentials = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  password: z.string().min(8).max(256),
});

const json = <T extends z.ZodType>(schema: T) => ({ content: { "application/json": { schema } }, required: true });

export function authRoutes(app: App) {
  const limiter = rateLimit(20, 60_000);
  app.use("/v1/auth/register", limiter);
  app.use("/v1/auth/login", limiter);

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/auth/register",
      tags: ["auth"],
      summary: "Create an account. The first account becomes an admin.",
      request: { body: json(Credentials.extend({ name: z.string().max(100).optional() })) },
      responses: { 201: { content: { "application/json": { schema: SessionSchema } }, description: "Signed in" }, ...errors, ...conflictResponse },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const anyUser = await models.User.select("id").first();
      if (anyUser && !config.ALLOW_REGISTRATION) throw forbidden("registration is closed");
      let user;
      try {
        user = await models.User.create({
          email: body.email,
          name: body.name ?? null,
          passwordHash: await hashPassword(body.password),
          role: anyUser ? "user" : "admin",
        });
      } catch (err) {
        if (sqlState(err) === "23505") throw new ApiError(409, "email_taken", "an account with this email exists");
        throw err;
      }
      const session = await createSession(user.id);
      return c.json({ token: session.token, expiresAt: session.expiresAt.toISOString(), user: userDto(user) }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/auth/login",
      tags: ["auth"],
      summary: "Sign in with email and password",
      request: { body: json(Credentials) },
      responses: { 200: { content: { "application/json": { schema: SessionSchema } }, description: "Signed in" }, ...errors },
    }),
    async (c) => {
      const { email, password } = c.req.valid("json");
      const user = await models.User.where({ email }).first();
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        throw new ApiError(401, "invalid_credentials", "wrong email or password");
      }
      const session = await createSession(user.id);
      return c.json({ token: session.token, expiresAt: session.expiresAt.toISOString(), user: userDto(user) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/auth/logout",
      tags: ["auth"],
      summary: "End the current session",
      security: [{ bearer: [] }],
      responses: { 204: { description: "Signed out" }, ...errors },
    }),
    async (c) => {
      await models.Session.where({ id: c.get("user").sessionId }).delete();
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/auth/me",
      tags: ["auth"],
      summary: "The signed-in user",
      security: [{ bearer: [] }],
      responses: { 200: { content: { "application/json": { schema: UserSchema } }, description: "Current user" }, ...errors },
    }),
    async (c) => {
      const user = await models.User.where({ id: c.get("user").id }).first();
      if (!user) throw new ApiError(401, "unauthorized", "session user no longer exists");
      return c.json(userDto(user), 200);
    },
  );
}
