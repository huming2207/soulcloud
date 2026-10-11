import { describe, expect, test } from "bun:test";
import {
  deviceQueueAllowed,
  deviceTopicAllowed,
  deviceTopics,
  mqttTopicToRoutingKey,
  parseUpRoutingKey,
  routingKeyToMqttTopic,
} from "../../src/broker/topics.ts";

const ID = "7KQ2M-XH9PA";
const OTHER = "ABCDE-FGHJK";

describe("topic mapping", () => {
  test("mqtt <-> routing key", () => {
    expect(mqttTopicToRoutingKey(`d/${ID}/up/req/ota.check`)).toBe(`d.${ID}.up.req.ota/check`);
    expect(mqttTopicToRoutingKey(`d/${ID}/down/+/x/#`)).toBe(`d.${ID}.down.*.x.#`);
    expect(routingKeyToMqttTopic(deviceTopics.downRequest(ID, "ota.start"))).toBe(`d/${ID}/down/req/ota.start`);
  });

  test("parse up routing keys", () => {
    expect(parseUpRoutingKey(`d.${ID}.up.status`)).toEqual({ deviceId: ID, kind: "status" });
    expect(parseUpRoutingKey(`d.${ID}.up.log.bin`)).toEqual({ deviceId: ID, kind: "log", format: "bin" });
    expect(parseUpRoutingKey(`d.${ID}.up.log.text`)).toEqual({ deviceId: ID, kind: "log", format: "text" });
    expect(parseUpRoutingKey(`d.${ID}.up.evt.ota`)).toEqual({ deviceId: ID, kind: "evt", name: "ota" });
    expect(parseUpRoutingKey(`d.${ID}.up.res`)).toEqual({ deviceId: ID, kind: "res" });
    expect(parseUpRoutingKey(`d.${ID}.up.req.ota/check`)).toEqual({ deviceId: ID, kind: "req", method: "ota.check" });
    expect(parseUpRoutingKey(`d.${ID}.up.req.ota.check`)).toEqual({ deviceId: ID, kind: "req", method: "ota.check" });
    expect(parseUpRoutingKey(`d.${ID}.up.log.xml`)).toBeNull();
    expect(parseUpRoutingKey(`d.${ID}.up.status.extra`)).toBeNull();
    expect(parseUpRoutingKey(`d.${ID}.down.res`)).toBeNull();
    expect(parseUpRoutingKey(`x.${ID}.up.status`)).toBeNull();
  });
});

describe("device ACL", () => {
  const cases: [string, "read" | "write", string, boolean][] = [
    ["publish own status", "write", `d.${ID}.up.status`, true],
    ["publish own log", "write", `d.${ID}.up.log.bin`, true],
    ["publish to own down", "write", `d.${ID}.down.req.reboot`, false],
    ["publish to other device", "write", `d.${OTHER}.up.status`, false],
    ["publish with wildcard", "write", `d.${ID}.up.#`, false],
    ["publish bare prefix", "write", `d.${ID}.up.`, false],
    ["subscribe own down", "read", `d.${ID}.down.#`, true],
    ["subscribe own down req", "read", `d.${ID}.down.req.*`, true],
    ["subscribe own up", "read", `d.${ID}.up.#`, false],
    ["subscribe everything", "read", `#`, false],
    ["subscribe all devices", "read", `d.*.down.#`, false],
    ["subscribe other device", "read", `d.${OTHER}.down.#`, false],
    ["id prefix confusion", "write", `d.${ID}X.up.status`, false],
  ];
  for (const [name, perm, rk, allowed] of cases) {
    test(name, () => expect(deviceTopicAllowed(ID, perm, rk)).toBe(allowed));
  }

  test("queues", () => {
    expect(deviceQueueAllowed(ID, `mqtt-subscription-${ID}qos1`)).toBe(true);
    expect(deviceQueueAllowed(ID, `mqtt-will-${ID}`)).toBe(true);
    expect(deviceQueueAllowed(ID, `mqtt-subscription-${OTHER}qos1`)).toBe(false);
    expect(deviceQueueAllowed(ID, `soulcloud.device.up`)).toBe(false);
  });
});
