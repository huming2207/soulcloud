# Database migrations

Diesel migrations live in this directory and are shared by both deployable
services. The initial schema defines users, organisations, projects, devices,
and the agreed membership relationships. Later migrations add durable command
batches, per-device queue rows, monotonically allocated device sequences, and
validated terminal result storage.

The command execution-envelope migration intentionally refuses to run when
legacy `device_commands` rows exist. Those rows contain the old `{cmd,args}`
packet and cannot be safely rewritten with the original per-device UUID and
sequence. Operators must resolve legacy development rows explicitly rather
than having the migration silently publish invalid work or delete it.

OTA state, log payloads, fleet membership, authentication flows, and ACL rules
remain unspecified.
