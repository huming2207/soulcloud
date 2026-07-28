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
until justified by an actual IPC or scaling requirement. Generic commands use
`command_batches` and per-device `device_commands` as their durable domain
records and initial outbox. Workers recover by polling and leasing rows;
PostgreSQL `LISTEN`/`NOTIFY` may later provide transient wake-ups, but consumers
must still recover from the durable rows.

## MQTT contract

Device transport is MQTT over WebSocket only. The worker must reject broker URLs
that are not `ws://` or `wss://`. Preserve optional HTTP CONNECT proxy support
for restricted corporate networks and WSS on port 443.

For now, the MQTT broker owns username/password authentication. Manually
provisioned broker accounts are acceptable; Soulcloud does not yet create or
manage them. Never commit or log broker credentials.

The v1 topics are:

| Direction | Topic | Meaning |
| --- | --- | --- |
| Platform to device | `soulcloud/v1/devices/{dev_uid}/ota` | OTA command |
| Platform to device | `soulcloud/v1/devices/{dev_uid}/cmd/exec` | Execute a generic device command, such as reboot or logging control |
| Device to platform | `soulcloud/v1/devices/{dev_uid}/cmd/result` | Report a generic command execution result |
| Device to platform | `soulcloud/v1/devices/{dev_uid}/log` | Log events |
| Device to platform | `soulcloud/v1/devices/{dev_uid}/stat` | Presence, statistics, and firmware version |

Keep topic constants, construction, validation, and parsing in
`soulcloud-core::mqtt_topic`; do not scatter topic string literals through the
services. Preserve the platform-command/device-report direction split so the
worker does not consume its own outbound commands. The worker subscribes to
device-to-platform topics at QoS 1.

### Generic command payload (`cmd`)

The platform-to-device `soulcloud/v1/devices/{dev_uid}/cmd/exec` payload is
MessagePack. Use the shared `soulcloud-core::mqtt_command` types and codec;
do not add a service-local command schema or MessagePack encoder/decoder.

- The top-level value is a map containing only required `id`, `seq`, `cmd`, and
  optional `args`.
- `id` is exactly 16 MessagePack binary bytes containing the per-device command
  UUID.
- `seq` is an unsigned 64-bit monotonically increasing per-device sequence.
- `cmd` is required and must be a non-null string.
- `args` may be omitted or MessagePack `nil`; otherwise it is an array.
- Every `args` entry is a map with exactly one string argument-name key and a
  value of only `nil`, string, binary, signed/unsigned integer, float, or
  boolean.
- Reject unknown top-level fields, missing/null `cmd`, malformed argument maps,
  array, map, extension, or other unsupported argument values, and any trailing
  bytes after the one complete MessagePack value.

Keep the implementation and the human-facing `README.md` contract synchronized.

### Generic command result payload (`cmd/result`)

The device-to-platform `soulcloud/v1/devices/{dev_uid}/cmd/result` payload is
MessagePack and uses `soulcloud-core::mqtt_command`.

- The top-level map contains only required `id`, `seq`, `code`, and optional
  `payload`.
- `id` and `seq` exactly copy the execution envelope.
- `code` is a signed 32-bit C-style result: negative is failure, zero is
  successful completion without a scalar return code, and positive is a
  command-specific successful scalar value.
- Negative numbers belong to the stable Soulcloud error-number contract; never
  assume native platform errno numbers are portable on the wire.
- `payload` may be omitted or nil; otherwise it uses the same array of
  one-entry, string-keyed scalar maps as command `args`.
- Reject missing, null-required, duplicate, unknown, or wrongly typed fields,
  malformed payload entries, and trailing bytes.

### Generic command database path

`POST /v1/command-batches` accepts an explicit, non-empty, duplicate-free list
of internal device UUIDs and one shared `DeviceCommand`. The API validates all
targets and atomically inserts one batch plus one `device_commands` row per
device. Fleet/project/customer selectors remain undefined and must not be
invented; a future authorized API may resolve them to explicit device IDs.

The worker leases eligible rows with `FOR UPDATE SKIP LOCKED`, preserves
per-device ordering, and publishes one active command at a time to the
per-device `cmd/exec` topic with QoS 1. It marks a row `broker_accepted` only
after the matching PUBACK. Later commands for that device remain blocked until
a matching validated result transitions the row to `device_completed`.

The retained flag is required through `MQTT_COMMAND_RETAIN` until the final
policy is agreed. QoS 1 and lease recovery allow redelivery. The server
idempotently stores identical repeated results and rejects mismatched or
conflicting results. Exactly-once effects still require devices to persist
processed sequences and terminal results and to avoid repeating side effects.

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

Payload schemas for `ota` and `log`, the final retained-message policy, the
Soulcloud negative error-number registry, device-side deduplication storage, and
status persistence semantics remain undefined; do not choose them without an
agreed contract. Keep the implementation and the human-facing `README.md`
contract synchronized.

## PostgreSQL and Diesel

- PostgreSQL is the only supported durable database and remains the source of
  truth.
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
