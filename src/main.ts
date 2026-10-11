import { join } from "node:path";
import { Broker, INGEST_QUEUE, PRESENCE_QUEUE } from "./broker/amqp.ts";
import { BrokerManagement } from "./broker/management.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { handlePresence, presenceKey } from "./devices/presence.ts";
import { reconcilePresence } from "./devices/reconcile.ts";
import { bus } from "./events.ts";
import { FsBlobStore } from "./firmware/storage.ts";
import { createApiApp } from "./http/app.ts";
import { brokerAuthApp } from "./http/internal/broker-auth.ts";
import { createIngestHandler, ingestKey } from "./ingest.ts";
import { log } from "./log.ts";
import { LogRenderer } from "./logs/render.ts";
import { OtaService } from "./ota/service.ts";
import { Commands } from "./rpc/commands.ts";
import { DeviceApi } from "./rpc/device-api.ts";
import { isBun, serve, type RunningServer } from "./runtime/serve.ts";
import { startSweeper } from "./sweeper.ts";

const servers: RunningServer[] = [];
const stoppers: (() => Promise<void> | void)[] = [];

async function start() {
  const roles = new Set(config.SOULCLOUD_ROLES);
  log.info({ roles: [...roles], runtime: isBun ? "bun" : "node" }, "starting soulcloud");

  const broker = new Broker(config);
  await broker.connect();
  stoppers.push(() => broker.close());

  const management = new BrokerManagement(config);
  const blobs = new FsBlobStore(join(config.DATA_DIR, "blobs"));
  const commands = new Commands(broker);
  const deviceApi = new DeviceApi(broker);
  const ota = new OtaService(commands, deviceApi);
  const logRenderer = new LogRenderer(blobs);

  if (roles.has("ingest")) {
    await broker.declareTopology();
    ota.listen();
    bus.on("device.connected", ({ deviceId }) =>
      void commands.flushQueued(deviceId).catch((err) => log.error({ err, deviceId }, "flushing queued commands failed")),
    );
    await reconcilePresence(management).catch((err) => log.warn({ err }, "initial presence reconcile failed"));
    await broker.consume(PRESENCE_QUEUE, presenceKey, (msg) => handlePresence(msg, management));
    await broker.consume(INGEST_QUEUE, ingestKey, createIngestHandler(commands, deviceApi));
    log.info("ingest consuming");
  }

  if (roles.has("sweeper")) stoppers.push(startSweeper(commands, management));

  if (roles.has("api")) {
    // The broker-auth listener comes up first: devices can't connect without it.
    const internal = await serve(brokerAuthApp(config), config.BROKER_AUTH_HOST, config.BROKER_AUTH_PORT);
    servers.push(internal);
    const api = await serve(createApiApp({ broker, management, commands, ota, blobs, logRenderer }), config.API_HOST, config.API_PORT);
    servers.push(api);
    log.info({ api: api.port, brokerAuth: internal.port }, "http listening");
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
