# SoulCloud

IoT device management for MQTT 5 devices, starting with the ESP32 family. It
handles:

- device enrollment;
- online state, uptime and health;
- text logs and on9log binary logs;
- a remote debug shell and other request/response commands;
- OTA firmware updates.

Human users get a Material UI web console (`web/`, served by Nginx) on top of a
REST API (OpenAPI spec at `/openapi.json`).

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

## Running it

There are three compose files:

| File | Use |
|---|---|
| `compose.yaml` | PostgreSQL and RabbitMQ only, for running the platform and UI on the host while you edit code |
| `compose.dev.yaml` | Everything in containers behind Traefik over plain HTTP, for local testing |
| `compose.prod.yaml` | Everything in containers behind Traefik with Let's Encrypt TLS, for deployment |

Traefik serves one origin:

- `/v1`, `/openapi.json` and `/healthz` go to the platform;
- `/ws` goes to RabbitMQ Web MQTT;
- everything else goes to Nginx with the web UI.

### Developing on the host

```sh
docker compose up -d --wait   # PostgreSQL (5433) and RabbitMQ (5672, 15672, 15675)
bun install
cp .env.example .env          # defaults match compose.yaml
bun run db:deploy             # apply migrations
bun run dev                   # API on :8080, broker auth on :8081

cd web && bun install && bun run dev   # UI on http://localhost:5173 (proxies /v1 to :8080)
```

The first account registered becomes an admin. To run the platform on Node
instead: `bun run start:node` (`node src/main.ts`, using Node's type
stripping).

### Full stack locally (HTTP)

```sh
docker compose -f compose.dev.yaml up -d --build
```

| URL | What |
|---|---|
| http://localhost/ | UI |
| http://localhost/v1 | API |
| ws://localhost/ws | MQTT for devices |
| http://localhost/rabbitmq/ | RabbitMQ management (`soulcloud` / `soulcloud`) |
| http://127.0.0.1:8090/ | Traefik dashboard |

To let real devices on your network connect, set `PUBLIC_HOST` to this machine's
LAN address. Set `HTTP_PORT` if port 80 is taken. Every secret in this file is a
development value.

### Production

1. Point the domain's DNS at the server and open ports 80 and 443.
2. Create the settings file: `cp deploy/production.env.example .env.production`.
   Fill in the domain, the ACME e-mail and every secret (`openssl rand -hex 32`).
3. Start the stack: `docker compose -f compose.prod.yaml --env-file .env.production up -d --build`.
4. Open `https://<domain>/` and register; the first account becomes an admin.
   Further sign-ups need `ALLOW_REGISTRATION=true`.

What the production stack does:

- Migrations run automatically (the `migrate` service) before the platform
  starts.
- HTTP redirects to HTTPS, and every route sends HSTS.
- PostgreSQL and RabbitMQ are not published. The RabbitMQ management UI listens
  on the server's loopback (`ssh -L 15672:127.0.0.1:15672 <server>`).
- To try a deployment without hitting Let's Encrypt rate limits, set
  `ACME_CA_SERVER` to the staging directory.
- Back up the `pgdata` and `platformdata` volumes. The second holds the
  firmware images and ELFs.

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

The web UI (`web/`) is React + Vite with Material UI, MUI X DataGrid/Charts and
TanStack Query. Its API types come from the platform's OpenAPI document.
Regenerate them after changing an API route:

```sh
cd web && bun run gen:api && bun run typecheck
```

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
web/                   web UI (React + MUI), its Dockerfile and Nginx config
deploy/rabbitmq/       broker configuration and start script
deploy/                production settings template
scripts/               OpenAPI export for the web client
docs/                  device protocol
Dockerfile             platform image
```

## Production notes

- **Broker auth listener** (port 8081): never routed by Traefik. RabbitMQ
  reaches it as `BROKER_AUTH_URL`, whose last path segment must equal
  `BROKER_AUTH_SECRET`. `deploy/rabbitmq/start.sh` writes the broker's auth
  URLs from it at startup.
- **Device password pepper:** changing `DEVICE_PASSWORD_PEPPER` invalidates every device password.
- **Long connections:** Traefik's read timeout is 300 s, to allow long firmware
  uploads. Long-lived WebSocket (MQTT) and SSE connections aren't affected by
  it.
- **Images:** they're built as `${IMAGE_PREFIX}/platform` and
  `${IMAGE_PREFIX}/web` with tag `${IMAGE_TAG}`, so you can push them to a
  registry and deploy without building on the server.
