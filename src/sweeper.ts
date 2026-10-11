// Periodic housekeeping: expire commands, apply retention, repair presence.

import type { BrokerManagement } from "./broker/management.ts";
import { config } from "./config.ts";
import { models } from "./db.ts";
import { reconcilePresence } from "./devices/reconcile.ts";
import { log } from "./log.ts";
import type { Commands } from "./rpc/commands.ts";

const DAY = 86_400_000;

function every(ms: number, name: string, task: () => Promise<unknown>): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await task();
    } catch (err) {
      log.error({ err, task: name }, "sweeper task failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, ms);
  void run();
  return () => clearInterval(timer);
}

export function startSweeper(commands: Commands, management: BrokerManagement): () => void {
  const stops = [
    every(15_000, "expire-commands", () => commands.expireOverdue()),
    every(5 * 60_000, "reconcile-presence", () => reconcilePresence(management)),
    every(60 * 60_000, "retention", async () => {
      const now = Date.now();
      const logCutoff = new Date(now - config.LOG_RETENTION_DAYS * DAY);
      const hbCutoff = new Date(now - config.HEARTBEAT_RETENTION_DAYS * DAY);
      const logs = await models.DeviceLog.where((l) => l.receivedAt.lt(logCutoff)).deleteAndCount();
      const heartbeats = await models.DeviceHeartbeat.where((h) => h.receivedAt.lt(hbCutoff)).deleteAndCount();
      const sessions = await models.Session.where((s) => s.expiresAt.lt(new Date(now))).deleteAndCount();
      const tokens = await models.EnrollmentToken.where({ usedAt: null })
        .where((e) => e.expiresAt.lt(new Date(now - DAY)))
        .deleteAndCount();
      if (logs || heartbeats || sessions || tokens) log.info({ logs, heartbeats, sessions, tokens }, "retention sweep");
    }),
  ];
  return () => stops.forEach((stop) => stop());
}
