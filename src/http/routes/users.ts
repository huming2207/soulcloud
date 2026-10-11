import { createRoute, z } from "@hono/zod-openapi";
import { models } from "../../db.ts";
import { requireAdmin } from "../auth.ts";
import { badRequest, errors, notFound } from "../errors.ts";
import { UserSchema, UuidParam, userDto } from "../schemas.ts";
import type { App } from "../types.ts";

export function userRoutes(app: App) {
  app.use("/v1/users", requireAdmin);
  app.use("/v1/users/*", requireAdmin);

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/users",
      tags: ["users"],
      summary: "All accounts (admin)",
      security: [{ bearer: [] }],
      responses: { 200: { content: { "application/json": { schema: z.array(UserSchema) } }, description: "Users" }, ...errors },
    }),
    async (c) => c.json((await models.User.orderBy((u) => u.createdAt.asc()).all()).map(userDto), 200),
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/users/{id}",
      tags: ["users"],
      summary: "Change an account's role (admin)",
      security: [{ bearer: [] }],
      request: {
        params: UuidParam,
        body: { content: { "application/json": { schema: z.object({ role: z.enum(["user", "admin"]) }) } }, required: true },
      },
      responses: { 200: { content: { "application/json": { schema: UserSchema } }, description: "Updated" }, ...errors },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      if (id === c.get("user").id) throw badRequest("you can't change your own role");
      const user = await models.User.where({ id }).update({ role: c.req.valid("json").role });
      if (!user) throw notFound("user");
      return c.json(userDto(user), 200);
    },
  );
}
