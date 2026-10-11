// RabbitMQ management HTTP API: only used to close live device connections when
// a device is unpaired or re-enrolled. Credential checks then refuse reconnects.

import type { Config } from "../config.ts";
import { log } from "../log.ts";

export class BrokerManagement {
  private readonly base: string;
  private readonly auth: string;

  constructor(config: Config) {
    this.base = config.RABBITMQ_MANAGEMENT_URL.replace(/\/+$/, "");
    this.auth = "Basic " + Buffer.from(`${config.AMQP_USER}:${config.AMQP_PASSWORD}`).toString("base64");
  }

  /** Closes every connection authenticated as `username`. Never throws. */
  async closeUserConnections(username: string, reason: string): Promise<void> {
    try {
      const res = await fetch(`${this.base}/api/connections/username/${encodeURIComponent(username)}`, {
        method: "DELETE",
        headers: { authorization: this.auth, "x-reason": reason },
      });
      if (!res.ok && res.status !== 404) {
        log.warn({ username, status: res.status }, "closing broker connections failed");
      }
    } catch (err) {
      log.warn({ err, username }, "closing broker connections failed");
    }
  }

  /** Live connections in the platform vhost: who and the connection name. */
  async listConnections(vhost: string): Promise<{ user: string; name: string }[]> {
    const res = await fetch(`${this.base}/api/connections?columns=user,name,vhost&disable_stats=true`, {
      headers: { authorization: this.auth },
    });
    if (!res.ok) throw new Error(`listing broker connections failed: ${res.status}`);
    const rows = (await res.json()) as { user?: string; name?: string; vhost?: string }[];
    return rows
      .filter((r) => r.vhost === vhost && r.user && r.name)
      .map((r) => ({ user: r.user!, name: r.name! }));
  }
}
