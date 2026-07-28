# Soulcloud

Soulcloud is a Rust workspace for an IoT device-management platform. It starts
with two deployable processes and one internal shared library:

- `soulcloud-api`: human-facing REST API. It provides health endpoints and
  atomically expands explicit-device command batches into PostgreSQL rows.
- `soulcloud-worker`: device-facing MQTT worker. It only accepts MQTT over
  WebSocket (`ws://` or `wss://`), supports an optional HTTP CONNECT proxy, and
  publishes queued commands to per-device topics.
- `soulcloud-core`: shared, non-deployable PostgreSQL/Diesel and configuration
  foundations.

Both processes use the same PostgreSQL database through Diesel's asynchronous
PostgreSQL connection pool. Redis is not part of the current architecture.
Generic device commands use durable PostgreSQL rows as their domain records and
initial outbox. The worker recovers work by polling; `LISTEN`/`NOTIFY` is not
needed at the current scale and may be added later only as a wake-up hint.

## Initial database model

The first migration defines:

- users with unique usernames and emails plus password hashes;
- organisations with names and website URLs;
- many-to-many user/organisation and project/organisation memberships;
- projects;
- devices belonging to exactly one project, with a globally unique hardware
  `device_uid`, a project-scoped `assigned_id`, and a password hash.

The command-queue migration adds:

- `command_batches`, one durable record for an API batch request;
- `device_commands`, one MessagePack payload per target device, with queue,
  sequence, lease, attempt, broker-acceptance, and terminal-result metadata;
- a per-device counter used to allocate monotonic command sequences atomically.

Passwords are never stored as plaintext. The password hashing algorithms and
authentication flows remain to be designed before account or device login is
implemented.

The proposed storage architecture for compact ELF-dependent device logs is
documented in [`docs/binary-log-storage-proposal.md`](docs/binary-log-storage-proposal.md).
It is a proposal only; no log-ingestion schema has been implemented.

## MQTT v1 topics

The initial topic scheme keeps the device UID in one stable location and keeps
platform commands separate from device reports:

| Direction | Topic | Purpose |
| --- | --- | --- |
| Platform to device | `soulcloud/v1/devices/{dev_uid}/ota` | OTA command |
| Platform to device | `soulcloud/v1/devices/{dev_uid}/cmd/exec` | Execute a generic device command, such as reboot or logging control |
| Device to platform | `soulcloud/v1/devices/{dev_uid}/cmd/result` | Report a generic command execution result |
| Device to platform | `soulcloud/v1/devices/{dev_uid}/log` | Log events |
| Device to platform | `soulcloud/v1/devices/{dev_uid}/stat` | Presence, statistics, and firmware version |

The worker subscribes to the three device-to-platform topic filters at QoS 1 and
publishes generic commands at QoS 1. It leases the oldest eligible database row
with `FOR UPDATE SKIP LOCKED`, marks a row `broker_accepted` only after the MQTT
PUBACK, validates and stores terminal device results, and keeps later commands
for the same device blocked until the preceding result arrives. A crashed
worker's lease expires so another worker can publish the row again.

The command retained flag remains a deployment choice until the protocol
contract is finalized, so `MQTT_COMMAND_RETAIN` is required. The development
example uses `false` to avoid delivering stale commands to reconnecting devices.
The broker should eventually enforce the same direction rules with per-device
ACLs. The generic command execution/result and device `stat` payloads are
defined below. OTA and log payloads remain open.

For the initial deployment, the MQTT broker owns username/password
authentication. Broker accounts are provisioned manually through the broker's
administration mechanism; Soulcloud does not create or manage broker accounts.
The worker accepts a manually provisioned service account through
`MQTT_USERNAME` and `MQTT_PASSWORD`.

## Generic command MessagePack payload

To send a generic command, publish one MessagePack value to
`soulcloud/v1/devices/{dev_uid}/cmd/exec`. It is a map with the following
fields:

| Field | Required | Value |
| --- | --- | --- |
| `id` | Yes | Exactly 16 binary bytes containing the per-device command UUID. |
| `seq` | Yes | An unsigned 64-bit, monotonically increasing per-device sequence. |
| `cmd` | Yes | A non-null MessagePack string containing the command name. |
| `args` | No | MessagePack `nil`, or an array of argument maps. |

You can omit `args` when the command needs no parameters; `args: nil` means the
same thing. Otherwise, `args` is an ordered list of one-name argument maps.
Each map contains exactly one argument name and its value. Values can be null,
text, raw binary data, an integer or decimal number, or a boolean. Binary data
uses MessagePack's `bin` type, not an array of byte values. Nested objects,
lists, and MessagePack extensions are not supported for command arguments.

For example, the following JSON-like representation describes the wire shape;
the MQTT payload itself is MessagePack, not JSON:

```text
{
  id: <16 binary UUID bytes>,
  seq: 42,
  cmd: "someCommand",
  args: [
    {arg1: "foo"},
    {arg2: "bar"},
    {arg3: 67},
    {arg4: true},
    {arg5: null}
  ]
}
```

Messages with a missing, null, duplicate, or wrongly typed field; an ID that is
not exactly 16 binary bytes; an unknown top-level field; malformed arguments;
unsupported values; or bytes after the one complete MessagePack value are
invalid.

## Generic command result MessagePack payload

A device publishes one terminal result to
`soulcloud/v1/devices/{dev_uid}/cmd/result`:

| Field | Required | Value |
| --- | --- | --- |
| `id` | Yes | The exact 16 binary UUID bytes copied from `cmd/exec`. |
| `seq` | Yes | The unsigned sequence copied from `cmd/exec`. |
| `code` | Yes | A signed 32-bit C-style result code. |
| `payload` | No | MessagePack `nil`, or an array of named result maps. |

`code < 0` is failure, `code == 0` is successful completion without a scalar
return code, and `code > 0` is a command-specific successful scalar result such
as a count, length, or enum. Negative values use the stable Soulcloud error
number contract rather than assuming native platform errno numbers are
portable.

`payload` uses exactly the same one-name map and scalar value rules as `args`.
For example:

```text
{
  id: <16 binary UUID bytes>,
  seq: 42,
  code: 0,
  payload: [
    {"logging.enabled": true},
    {"logging.level": 3}
  ]
}
```

The result has no human diagnostic-message field; detailed diagnostics belong
in the log stream. Missing, duplicate, unknown, null-required, wrongly typed,
malformed, or trailing data is rejected before persistence.

## Device command API and delivery boundary

The unauthenticated scaffold currently exposes:

```text
POST /v1/command-batches
```

The JSON body snapshots an explicit list of internal device UUIDs and one
generic command:

```json
{
  "device_ids": [
    "0d6fd9c5-4dce-40f0-8e33-4c86d0351dd3",
    "c3ba66ad-e64d-4460-b504-6cd50dedcc3e"
  ],
  "command": {
    "cmd": "setLogging",
    "args": [
      {"enabled": true}
    ]
  }
}
```

The API validates that targets are non-empty, unique, registered, and safe for
MQTT topic construction. It then inserts one batch and one command per device
in a single transaction and returns `202 Accepted`:

```json
{
  "batch_id": "ef42ca5f-c035-40fa-88d5-3f08192bd7b5",
  "device_count": 2
}
```

Fleet/customer/project selectors are not exposed yet because their membership
and authorization contracts are still unresolved. A future authorized API can
resolve such a selector to device IDs and call the same atomic enqueue path.

`broker_accepted` means only that the MQTT broker returned the QoS 1 PUBACK.
`device_completed` means the worker validated a matching `cmd/result` ID,
sequence, and device UID and persisted its signed code and complete result
packet. Repeated identical results are idempotent; a mismatched or conflicting
result is rejected.

The API atomically allocates each target device's next sequence and embeds the
per-device command-row UUID and sequence in its own MessagePack packet. QoS 1
and expired-lease recovery can still redeliver that packet. Exactly-once side
effects therefore require the device to durably remember processed sequences
and their terminal results, and to replay the stored result rather than
executing a duplicate. Configuration storage should commit its applied sequence
atomically with the configuration change where possible.

## Device status MessagePack payload

Devices report their current status by publishing one MessagePack value to
`soulcloud/v1/devices/{dev_uid}/stat`. It is a map with all of these fields:

| Field | Value |
| --- | --- |
| `sn` | Chip-unique serial number as MessagePack binary (`bin`) data. |
| `fw` | Firmware hash as MessagePack binary (`bin`) data. |
| `up` | Uptime counter as an unsigned 64-bit integer. |
| `rst` | Reset reason as a string. |

For example, the following JSON-like representation describes the wire shape;
the MQTT payload itself is MessagePack, not JSON:

```text
{
  sn: <binary chip serial number>,
  fw: <binary firmware hash>,
  up: 4294967296,
  rst: "watchdog"
}
```

All four fields are required. Binary data must use MessagePack's `bin` type,
not a text string or an array of byte values. Unknown, missing, null, duplicate,
or incorrectly typed fields—and bytes after the one complete MessagePack
value—are invalid and will be rejected.

This is the current provisional status format. The serial-number byte layout,
firmware-hash algorithm and length, uptime units and clock semantics, reset
reason vocabulary, and status persistence behavior have not yet been defined.

## What is intentionally not defined yet

The requested product areas—OTA, tagged logs, permissions, device presence, and
statistics—need domain and protocol decisions before tables or endpoints can be
correctly designed. In particular, this scaffold does not guess:

- whether customer, project, and fleet form a strict hierarchy or overlap;
- device identity, enrollment, broker-account automation, or certificate
  rules;
- OTA and log payload encoding; the negative command-error registry,
  device-side deduplication persistence, and the final retained-message policy;
- OTA rollout states, artifact storage, signing, retry, and rollback behavior;
- ACL inheritance and tenant isolation rules;
- the exact definition of online, uptime, ping, and clock authority.

The worker validates the defined `stat` payload but does not persist it until
status storage semantics are agreed. It logs metadata for `log` publications
without decoding or persisting their still-unspecified payloads.

## Local commands

Copy `.env.example` to `.env`, replace every example value, and export the
variables into your shell. Then run:

```sh
docker compose up -d --wait postgres
cargo run -p soulcloud-core --example migrate
cargo run -p soulcloud-api
cargo run -p soulcloud-worker
```

The Compose database is for local development only. PostgreSQL binds only to
`127.0.0.1` and uses the development credentials shown in `.env.example`. Stop
it with `docker compose down`; add `--volumes` only when you intentionally want
to erase the local PostgreSQL database.

API health endpoints:

```text
GET /health/live
GET /health/ready
```

Worker command-queue settings:

```text
MQTT_COMMAND_RETAIN        required boolean retained flag
COMMAND_POLL_INTERVAL_MS   queue recovery poll interval (default 500)
COMMAND_LEASE_SECONDS      lease duration before crash recovery (default 60)
```

Quality checks:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Diesel migrations belong in `migrations/`. Install `diesel_cli` with only the
PostgreSQL feature if desired, or use the embedded migration example shown
above. Run the database integration test with `TEST_DATABASE_URL` set.
