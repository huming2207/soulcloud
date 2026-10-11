import { OpenAPIHono, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { log } from "../log.ts";
import { requireUser } from "./auth.ts";
import type { ApiDeps } from "./deps.ts";
import { ApiError, errorBody } from "./errors.ts";
import { authRoutes } from "./routes/auth.ts";
import { commandRoutes } from "./routes/commands.ts";
import { deviceRoutes } from "./routes/devices.ts";
import { enrollmentRoutes } from "./routes/enrollments.ts";
import { firmwareRoutes } from "./routes/firmware.ts";
import { logRoutes } from "./routes/logs.ts";
import { otaRoutes } from "./routes/ota.ts";
import { userRoutes } from "./routes/users.ts";
import type { AppEnv } from "./types.ts";

/** Routes reachable without a user session. */
const PUBLIC = [/^\/v1\/auth\/(register|login)$/, /^\/v1\/device\//];

export function createApiApp(deps: ApiDeps) {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(errorBody("validation_failed", "request validation failed", z.treeifyError(result.error)), 400);
      }
    },
  });

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(errorBody(err.code, err.message, err.details), err.status);
    if (err instanceof HTTPException) return c.json(errorBody("http_error", err.message), err.status);
    log.error({ err, path: c.req.path }, "unhandled API error");
    return c.json(errorBody("internal", "internal server error"), 500);
  });
  app.notFound((c) => c.json(errorBody("not_found", "no such endpoint"), 404));

  app.use("/v1/*", async (c, next) => {
    if (PUBLIC.some((re) => re.test(c.req.path))) return next();
    return requireUser(c, next);
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  authRoutes(app);
  enrollmentRoutes(app, deps);
  deviceRoutes(app, deps);
  commandRoutes(app, deps);
  logRoutes(app, deps);
  firmwareRoutes(app, deps);
  otaRoutes(app, deps);
  userRoutes(app);

  app.openAPIRegistry.registerComponent("securitySchemes", "bearer", { type: "http", scheme: "bearer" });
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "SoulCloud API",
      version: "0.1.0",
      description:
        "Device management for MQTT 5 devices. Human users authenticate with a bearer session token " +
        "(POST /v1/auth/login). Device-facing endpoints are under /v1/device/.",
    },
  });

  return app;
}
