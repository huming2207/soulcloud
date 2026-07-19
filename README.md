# Soulcloud

Soulcloud is a Rust workspace for an IoT device-management platform. It starts
with two deployable processes and one internal shared library:

- `soulcloud-api`: human-facing REST API. It currently provides liveness and
  PostgreSQL-backed readiness endpoints.
- `soulcloud-worker`: device-facing MQTT worker. It only accepts MQTT over
  WebSocket (`ws://` or `wss://`) and supports an optional HTTP CONNECT proxy.
- `soulcloud-core`: shared, non-deployable PostgreSQL/Diesel and configuration
  foundations.

Both processes use the same PostgreSQL database through Diesel's asynchronous
PostgreSQL connection pool. Redis is not part of the initial architecture.
PostgreSQL `LISTEN`/`NOTIFY` remains available for later cross-process event
notification, but no event names or payloads are defined before their contract
is known.

## Initial database model

The first migration defines:

- users with unique usernames and emails plus password hashes;
- organisations with names and website URLs;
- many-to-many user/organisation and project/organisation memberships;
- projects;
- devices belonging to exactly one project, with a globally unique hardware
  `device_uid`, a project-scoped `assigned_id`, and a password hash.

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
| Platform to device | `soulcloud/v1/devices/{dev_uid}/cmd` | Generic device command, such as reboot or logging control |
| Device to platform | `soulcloud/v1/devices/{dev_uid}/log` | Log events |
| Device to platform | `soulcloud/v1/devices/{dev_uid}/stat` | Presence, statistics, and firmware version |

The worker subscribes to the two device-to-platform topic filters at QoS 1.
The broker should eventually enforce the same direction rules with per-device
ACLs. Payload formats, command acknowledgements, and retained-message behavior
are deliberately still open.

## What is intentionally not defined yet

The requested product areas—OTA, tagged logs, permissions, device presence, and
statistics—need domain and protocol decisions before tables or endpoints can be
correctly designed. In particular, this scaffold does not guess:

- whether customer, project, and fleet form a strict hierarchy or overlap;
- device identity, enrollment, authentication, or certificate rules;
- MQTT payload encoding, command acknowledgments, and retained-message behavior;
- OTA rollout states, artifact storage, signing, retry, and rollback behavior;
- ACL inheritance and tenant isolation rules;
- the exact definition of online, uptime, ping, and clock authority.

The worker parses the v1 topic scheme and logs publication metadata without
decoding or persisting an unspecified payload.

## Local commands

Copy `.env.example` to `.env`, replace every example value, and export the
variables into your shell. Then run:

```sh
docker compose up -d postgres
cargo run -p soulcloud-core --example migrate
cargo run -p soulcloud-api
cargo run -p soulcloud-worker
```

The Compose database is for local development only. It pins PostgreSQL 18.3,
binds only to `127.0.0.1`, and uses the development credentials shown in
`.env.example`. Stop it with `docker compose down`; add `--volumes` only when
you intentionally want to erase the local database.

API health endpoints:

```text
GET /health/live
GET /health/ready
```

Quality checks:

```sh
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Diesel migrations belong in `migrations/`. Install `diesel_cli` with only the
PostgreSQL feature if desired, or use the embedded migration example shown
above. Run the database integration test with `TEST_DATABASE_URL` set.
