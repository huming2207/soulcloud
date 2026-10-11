import "dotenv/config";
import { z } from "zod";

const roles = ["api", "ingest", "sweeper"] as const;
export type Role = (typeof roles)[number];

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  SOULCLOUD_ROLES: z
    .string()
    .default("api,ingest,sweeper")
    .transform((s) => s.split(",").map((r) => r.trim()).filter(Boolean))
    .pipe(z.array(z.enum(roles)).min(1)),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DATABASE_URL: z.string().min(1),

  AMQP_HOST: z.string().default("127.0.0.1"),
  AMQP_PORT: z.coerce.number().int().default(5672),
  AMQP_USER: z.string().min(1),
  AMQP_PASSWORD: z.string().min(1),
  AMQP_VHOST: z.string().default("soulcloud"),
  RABBITMQ_MANAGEMENT_URL: z.url().default("http://127.0.0.1:15672"),

  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().default(8080),
  PUBLIC_BASE_URL: z.url().transform((u) => u.replace(/\/+$/, "")),
  DEVICE_MQTT_URL: z.url(),

  BROKER_AUTH_HOST: z.string().default("0.0.0.0"),
  BROKER_AUTH_PORT: z.coerce.number().int().default(8081),
  BROKER_AUTH_SECRET: z.string().min(8),

  DEVICE_PASSWORD_PEPPER: z.string().min(32),
  DOWNLOAD_SIGNING_SECRET: z.string().min(32),

  DATA_DIR: z.string().default("./data"),

  ALLOW_REGISTRATION: bool.default(true),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(720),

  LOG_RETENTION_DAYS: z.coerce.number().positive().default(30),
  HEARTBEAT_RETENTION_DAYS: z.coerce.number().positive().default(30),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}

export const config = loadConfig();
