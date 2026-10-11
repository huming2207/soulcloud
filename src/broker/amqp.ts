// AMQP 1.0 connection to RabbitMQ: topology, publishing to devices, and
// consuming device traffic and connection events.

import {
  createEnvironment,
  type Connection,
  type Environment,
  type Publisher,
} from "rabbitmq-amqp-js-client";
import rhea, { type Message } from "rhea";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { exchangeAddress, TOPIC_EXCHANGE, UP_BINDING_KEY } from "./topics.ts";

export const INGEST_QUEUE = "soulcloud.device.up";
export const PRESENCE_QUEUE = "soulcloud.presence";
const EVENT_EXCHANGE = "amq.rabbitmq.event";
const PRESENCE_KEYS = ["connection.created", "connection.closed"];

/** A message as handed to platform handlers, independent of the AMQP library. */
export interface InboundMessage {
  routingKey: string;
  body: Buffer;
  contentType?: string;
  correlationId?: string;
  replyTo?: string;
  /** MQTT 5 user properties arrive as application properties. */
  properties: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

export type MessageHandler = (msg: InboundMessage) => Promise<void>;

export interface PublishOptions {
  contentType?: string;
  correlationId?: string;
  /** An MQTT topic the device should answer on (mapped to MQTT 5 Response Topic). */
  replyToRoutingKey?: string;
  ttlMs?: number;
  properties?: Record<string, string>;
}

function bodyToBuffer(body: unknown): Buffer {
  if (body == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body, "utf8");
  // rhea data section: { typecode: 0x75, content: Buffer }
  const section = body as { typecode?: number; content?: unknown };
  if (section.typecode === 0x75 && section.content !== undefined) return bodyToBuffer(section.content);
  return Buffer.from(JSON.stringify(body), "utf8");
}

function correlationToString(id: unknown): string | undefined {
  if (id == null) return undefined;
  if (typeof id === "string") return id;
  if (Buffer.isBuffer(id) || id instanceof Uint8Array) return Buffer.from(id).toString("utf8");
  return String(id);
}

function toInbound(msg: Message): InboundMessage {
  const annotations = (msg.message_annotations ?? {}) as Record<string, unknown>;
  return {
    routingKey: String(annotations["x-routing-key"] ?? ""),
    body: bodyToBuffer(msg.body),
    contentType: msg.content_type ? String(msg.content_type) : undefined,
    correlationId: correlationToString(msg.correlation_id),
    replyTo: msg.reply_to ? String(msg.reply_to) : undefined,
    properties: (msg.application_properties ?? {}) as Record<string, unknown>,
    annotations,
  };
}

/**
 * Serialises handler calls per key (e.g. per device) so a device's messages are
 * processed in arrival order while different devices proceed in parallel.
 */
class KeyedQueue {
  private tails = new Map<string, Promise<void>>();

  run(key: string, task: () => Promise<void>): void {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.tails.set(key, next);
    void next.finally(() => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    });
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.tails.values()]);
  }
}

export class Broker {
  private env?: Environment;
  private conn?: Connection;
  private publisher?: Publisher;
  private queues: KeyedQueue[] = [];

  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async connect(): Promise<void> {
    this.env = createEnvironment({
      host: this.config.AMQP_HOST,
      port: this.config.AMQP_PORT,
      username: this.config.AMQP_USER,
      password: this.config.AMQP_PASSWORD,
      // RabbitMQ selects the vhost from the AMQP 1.0 open frame's hostname.
      // The client spreads unknown params into rhea's connect options.
      hostname: `vhost:${this.config.AMQP_VHOST}`,
    } as Parameters<typeof createEnvironment>[0]);
    this.conn = await this.env.createConnection({ reconnect: true, initialReconnectDelay: 500, maxReconnectDelay: 10_000 });
    this.publisher = await this.conn.createPublisher();
    log.info({ host: this.config.AMQP_HOST, vhost: this.config.AMQP_VHOST }, "amqp connected");
  }

  /** Idempotently declares the platform's queues and bindings. */
  async declareTopology(): Promise<void> {
    const mgmt = this.connection.management();
    const exchange = (name: string) => ({ getInfo: { name } }) as unknown as Parameters<typeof mgmt.bind>[1]["source"];

    const ingest = await mgmt.declareQueue(INGEST_QUEUE, { type: "quorum", durable: true } as never);
    await mgmt.bind(UP_BINDING_KEY, { source: exchange(TOPIC_EXCHANGE), destination: ingest });

    const presence = await mgmt.declareQueue(PRESENCE_QUEUE, { type: "quorum", durable: true } as never);
    for (const key of PRESENCE_KEYS) await mgmt.bind(key, { source: exchange(EVENT_EXCHANGE), destination: presence });
  }

  /**
   * Consumes a queue. `keyOf` picks the serialisation key for each message.
   * A failed handler requeues the message; quorum queues cap redeliveries.
   */
  async consume(queue: string, keyOf: (msg: InboundMessage) => string, handler: MessageHandler): Promise<void> {
    const work = new KeyedQueue();
    this.queues.push(work);
    const consumer = await this.connection.createConsumer({
      queue: { name: queue },
      messageHandler: (ctx, raw) => {
        const msg = toInbound(raw);
        work.run(keyOf(msg), async () => {
          try {
            await handler(msg);
            ctx.accept();
          } catch (err) {
            log.error({ err, queue, routingKey: msg.routingKey }, "message handler failed, requeueing");
            ctx.requeue();
          }
        });
      },
    });
    consumer.start();
  }

  /**
   * Publishes to `amq.topic`, i.e. to MQTT subscribers of the matching topic.
   * Resolves to false when no queue took the message (RabbitMQ releases
   * unroutable messages), e.g. a device that has no MQTT session.
   */
  async publish(routingKey: string, body: Buffer | string | object, opts: PublishOptions = {}): Promise<boolean> {
    const isJson = !Buffer.isBuffer(body) && typeof body !== "string";
    const payload = isJson ? Buffer.from(JSON.stringify(body)) : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const message: Message = {
      to: exchangeAddress(routingKey),
      body: rhea.message.data_section(payload),
      content_type: opts.contentType ?? (isJson ? "application/json" : "application/octet-stream"),
      durable: true,
    };
    // A string correlation id reaches the MQTT client as its UTF-8 bytes.
    if (opts.correlationId) message.correlation_id = opts.correlationId;
    if (opts.replyToRoutingKey) message.reply_to = exchangeAddress(opts.replyToRoutingKey);
    if (opts.ttlMs) message.ttl = opts.ttlMs;
    if (opts.properties) message.application_properties = opts.properties;

    const result = await this.pub.publish(message);
    if (result.outcome === "ACCEPTED") return true;
    if (result.outcome === "RELEASED") return false;
    throw new Error(`broker rejected message for ${routingKey}`);
  }

  async close(): Promise<void> {
    await Promise.all(this.queues.map((q) => q.drain()));
    await this.conn?.close();
    await this.env?.close();
  }

  private get connection(): Connection {
    if (!this.conn) throw new Error("broker not connected");
    return this.conn;
  }

  private get pub(): Publisher {
    if (!this.publisher) throw new Error("broker not connected");
    return this.publisher;
  }
}
