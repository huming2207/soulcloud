import type { OpenAPIHono } from "@hono/zod-openapi";

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: "user" | "admin";
  sessionId: string;
}

export type AppEnv = { Variables: { user: SessionUser } };
export type App = OpenAPIHono<AppEnv>;
