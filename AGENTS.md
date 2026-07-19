# Soulcloud contributor guide

This file applies to the entire repository.

## Project intent

Soulcloud is an IoT device-management platform being built as a Rust workspace.
Its intended product areas are fleet/customer/project OTA management, tagged log
collection, basic user permissions and settings, and device statistics such as
presence and uptime.

Do not invent domain or wire-protocol behavior to fill gaps. If a change depends
on an unresolved product decision, state the missing decision and ask for it.
Keep the unresolved items in `README.md` accurate as contracts are agreed.

## Workspace boundaries

There are two deployable services and one internal library:

- `crates/soulcloud-api`: human-facing REST API. Authentication, authorization,
  tenant-facing settings, and browser/API behavior belong here. It must not
  connect directly to devices or own an MQTT event loop.
- `crates/soulcloud-worker`: device-facing MQTT worker. MQTT subscription,
  publication, device-message validation, and ingestion processing belong here.
  It must not expose human-facing product APIs.
- `crates/soulcloud-core`: shared configuration, PostgreSQL/Diesel support, and
  protocol/domain primitives used by both services. It is not deployable.

Both services use the same PostgreSQL database. Keep Redis out of the design
until it is justified by an actual IPC or scaling requirement. PostgreSQL
`LISTEN`/`NOTIFY` may be used for transient record-update notification, but the
database remains the source of truth. Define notification channel names and
payload contracts centrally before using them.

## MQTT contract

Device transport is MQTT over WebSocket only. The worker must reject broker URLs
that are not `ws://` or `wss://`. Preserve optional HTTP CONNECT proxy support
for restricted corporate networks and WSS on port 443.

The v1 topics are:

| Direction | Topic | Meaning |
| --- | --- | --- |
| Platform to device | `soulcloud/v1/devices/{dev_uid}/ota` | OTA command |
| Platform to device | `soulcloud/v1/devices/{dev_uid}/cmd` | Generic device command, such as reboot or logging control |
| Device to platform | `soulcloud/v1/devices/{dev_uid}/log` | Log events |
| Device to platform | `soulcloud/v1/devices/{dev_uid}/stat` | Presence, statistics, and firmware version |

Keep topic constants, construction, validation, and parsing in
`soulcloud-core::mqtt_topic`; do not scatter topic string literals through the
services. Preserve the platform-command/device-report direction split so the
worker does not consume its own outbound commands. The worker subscribes to
device-to-platform topics at QoS 1.

### Generic command payload (`cmd`)

The platform-to-device `soulcloud/v1/devices/{dev_uid}/cmd` payload is
MessagePack. Use the shared `soulcloud-core::mqtt_command` types and codec;
do not add a service-local command schema or MessagePack encoder/decoder.

- The top-level value is a map containing only `cmd` and optional `args`.
- `cmd` is required and must be a non-null string.
- `args` may be omitted or MessagePack `nil`; otherwise it is an array.
- Every `args` entry is a map with exactly one string argument-name key and a
  value of only `nil`, string, binary, signed/unsigned integer, float, or
  boolean.
- Reject unknown top-level fields, missing/null `cmd`, malformed argument maps,
  array, map, extension, or other unsupported argument values, and any trailing
  bytes after the one complete MessagePack value.

Keep the implementation and the human-facing `README.md` contract synchronized.

### Device status payload (`stat`)

The device-to-platform `soulcloud/v1/devices/{dev_uid}/stat` payload is
MessagePack. Use `soulcloud-core::mqtt_stat` for this schema; the worker must
validate it before any future ingestion or persistence work.

- The top-level value is a map containing only required `sn`, `fw`, `up`, and
  `rst` fields.
- `sn` and `fw` are MessagePack binary values for the chip-unique serial number
  and firmware hash respectively. Do not impose a byte layout, length, or hash
  algorithm until agreed.
- `up` is an unsigned 64-bit uptime counter. Its unit and clock semantics are
  not defined.
- `rst` is a non-null reset-reason string; its permitted values are not defined.
- Reject missing, null, duplicate, unknown, and wrongly typed fields, and any
  trailing bytes after the one complete MessagePack value.

Payload schemas for `ota` and `log`, retained-message policy, acknowledgements,
delivery/idempotency, and status persistence semantics remain undefined; do not
choose them without an agreed contract. Keep the implementation and the
human-facing `README.md` contract synchronized.

## PostgreSQL and Diesel

- PostgreSQL is the only supported database.
- Use Diesel and `diesel-async`; do not add another ORM or raw database client
  for ordinary queries.
- Put shared connection and database infrastructure in `soulcloud-core`.
- Put all migrations in the repository-level `migrations/` directory and keep
  `diesel.toml` aligned with generated schema locations.
- Every schema change requires a forward and reversible migration unless a
  reversal would be unsafe; document any intentionally irreversible migration.
- Model tenant ownership and authorization explicitly once their relationships
  are agreed. Never rely only on API filtering for tenant isolation.
- Prefer transactions for multi-record state transitions. Design worker
  ingestion and OTA processing to tolerate MQTT redelivery.

The local PostgreSQL service is defined in `compose.yaml` and is development
only. Start it with:

```sh
docker compose up -d --wait postgres
```

Do not run `docker compose down --volumes` unless the user explicitly requests
erasing local database data.

## Rust conventions

- Use the workspace's Rust edition, MSRV, dependencies, and lint settings.
- `unsafe` code is forbidden.
- Use typed `thiserror` enums at configuration, transport, database, and service
  boundaries. Do not add `anyhow`; callers must be able to distinguish errors.
- Retain underlying errors as `#[source]` where practical. Box unusually large
  source errors rather than weakening lint settings.
- Avoid `unwrap`, `expect`, and panics in runtime paths. An `unreachable!` is
  acceptable only directly after exhaustive validation makes the state
  impossible.
- Use `tracing` rather than printing. Never log passwords, tokens, complete OTA
  secrets, or raw device payloads by default.
- Keep public shared APIs documented, including `# Errors` sections for
  fallible functions.
- Add unit tests for topic parsing, validation, state transitions, and other
  deterministic logic. Add database integration tests when schema behavior is
  introduced.

Prefer workspace dependencies in the root `Cargo.toml`. Before adding a crate,
confirm that the existing stack cannot provide the capability and use a current,
compatible release. Keep features narrow, especially for network and database
crates.

## Configuration

Configuration is supplied through environment variables. Update `.env.example`
and `README.md` whenever variables are added, removed, renamed, or their meaning
changes. Required values should fail startup with a typed, actionable error;
security-sensitive production values must not receive convenient defaults.

The checked-in `.env.example` contains examples only. Never commit `.env`, real
credentials, private keys, device tokens, or customer data.

## Required validation

Run these commands after code changes:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

For database or API changes, also start local PostgreSQL and verify both health
endpoints:

```text
GET /health/live
GET /health/ready
```

For MQTT changes, test both direct WebSocket and HTTP-proxy configuration paths
when suitable local infrastructure exists. If an external broker or proxy is
not available, say exactly which path was not exercised.

## Documentation and change discipline

Keep `README.md`, `.env.example`, migrations, and tests synchronized with code.
Do not claim that an unresolved product area is implemented merely because a
table, placeholder, or endpoint exists. Report validation performed and any
untested external integration clearly in the handoff.
