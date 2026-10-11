// End-to-end: the platform, RabbitMQ and PostgreSQL from compose.yaml, and a
// simulated device speaking MQTT 5 over WebSocket.
//
//   docker compose up -d --wait && bun test tests/e2e
//
// The platform is started here unless one is already answering on E2E_API_URL.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { slipDeframe, FRAME_ON9LOG } from "../../src/logs/on9log/slip.ts";
import { API, SimDevice, api, fakeEspImage, sha256, until } from "./helpers.ts";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/on9log/${name}`, import.meta.url));
const ESP32S3 = 0x09;

let platform: ReturnType<typeof Bun.spawn> | null = null;
let token = "";
let device: SimDevice;
let creds: { deviceId: string; mqtt: { url: string; password: string } };

const demoElf = fixture("unix_demo.elf");
const demoElfSha = sha256(demoElf);
const v1 = fakeEspImage({ chipId: ESP32S3, version: "1.0.0", project: "e2e-demo", elfSha256: demoElfSha });
const v2ElfSha = randomBytes(32).toString("hex");
const v2 = fakeEspImage({ chipId: ESP32S3, version: "1.1.0", project: "e2e-demo", elfSha256: v2ElfSha, size: 64 * 1024 });

beforeAll(async () => {
  const running = await fetch(`${API}/healthz`).then((r) => r.ok).catch(() => false);
  if (!running) {
    platform = Bun.spawn(["bun", "src/main.ts"], { stdout: "ignore", stderr: "inherit", env: { ...process.env, LOG_LEVEL: "warn" } });
    await until("platform to start", () => fetch(`${API}/healthz`).then((r) => r.ok).catch(() => false), 20_000);
  }
  const email = `e2e-${Date.now()}-${randomBytes(3).toString("hex")}@example.com`;
  const reg = await api("POST", "/v1/auth/register", { json: { email, password: "e2e-password-1" } });
  expect(reg.status).toBe(201);
  token = reg.data.token;
}, 30_000);

afterAll(async () => {
  await device?.end();
  platform?.kill();
});

describe("platform end to end", () => {
  test("enrollment issues fresh credentials once", async () => {
    const enr = await api("POST", "/v1/enrollments", { token, json: { deviceName: "bench unit" } });
    expect(enr.status).toBe(201);
    const body = { token: enr.data.token, hardwareId: `24:6f:28:${randomBytes(3).toString("hex")}`, platform: "esp32", chip: "esp32s3" };

    const bad = await api("POST", "/v1/device/enroll", { json: { ...body, token: "2222-2222-2222-2222" } });
    expect(bad.status).toBe(401);

    const ok = await api("POST", "/v1/device/enroll", { json: body });
    expect(ok.status).toBe(201);
    expect(ok.data.deviceId).toMatch(/^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
    expect(ok.data.mqtt.url).toStartWith("ws");
    expect(ok.data.name).toBe("bench unit");
    creds = ok.data;

    const reuse = await api("POST", "/v1/device/enroll", { json: body });
    expect(reuse.status).toBe(401);
  });

  test("device connects over MQTT 5 / WebSocket and shows online", async () => {
    const wrong = new SimDevice(creds.mqtt.url, creds.deviceId, "not-the-password");
    await expect(wrong.connect()).rejects.toThrow();

    device = new SimDevice(creds.mqtt.url, creds.deviceId, creds.mqtt.password);
    await device.connect();
    await device.subscribeDown();
    const d = await until("device online", async () => {
      const r = await api("GET", `/v1/devices/${creds.deviceId}`, { token });
      return r.data.online ? r.data : null;
    });
    expect(d.status).toBe("active");
  });

  test("firmware upload reads the image and checks the ELF", async () => {
    const mismatched = new FormData();
    mismatched.set("bin", new File([v1], "app.bin"));
    mismatched.set("elf", new File([randomBytes(64)], "app.elf"));
    expect((await api("POST", "/v1/firmware", { token, form: mismatched })).status).toBe(400);

    const form = new FormData();
    form.set("bin", new File([v1], "app.bin"));
    form.set("elf", new File([demoElf], "app.elf"));
    const fw = await api("POST", "/v1/firmware", { token, form });
    expect(fw.status).toBe(201);
    expect(fw.data).toMatchObject({ chip: "esp32s3", version: "1.0.0", projectName: "e2e-demo", elfSha256: demoElfSha, hasElf: true });

    const again = await api("POST", "/v1/firmware", { token, form });
    expect(again.status).toBe(409);
  });

  test("heartbeat updates uptime, reset reason and current firmware", async () => {
    await device.publish("status", {
      birth: true,
      uptimeMs: 1234,
      bootId: 77,
      resetReason: 1,
      fw: { version: "1.0.0", elfSha256: demoElfSha.slice(0, 16) },
      heap: { free: 123456, minFree: 100000 },
      rssi: -61,
    });
    const d = await until("heartbeat applied", async () => {
      const r = await api("GET", `/v1/devices/${creds.deviceId}`, { token });
      return r.data.uptimeMs === 1234 ? r.data : null;
    });
    expect(d).toMatchObject({ resetReason: "power_on", bootId: 77, fwVersion: "1.0.0" });
    expect(d.currentFirmwareId).toBeTruthy();
    expect(d.health.heap.free).toBe(123456);
    const hb = await api("GET", `/v1/devices/${creds.deviceId}/heartbeats`, { token });
    expect(hb.data.length).toBeGreaterThanOrEqual(1);
  });

  test("text logs are parsed and filterable", async () => {
    await device.publish("log/text", "I (100) wifi: connected\nW (200) app: low heap\n\x1b[0;31mE (300) app: boom\x1b[0m\nplain line\n");
    const page = await until("text logs", async () => {
      const r = await api("GET", `/v1/devices/${creds.deviceId}/logs?kind=text`, { token });
      return r.data.items.length >= 4 ? r.data : null;
    });
    const msgs = page.items.map((l: any) => `${l.level}|${l.tag}|${l.deviceTimeMs}|${l.message}`).reverse();
    expect(msgs).toEqual(["info|wifi|100|connected", "warn|app|200|low heap", "error|app|300|boom", "info|null|null|plain line"]);
    const warn = await api("GET", `/v1/devices/${creds.deviceId}/logs?kind=text&level=warn`, { token });
    expect(warn.data.items.map((l: any) => l.message)).toEqual(["boom", "low heap"]);
  });

  test("binary logs are decoded with the firmware ELF", async () => {
    const packets = slipDeframe(fixture("unix_demo.slip"))
      .filter((f) => f.type === FRAME_ON9LOG)
      .map((f) => f.payload)
      .slice(0, 12);
    const sync = Buffer.alloc(22);
    sync.writeUInt8(0x9a, 0);
    sync.writeUInt8(0x20, 1); // TIME_SYNC, level none
    sync.writeUInt32LE(packets[0]!.readUInt32LE(4) + 5000, 4);
    sync.writeUInt16LE(4, 16);
    sync.writeUInt32LE(77, 18);
    await device.publish("log/bin", Buffer.concat([...packets, sync]));

    const expected = fixture("unix_demo.expected.txt").toString("utf8").split("\n");
    const page = await until("binary logs", async () => {
      const r = await api("GET", `/v1/devices/${creds.deviceId}/logs?kind=bin&limit=50`, { token });
      return r.data.items.length >= 12 ? r.data : null;
    });
    const entries = page.items.reverse();
    expect(entries.every((e: any) => e.decoded)).toBe(true);
    expect(`${entries[0].tag}: ${entries[0].message}`).toBe(expected[0]!.replace(/^. \(\d+\) /, ""));
    expect(entries[0].loggedAt).toBeTruthy(); // placed in time by the TIME_SYNC packet

    const raw = await fetch(`${API}/v1/devices/${creds.deviceId}/logs/raw`, { headers: { authorization: `Bearer ${token}` } });
    expect(slipDeframe(new Uint8Array(await raw.arrayBuffer()))).toHaveLength(12);
  });

  test("shell round trip over MQTT 5 request/response", async () => {
    const pending = api("POST", `/v1/devices/${creds.deviceId}/shell`, { token, json: { line: "get free_heap internal", timeoutSec: 10 } });
    const req = await device.take((m) => m.topic === `d/${creds.deviceId}/down/req/shell`, "shell request");
    expect(JSON.parse(req.payload.toString())).toEqual({ line: "get free_heap internal" });
    expect(req.packet.properties?.responseTopic).toBe(`d/${creds.deviceId}/up/res`);
    await device.respond(req, { ok: true, result: { code: 0, output: "Total 123456; Min blk: 100000" } });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ code: 0, output: "Total 123456; Min blk: 100000" });
    expect(res.data.command.status).toBe("succeeded");
  });

  test("device can call the cloud (request/response)", async () => {
    const correlationData = Buffer.from("req-1");
    await device.publish("req/time", {}, { responseTopic: `d/${creds.deviceId}/down/res`, correlationData });
    const res = await device.take((m) => m.topic === `d/${creds.deviceId}/down/res`, "time response");
    expect(Buffer.from(res.packet.properties!.correlationData!).toString()).toBe("req-1");
    const body = JSON.parse(res.payload.toString());
    expect(body.ok).toBe(true);
    expect(Math.abs(body.result.epochMs - Date.now())).toBeLessThan(10_000);

    await device.publish("req/ota/check", {}, { responseTopic: `d/${creds.deviceId}/down/res`, correlationData: Buffer.from("req-2") });
    const check = await device.take((m) => m.topic === `d/${creds.deviceId}/down/res`, "ota.check response");
    expect(Buffer.from(check.packet.properties!.correlationData!).toString()).toBe("req-2");
    expect(JSON.parse(check.payload.toString())).toEqual({ ok: true, result: { update: null } });
  });

  test("OTA: signed download, progress and completion", async () => {
    const form = new FormData();
    form.set("bin", new File([v2], "app.bin"));
    const fw = await api("POST", "/v1/firmware", { token, form });
    expect(fw.status).toBe(201);

    const job = await api("POST", "/v1/ota-jobs", { token, json: { firmwareId: fw.data.id, deviceIds: [creds.deviceId] } });
    expect(job.status).toBe(201);
    const start = await device.take((m) => m.topic === `d/${creds.deviceId}/down/req/ota/start`, "ota.start");
    const params = JSON.parse(start.payload.toString());
    expect(params).toMatchObject({ sha256: sha256(v2), size: v2.length, version: "1.1.0" });
    await device.respond(start, { ok: true });

    const full = await fetch(params.url);
    expect(full.status).toBe(200);
    expect(sha256(new Uint8Array(await full.arrayBuffer()))).toBe(params.sha256);
    const part = await fetch(params.url, { headers: { range: "bytes=100-199" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 100-199/${v2.length}`);
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    const forged = await fetch(params.url.replace(/sig=[0-9a-f]+/, "sig=" + "0".repeat(64)));
    expect(forged.status).toBe(403);

    await device.publish("evt/ota", { taskId: params.taskId, state: "downloading", progress: 50 });
    await until("progress", async () => {
      const r = await api("GET", `/v1/ota-jobs/${job.data.id}`, { token });
      return r.data.tasks[0].progress === 50 ? r : null;
    });
    await device.publish("evt/ota", { taskId: params.taskId, state: "rebooting", progress: 100 });
    await device.publish("status", { birth: true, uptimeMs: 50, bootId: 78, resetReason: 3, fw: { version: "1.1.0", elfSha256: v2ElfSha } });
    const done = await until("OTA success", async () => {
      const r = await api("GET", `/v1/ota-jobs/${job.data.id}`, { token });
      return r.data.tasks[0].status === "succeeded" ? r.data : null;
    });
    expect(done.tasks[0].progress).toBe(100);
  });

  test("commands to an unknown method still flow; bad params are rejected", async () => {
    const bad = await api("POST", `/v1/devices/${creds.deviceId}/commands`, { token, json: { method: "reboot", params: { delayMs: -1 } } });
    expect(bad.status).toBe(400);
    const internal = await api("POST", `/v1/devices/${creds.deviceId}/commands`, { token, json: { method: "ota.start", params: {} } });
    expect(internal.status).toBe(400);

    const pending = api("POST", `/v1/devices/${creds.deviceId}/commands?wait=10`, { token, json: { method: "gpio.read", params: { pin: 4 } } });
    const req = await device.take((m) => m.topic === `d/${creds.deviceId}/down/req/gpio/read`, "custom request");
    await device.respond(req, { ok: false, error: "no such pin" });
    const res = await pending;
    expect(res.data).toMatchObject({ status: "failed", error: "no such pin" });
  });

  test("unpairing closes the connection and refuses reconnects", async () => {
    const closed = new Promise<void>((resolve) => device.client.once("close", () => resolve()));
    const del = await api("DELETE", `/v1/devices/${creds.deviceId}`, { token });
    expect(del.status).toBe(204);
    await closed;
    const again = new SimDevice(creds.mqtt.url, creds.deviceId, creds.mqtt.password);
    await expect(again.connect()).rejects.toThrow();
    const d = await api("GET", `/v1/devices/${creds.deviceId}`, { token });
    expect(d.data).toMatchObject({ status: "revoked", online: false });
  });
});
