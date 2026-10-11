// Device topic scheme. Devices speak MQTT topics (`d/<id>/up/status`); RabbitMQ
// routes them through `amq.topic` with `/` turned into `.` (`d.<id>.up.status`).
// The platform only ever sees routing keys.
//
//   up   (device -> cloud)  d/<id>/up/status | log/text | log/bin | evt/<name> | res | req/<method>
//   down (cloud -> device)  d/<id>/down/req/<method> | down/res
//
// Method names are dotted in the API (`ota.start`) and become topic levels on
// the wire (`d/<id>/down/req/ota/start`).

export const TOPIC_EXCHANGE = "amq.topic";

/** Binding for the platform's ingest queue: everything any device sends. */
export const UP_BINDING_KEY = "d.*.up.#";

/** MQTT -> AMQP: RabbitMQ swaps `/` and `.` and maps the `+` wildcard to `*`. */
export function mqttTopicToRoutingKey(topic: string): string {
  return topic.replace(/[./]/g, (c) => (c === "/" ? "." : "/")).replace(/\+/g, "*");
}

/** AMQP -> MQTT: each `.` becomes a topic level separator. */
export function routingKeyToMqttTopic(rk: string): string {
  return rk.replaceAll(".", "/").replace(/\*/g, "+");
}

export function exchangeAddress(routingKey: string): string {
  return `/exchanges/${encodeURIComponent(TOPIC_EXCHANGE)}/${encodeURIComponent(routingKey)}`;
}

export const deviceTopics = {
  upPrefix: (id: string) => `d/${id}/up/`,
  downPrefix: (id: string) => `d/${id}/down/`,
  /** Routing key for a cloud -> device request; `ota.start` arrives as `d/<id>/down/req/ota/start`. */
  downRequest: (id: string, method: string) => `d.${id}.down.req.${method}`,
  /** Routing key for the platform's reply to a device -> cloud request. */
  downResponse: (id: string) => `d.${id}.down.res`,
  /** MQTT topic devices must use as Response Topic target for cloud requests. */
  upResponseTopic: (id: string) => `d/${id}/up/res`,
};

export type UpMessage =
  | { deviceId: string; kind: "status" }
  | { deviceId: string; kind: "log"; format: "text" | "bin" }
  | { deviceId: string; kind: "evt"; name: string }
  | { deviceId: string; kind: "res" }
  | { deviceId: string; kind: "req"; method: string };

/**
 * Classify an ingest routing key. Returns null for anything outside the scheme.
 * Method and event names are reported with `.` separators (e.g. `ota.check`)
 * whether the device wrote them with dots or slashes.
 */
export function parseUpRoutingKey(rk: string): UpMessage | null {
  const parts = rk.split(".");
  if (parts.length < 4 || parts[0] !== "d" || parts[2] !== "up") return null;
  const deviceId = parts[1]!;
  const rest = parts.slice(3);
  const head = rest[0];
  // `up/req/ota.check` arrives as `req.ota/check`, `up/req/ota/check` as `req.ota.check`.
  const tail = rest.slice(1).join(".").replaceAll("/", ".");
  switch (head) {
    case "status":
      return rest.length === 1 ? { deviceId, kind: "status" } : null;
    case "res":
      return rest.length === 1 ? { deviceId, kind: "res" } : null;
    case "log":
      return tail === "text" || tail === "bin" ? { deviceId, kind: "log", format: tail } : null;
    case "evt":
      return tail ? { deviceId, kind: "evt", name: tail } : null;
    case "req":
      return tail ? { deviceId, kind: "req", method: tail } : null;
    default:
      return null;
  }
}

// --- Broker authorisation rules for devices -------------------------------

/** May device `id` publish to / subscribe on this routing key (or key pattern)? */
export function deviceTopicAllowed(id: string, permission: "read" | "write", routingKey: string): boolean {
  const prefix = permission === "write" ? `d.${id}.up.` : `d.${id}.down.`;
  if (!routingKey.startsWith(prefix) || routingKey.length === prefix.length) return false;
  // A publish must name a concrete topic; a subscription may use wildcards after the prefix.
  if (permission === "write" && /[*#]/.test(routingKey)) return false;
  return true;
}

/** Queues RabbitMQ's MQTT plugin creates on behalf of a client. */
export function deviceQueueAllowed(id: string, queue: string): boolean {
  return queue.startsWith(`mqtt-subscription-${id}`) || queue.startsWith(`mqtt-will-${id}`);
}
