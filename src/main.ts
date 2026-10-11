import { config } from "./config.ts";
import { db } from "./db.ts";
import { log } from "./log.ts";
import { brokerAuthApp } from "./http/internal/broker-auth.ts";
import { serve, type RunningServer, isBun } from "./runtime/serve.ts";

const servers: RunningServer[] = [];
const stoppers: (() => Promise<void> | void)[] = [];

async function start() {
  log.info({ roles: config.SOULCLOUD_ROLES, runtime: isBun ? "bun" : "node" }, "starting soulcloud");

  if (config.SOULCLOUD_ROLES.includes("api")) {
    const internal = await serve(brokerAuthApp(config), config.BROKER_AUTH_HOST, config.BROKER_AUTH_PORT);
    servers.push(internal);
    log.info({ port: internal.port }, "broker auth listening");
  }
}

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "shutting down");
  for (const s of servers) await s.close();
  for (const fn of stoppers.reverse()) await fn();
  await db.close();
  process.exit(0);
}

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

start().catch((err) => {
  log.fatal({ err }, "startup failed");
  process.exit(1);
});
