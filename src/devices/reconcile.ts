// Presence comes from broker connection events. If the platform was down when
// a device disconnected, that event is lost; reconciling against the broker's
// live connection list repairs the online flags.

import type { BrokerManagement } from "../broker/management.ts";
import { config } from "../config.ts";
import { models } from "../db.ts";
import { log } from "../log.ts";
import { isCanonicalDeviceId } from "./ids.ts";

export async function reconcilePresence(management: BrokerManagement): Promise<void> {
  const live = new Map<string, string>();
  for (const c of await management.listConnections(config.AMQP_VHOST)) {
    if (isCanonicalDeviceId(c.user)) live.set(c.user, c.name);
  }
  const online = await models.Device.select("id").where({ online: true }).all();
  let changed = 0;
  for (const d of online) {
    if (live.has(d.id)) continue;
    changed += await models.Device.where({ id: d.id, online: true }).updateAndCount({
      online: false,
      connectionName: null,
      lastDisconnectedAt: new Date(),
    });
  }
  for (const [id, name] of live) {
    changed += await models.Device.where({ id, status: "active", online: false }).updateAndCount({ online: true, connectionName: name });
  }
  if (changed) log.info({ changed }, "presence reconciled with broker");
}
