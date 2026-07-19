# Binary log storage proposal

Status: design proposal only. This document does not define an implemented
Soulcloud schema, MQTT payload contract, or retention policy.

## Context confirmed from on9log

This proposal is based on the current sources for:

- the `on9log` firmware component;
- the `on9log-protocol` host crate;
- the `on9log-capture` host crate.

An on9log packet has an 18-byte little-endian header followed by a compact
binary payload. The header contains packet type, level, wrapping 16-bit
sequence, milliseconds since boot, `tag_id`, `fmt_id`, and payload length.
Format and tag IDs are addresses that must be resolved against the matching
firmware ELF. The same numeric address may mean something different in another
firmware build.

The UART path adds typed SLIP framing and CRC. Non-UART sinks such as MQTT or
WebSocket receive the raw on9log packet without that serial framing. The current
`on9log-capture` SQLite store already demonstrates the important separation:
capture raw binary first without an ELF, then decode later with the matching
ELF.

## Recommendation

Keep the raw on9log packet as the source of truth. Parse only the fixed header
on ingestion, and do not turn every message into rendered text before storing
it.

The recommended long-term design is:

1. Store immutable, compressed batches of raw packets in object storage.
2. Store session, segment, firmware-build, time-range, sequence-range and object
   location metadata in PostgreSQL.
3. Keep a limited hot window of per-packet index rows in PostgreSQL only when
   interactive filtering requires them.
4. Import the exact ELF once per firmware build into an artifact-specific
   tag/format dictionary.
5. Decode on demand for individual results and asynchronously materialize a
   separate, rebuildable search projection when full-text search is required.

For an initial deployment with modest volume, PostgreSQL alone is reasonable:
store one raw packet per append-only row in a time-partitioned table. This is a
simpler first stage, not the desired indefinite archive format.

## Ingestion boundary

The Soulcloud worker should own the ingestion path:

- authenticate the device through the broker;
- derive the device identity from the authenticated MQTT principal, not from a
  device-supplied customer/project field;
- validate packet magic, header length, declared payload length and supported
  protocol version;
- record the host receive time;
- attach the current device, project, firmware artifact and boot-session IDs;
- preserve the complete raw header and payload;
- batch writes and apply explicit backpressure.

It should not resolve ELF strings or render human-readable output in the hot
ingestion path. Those operations require a firmware artifact and add CPU and
allocation cost. Instead, ingestion may mark a raw record as pending decode for
a bounded background task. Retaining raw data makes it possible to re-decode
old logs after an importer or decoder improvement.

MQTT should carry binary bytes directly. Do not Base64-encode packets or wrap
them in JSON; Base64 expands the payload and JSON adds parsing and allocation.

## Firmware identity is mandatory

Every log session must identify the exact firmware build. A version label such
as `1.2.0` is insufficient because two binaries with the same label can have
different addresses.

Prefer a cryptographic build identity such as the SHA-256 digest of the ELF or
a build ID embedded into both the firmware and its uploaded artifact record.
Soulcloud should reject or quarantine packets whose claimed build identity has
no registered decoding artifact.

The ELF should be uploaded once per distinct build, encrypted at rest, and
referenced by many sessions. Never store an ELF alongside every packet or
segment.

Future artifact metadata could include:

```text
firmware_artifact_id
project_id
build_id or ELF SHA-256
firmware version label
on9log wire version
ELF object-storage key
uploaded_at
```

The ELF contains format strings, tags, symbols and possibly debug information,
so its access should be narrower than ordinary log access.

## ELF import and dictionary

An ELF importer should run once for each registered firmware artifact. It must
associate every extracted value with that exact artifact; an address is not a
global identifier across builds.

The importer should extract only the recognised on9log tag and format-string
records, for example:

```text
(firmware_artifact_id, tag_id) -> tag string
(firmware_artifact_id, fmt_id) -> format string
```

It should not indiscriminately import all ELF strings, symbols, or DWARF debug
data. Those inputs can contain build-machine paths, source paths, credentials,
or unrelated implementation details. The importer should parse untrusted ELF
data without executing it and should retain the original artifact digest for
audit and repeatability.

Storing the extracted dictionary in PostgreSQL is useful even when the full ELF
is kept in object storage. The database can then resolve tags and format IDs
without fetching or reparsing the artifact for every query. Whether the full
ELF is initially stored in PostgreSQL or object storage remains a deployment
choice; it does not change the dictionary or log-event model.

## Boot sessions, ordering and duplicates

The current on9log sequence is 16-bit and wraps naturally; `time_ms` is also a
wrapping device-uptime value. Neither value is a globally unique event ID.

Introduce a boot/session identity outside the existing packet, for example in a
versioned MQTT batch envelope or a future BOOT packet. A session should carry:

```text
boot_session_id
device_id
firmware_artifact_id
worker_received_start
worker_received_end
first and last extended sequence
```

MQTT QoS 1 can redeliver messages. A batch envelope should therefore include a
device-generated or transport-generated batch ID plus record positions, making
deduplication possible without treating the wrapping on9log sequence as unique.
Until that envelope exists, duplicate suppression can only be heuristic.

Always retain both clocks:

- `received_at`: server/worker UTC time, used for cross-device queries;
- `device_time_ms`: uptime-relative time from the packet, used for ordering and
  timing within a boot session.

Do not infer wall-clock time solely from `device_time_ms`.

## PostgreSQL-only first stage

A future hot log table could be range-partitioned by `received_at` and contain
approximately:

```text
id
device_id
project_id
firmware_artifact_id
boot_session_id
received_at
device_time_ms
sequence
sequence_epoch
packet_type
level
tag_id
fmt_id
raw_packet BYTEA
```

This is intentionally not a migration proposal yet. The boot identity,
firmware-artifact contract, retention period and expected ingest volume must be
settled first.

Useful indexes would normally be limited to query paths that are actually used:

- B-tree on `(device_id, received_at DESC)`;
- B-tree on `(project_id, received_at DESC)`;
- B-tree on `(firmware_artifact_id, tag_id, received_at DESC)` if tag filtering
  is required;
- BRIN on `received_at` for large time-ordered partitions.

Avoid indexing payload bytes, rendered messages or every header field. Drop old
partitions as a unit according to retention policy rather than deleting rows
individually.

Bulk insert batches instead of committing one transaction per MQTT packet.
PostgreSQL row overhead eventually becomes significant compared with on9log's
small packets, which is the point at which raw payloads should move to object
segments.

## Object-storage archive

The archive format should be a small, versioned, replayable container—not a
collection of individual packet objects and not one SQLite database per device.

A segment can contain:

```text
segment magic and format version
device_id
firmware_artifact_id
boot_session_id
start received_at
compression codec
repeated records:
    receive-time delta
    record kind
    packet length
    raw packet bytes
```

Length-prefixing preserves packet boundaries without carrying UART SLIP and CRC
overhead. Compress a batch, not each packet individually. Zstandard is a likely
candidate because repeated headers, tags and format IDs across a segment should
compress well, but codec and target segment size require measurement with real
captures before being fixed.

PostgreSQL would retain a segment manifest:

```text
segment_id
boot_session_id
object_key
received_at range
first and last sequence information
packet count
uncompressed and compressed sizes
content digest
storage state
```

Use immutable device and session IDs in object keys. Do not embed mutable
organisation, project or friendly device names in object paths.

## Tag, template and full-text search

`tag_id` and `fmt_id` are only meaningful together with
`firmware_artifact_id`. Never build a global tag index on the numeric address
alone.

The design has three representations with different purposes:

```text
firmware_log_strings
    one tag or format string per firmware artifact and address

raw_log_events
    one immutable binary packet plus trusted envelope metadata per event

decoded_log_search
    optional, rebuildable decoded text and search data for a raw event
```

The dictionary supports efficient tag filtering and searches for static format
text without duplicating that text for every event. For example, a search for
`connection failed` can first find matching `(firmware_artifact_id, fmt_id)`
pairs in the imported format dictionary, then join those pairs to raw log
events. This will find events emitted from a template such as
`connection to %s failed`.

This alone cannot search dynamic arguments. Given that template and an argument
of `factory-ap`, the raw payload is required to render `connection to
factory-ap failed`. Searching for `factory-ap` therefore needs a per-event
derived representation.

When dynamic-value search is a product requirement, a background decoder should
write a separate, disposable search row approximately like:

```text
log_event_id
decoder_version
tag
rendered_message
search_vector
decoded_at
decode_status
```

`raw_log_events` remains the source of truth. The search row can be deleted,
backfilled after an ELF upload, or rebuilt after a decoder change. A failed or
not-yet-possible decode must be visible as a status rather than silently
omitting the event from diagnostic results.

Use ordinary indexed columns for device, project, artifact, log level, tag,
session, and time-range filters. For rendered message text, PostgreSQL
full-text search with a `tsvector` column and a GIN index is the appropriate
initial option; PostgreSQL documents GIN as its [preferred full-text index
type](https://www.postgresql.org/docs/current/textsearch-indexes.html).
The `simple` text-search configuration is a reasonable candidate for technical
logs because it does not apply language stemming, but its handling of real
identifiers and error codes must be tested before it is selected.

Full-text search is token-oriented. Exact error codes, hexadecimal fragments,
partial identifiers, arbitrary substrings, and typo-tolerant search may need a
separate `pg_trgm` index on the derived rendered message. PostgreSQL documents
that its [trigram indexes](https://www.postgresql.org/docs/current/pgtrgm.html)
support indexed `LIKE`, `ILIKE`, and regular-expression searches. This is
complementary to, not a replacement for, full-text search.

The text projection increases write volume and storage. Its retention window,
whether it includes all log levels, and which dynamic fields are searchable are
product and privacy decisions that must be made before implementation. A
possible policy is to retain only a recent searchable window while preserving
the raw archive for later authorized decoding; no duration is proposed here.

All searches must be scoped to projects the caller is authorized to access
before returning matches, snippets, tag names, or search suggestions. Decoded
arguments can contain the same sensitive information as raw payloads and need
the same ACL, export, retention, and deletion rules.

## BUFFER, text and diagnostic records

`ON9LOG_PKT_BUFFER` can span multiple packets. Preserve the chunks individually
with their total length and offset, then reassemble during decoding. Do not put
large reconstructed buffers into ordinary log-index columns.

If Soulcloud also accepts the current capture tool's plain-text and deframer
diagnostic outcomes, use an explicit record kind and store their raw bytes or
diagnostic code. Do not coerce arbitrary plain-text bytes to UTF-8 at ingestion.

## API and process responsibilities

- The worker validates, associates, batches and stores raw records.
- The worker or a bounded worker-owned background task performs derived decode
  and search-projection backfill. It does not block MQTT ingestion on decoding.
- The API authorizes human queries and returns raw-event metadata plus existing
  decoded results; it must not bypass project-level access controls when
  querying dictionaries or search projections.
- `on9log-protocol` should be reused as a library; Soulcloud should not create a
  second parser for the same packet format.
- PostgreSQL `LISTEN`/`NOTIFY` may wake a decoder or announce a completed
  session or segment, but should not carry every log packet, raw payload, or
  act as the durable job queue.
- Redis or another streaming system should only be introduced when measured
  live-tail fanout or ingestion pressure justifies it.

## Security and retention

Binary logging is compact, not automatically safe. Dynamic strings and buffer
dumps can contain credentials, personal data or customer payloads.

Before implementation, define:

- per-project log retention;
- who may upload or download an ELF;
- who may decode or export logs;
- encryption and object-deletion behavior;
- maximum packet, batch, buffer-dump and per-device ingest rates;
- whether project/organisation access follows current membership or the
  membership that existed when the log was captured.

Rate limits and retention must be enforced independently of device requests so
a faulty device cannot fill the database or object store indefinitely.

## Suggested rollout

1. Define firmware build identity, boot-session identity and the binary MQTT
   batch envelope.
2. Add PostgreSQL firmware-artifact, session and partitioned hot-event schemas.
3. Ingest raw packets and decode on demand through `on9log-protocol`.
4. Measure real packet sizes, ingest rates, compression ratios and query usage.
5. Add object-storage segments and hot-data expiry when measurements justify
   the additional infrastructure.
6. Import ELF tag and format dictionaries for artifact-specific tag and template
   search.
7. Add an asynchronous decoded full-text projection only if product queries
   require searches over dynamic arguments.

This sequence keeps the first implementation compatible with the present
PostgreSQL-only architecture while preserving a clean path to efficient long-
term retention.
