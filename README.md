# SoulCloud

IoT device management for MQTT 5 devices, starting with the ESP32 family. It
handles:

- device enrollment;
- online state, uptime and health;
- text logs and on9log binary logs;
- a remote debug shell and other request/response commands;
- OTA firmware updates.

Human users get a REST API (OpenAPI spec at `/openapi.json`); there is no web
frontend yet.

```
ESP32 ──MQTT 5 over WebSocket──▶ RabbitMQ 4 ◀──AMQP 1.0── SoulCloud (Bun / Node) ──▶ PostgreSQL
  │                                 │  ▲                     ├─ REST API          :8080
  │                                 │  └─ broker auth ───────├─ broker auth (HTTP):8081 (internal)
  └──HTTPS: enroll, firmware ───────┼────────────────────────├─ ingest + RPC
                                    └─ connection events ────└─ sweeper
```

- **Devices** use MQTT 5 over WebSocket only, against RabbitMQ's Web MQTT
  plugin. [docs/device-protocol.md](docs/device-protocol.md) is the full device
  contract: enrollment, topics, payloads, request/response and OTA.
- **Broker authentication** uses `rabbitmq_auth_backend_http`, answered by the
  platform. Device logins always reach the platform, so an unpaired device is
  refused at once. Topic and queue checks are cached for 30 s.
- **The platform** talks to RabbitMQ over AMQP 1.0
  (`rabbitmq-amqp-js-client`):
  - it consumes one quorum queue with all device traffic and one with broker
    connection events (presence);
  - it publishes requests to devices through `amq.topic`.
- **Request/response** uses MQTT 5 Response Topic and Correlation Data in both
  directions.
- **Binary logs** are stored raw and decoded on read against the firmware's
  ELF, by a TypeScript port of the on9log host decoder.
- **OTA** is pulled by the device over HTTPS from a short-lived signed URL.
  Firmware images are parsed on upload, so version, chip and ELF hash come
  from the image itself.
- **TLS** is terminated by the reverse proxy (Traefik); the platform and the
  broker speak plain HTTP/WebSocket behind it.

## Requirements

- Bun 1.3+ (primary runtime) or Node.js 22.18+ (supported)
- Docker, for PostgreSQL 18 and RabbitMQ 4.3

## Getting started

```sh
docker compose up -d --wait   # PostgreSQL (5433) and RabbitMQ (5672, 15672, 15675)
bun install
cp .env.example .env          # defaults match compose.yaml
bun run db:deploy             # apply migrations
bun run dev                   # API on :8080, broker auth on :8081
```

The first account registered (`POST /v1/auth/register`) becomes an admin.

To run on Node instead: `bun run start:node` (`node src/main.ts`, using
Node's type stripping).

### Roles

One process runs every role by default. `SOULCLOUD_ROLES` splits them:

| Role | Does |
|---|---|
| `api` | REST API and the broker-auth listener |
| `ingest` | consumes device traffic and connection events, declares queues |
| `sweeper` | expires commands, applies log/heartbeat retention, repairs presence |

Waiting command calls (`?wait=`) and the SSE log tail are woken in-process, so
for now run `api` and `ingest` in the same process.

## API overview

All routes are under `/v1` and take `Authorization: Bearer <token>` unless
marked public. The OpenAPI 3.1 document at `/openapi.json` has every schema.

| Area | Endpoints |
|---|---|
| Auth | `POST auth/register`, `POST auth/login` (public), `POST auth/logout`, `GET auth/me` |
| Enrollment | `POST/GET enrollments`, `DELETE enrollments/{id}`, `POST device/enroll` (public, called by devices) |
| Devices | `GET devices`, `GET/PATCH/DELETE devices/{id}`, `GET devices/{id}/heartbeats` |
| Commands | `GET methods`, `POST devices/{id}/commands?wait=`, `GET devices/{id}/commands[/{commandId}?wait=]`, `POST devices/{id}/shell` |
| Logs | `GET devices/{id}/logs`, `GET devices/{id}/logs/stream` (SSE), `GET devices/{id}/logs/raw` |
| Firmware | `POST/GET firmware`, `GET/DELETE firmware/{id}`, `PUT firmware/{id}/elf`, `GET device/firmware/{id}` (public, signed) |
| OTA | `POST/GET ota-jobs`, `GET ota-jobs/{id}`, `POST ota-jobs/{id}/cancel`, `GET devices/{id}/ota-tasks` |
| Users | `GET users`, `PATCH users/{id}` (admin) |

`logs/raw` returns binary logs as typed SLIP frames for the on9log CLI:
`on9log --log-bin device.on9log --elf firmware.elf`.

## Development

```sh
bun run typecheck
bun test tests/unit          # includes a golden test against the on9log host decoder's output
bun test tests/e2e           # needs the compose stack; starts the platform unless one is running
```

The e2e suite drives a simulated MQTT 5 device over WebSocket through the whole
flow:

- enrollment, presence and heartbeats;
- text and binary logs;
- shell and device-initiated requests;
- OTA, with signed and Range downloads;
- unpairing.

### Database

The schema is the Prisma ORM 8 contract in `src/prisma/contract.prisma`. After
changing it:

```sh
bun run db:emit                        # regenerate contract.json / contract.d.ts
bun run db:plan -- --name what-changed # write a migration under migrations/app
bun run db:migrate                     # apply it and advance the dev `db` ref
```

Production applies committed migrations with `bun run db:deploy`.

### Layout

```
src/main.ts            process bootstrap and roles
src/config.ts          environment (validated)
src/broker/            AMQP 1.0 client, topic scheme and ACL, management API
src/http/              REST API (Hono + zod-openapi), broker-auth endpoints
src/devices/           ids, enrollment, presence, status, reconciliation
src/rpc/               command lifecycle, method registry, device->cloud requests
src/logs/              text parsing, on9log decoder, rendering
src/firmware/, src/ota/  firmware storage and OTA rollout
src/platforms/         per-family firmware parsing and reset reasons (ESP32 today)
deploy/rabbitmq/       broker configuration
docs/                  device protocol
```

## Production notes

- **Traefik** terminates TLS for the API and for `/ws` (Web MQTT, port 15675).
  Set `PUBLIC_BASE_URL` and `DEVICE_MQTT_URL` (`wss://…/ws`) to the public
  addresses. Pass `X-Forwarded-For` through; the enrollment rate limit uses it.
- **Broker auth listener** (`BROKER_AUTH_PORT`, 8081): reachable from RabbitMQ
  only, never public. Its secret path segment must match `BROKER_AUTH_SECRET`
  and the URLs in `deploy/rabbitmq/rabbitmq.conf`. Change both from the
  development default.
- **Secrets:** generate `DEVICE_PASSWORD_PEPPER` and `DOWNLOAD_SIGNING_SECRET`
  with `openssl rand -base64 32`. Changing the pepper invalidates every device
  password.
- **Service account:** change the RabbitMQ service account password
  (`AMQP_PASSWORD`, `RABBITMQ_DEFAULT_PASS`).
- **Firmware storage:** firmware and ELF files are stored under `DATA_DIR`;
  back it up with the database.
