// Test helpers: an HTTP client for the API, a simulated MQTT 5 device, and a
// synthetic ESP-IDF app image builder.

import { createHash } from "node:crypto";
import mqtt from "mqtt";

export const API = process.env.E2E_API_URL ?? "http://127.0.0.1:8080";

export async function api<T = any>(method: string, path: string, opts: { token?: string; json?: unknown; form?: FormData; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: RequestInit["body"];
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    body = opts.form;
  }
  const res = await fetch(`${API}${path}`, { method, headers, body });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data: data as T, headers: res.headers };
}

export async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export interface Received {
  topic: string;
  payload: Buffer;
  packet: mqtt.IPublishPacket;
}

/** A device speaking MQTT 5 over WebSocket, as the real firmware will. */
export class SimDevice {
  client!: mqtt.MqttClient;
  inbox: Received[] = [];
  readonly id: string;
  private readonly password: string;
  private readonly url: string;

  constructor(url: string, id: string, password: string) {
    this.url = url;
    this.id = id;
    this.password = password;
  }

  connect(password = this.password): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = mqtt.connect(this.url, {
        protocolVersion: 5,
        clientId: this.id,
        username: this.id,
        password,
        clean: false,
        properties: { sessionExpiryInterval: 3600 },
        reconnectPeriod: 0,
        connectTimeout: 8000,
        forceNativeWebSocket: typeof (globalThis as any).Bun !== "undefined",
      });
      client.on("message", (topic, payload, packet) => this.inbox.push({ topic, payload, packet }));
      client.once("connect", () => {
        this.client = client;
        resolve();
      });
      client.once("error", (err) => {
        client.end(true);
        reject(err);
      });
    });
  }

  async subscribeDown() {
    await this.client.subscribeAsync(`d/${this.id}/down/#`, { qos: 1 });
  }

  publish(sub: string, payload: string | Buffer | object, props: mqtt.IClientPublishOptions["properties"] = {}) {
    const body = typeof payload === "string" || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
    return this.client.publishAsync(`d/${this.id}/up/${sub}`, body, { qos: 1, properties: props });
  }

  async take(match: (m: Received) => boolean, what: string, timeoutMs = 8000): Promise<Received> {
    return until(what, async () => {
      const i = this.inbox.findIndex(match);
      return i === -1 ? null : this.inbox.splice(i, 1)[0];
    }, timeoutMs);
  }

  /** Answers a cloud request on the Response Topic it named. */
  respond(req: Received, body: object) {
    const p = req.packet.properties ?? {};
    return this.client.publishAsync(p.responseTopic!, JSON.stringify(body), {
      qos: 1,
      properties: { correlationData: p.correlationData },
    });
  }

  end() {
    return this.client?.endAsync();
  }
}

/** A minimal ESP-IDF app image: image header, segment header, esp_app_desc_t, padding. */
export function fakeEspImage(opts: { chipId: number; version: string; project: string; elfSha256: string; size?: number }): Buffer {
  const img = Buffer.alloc(opts.size ?? 4096);
  img.writeUInt8(0xe9, 0);
  img.writeUInt8(1, 1);
  img.writeUInt16LE(opts.chipId, 12);
  img.writeUInt32LE(0x3c000020, 24);
  img.writeUInt32LE(256, 28);
  const d = 32;
  img.writeUInt32LE(0xabcd5432, d);
  img.write(opts.version, d + 16, "utf8");
  img.write(opts.project, d + 48, "utf8");
  img.write("12:00:00", d + 80, "utf8");
  img.write("Oct 11 2026", d + 96, "utf8");
  img.write("v5.5", d + 112, "utf8");
  Buffer.from(opts.elfSha256, "hex").copy(img, d + 144);
  for (let i = d + 256; i < img.length; i++) img[i] = i & 0xff;
  return img;
}

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
