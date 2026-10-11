// Device online/offline from RabbitMQ's event exchange (connection.created /
// connection.closed). The broker reports every connection, so this works even
// when a device dies without a clean disconnect.

import type { InboundMessage } from "../broker/amqp.ts";
import type { BrokerManagement } from "../broker/management.ts";
import { models } from "../db.ts";
import { bus } from "../events.ts";
import { log } from "../log.ts";
import { isCanonicalDeviceId } from "./ids.ts";
import { invalidateDevice } from "./cache.ts";

export function presenceKey(msg: InboundMessage): string {
  return String(msg.annotations["x-opt-user"] ?? "");
}

export async function handlePresence(msg: InboundMessage, management: BrokerManagement): Promise<void> {
  const user = String(msg.annotations["x-opt-user"] ?? "");
  const name = String(msg.annotations["x-opt-name"] ?? "");
  const protocol = String(msg.annotations["x-opt-protocol"] ?? "");
  if (!isCanonicalDeviceId(user) || !protocol.includes("MQTT")) return;

  if (msg.routingKey === "connection.created") {
    const connectedAt = Number(msg.annotations["x-opt-connected-at"]) || Date.now();
    const device = await models.Device.select("id", "status").where({ id: user }).first();
    if (!device || device.status !== "active") {
      // Credentials were revoked after the broker cached them; drop the session.
      await management.closeUserConnections(user, "device credentials revoked");
      return;
    }
    await models.Device.where({ id: user }).update({
      online: true,
      connectionName: name,
      lastConnectedAt: new Date(connectedAt),
      lastSeenAt: new Date(),
    });
    invalidateDevice(user);
    log.info({ deviceId: user }, "device connected");
    bus.emit("device.connected", { deviceId: user });
    return;
  }

  if (msg.routingKey === "connection.closed") {
    // Only the connection we consider current may mark the device offline: on a
    // client-id takeover the new connection's "created" can precede the old "closed".
    const updated = await models.Device.where({ id: user, connectionName: name }).updateAndCount({
      online: false,
      connectionName: null,
      lastDisconnectedAt: new Date(),
    });
    if (updated > 0) {
      log.info({ deviceId: user }, "device disconnected");
      bus.emit("device.disconnected", { deviceId: user });
    }
  }
}
