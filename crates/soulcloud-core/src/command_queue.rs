//! Durable `PostgreSQL` queue for platform-to-device generic commands.

use std::{collections::HashSet, time::Duration};

use chrono::{DateTime, Utc};
use diesel::{
    ExpressionMethods as _, OptionalExtension as _, QueryDsl as _, QueryableByName,
    pg::Pg,
    sql_types::{Binary, Int4, Text, Uuid as SqlUuid},
};
use diesel_async::{AsyncConnection as _, RunQueryDsl as _};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    database::DbPool,
    models::{NewCommandBatch, NewDeviceCommand},
    mqtt_command::{
        self, CommandPayloadError, DeviceCommand, DeviceCommandExecution, DeviceCommandResult,
    },
    mqtt_topic,
    schema::{command_batches, device_commands, devices},
};

const QUEUED: &str = "queued";
const LEASED: &str = "leased";
const BROKER_ACCEPTED: &str = "broker_accepted";
const DEVICE_COMPLETED: &str = "device_completed";

/// The durable batch created for one API request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnqueuedBatch {
    /// Stable identifier for tracking the batch.
    pub id: Uuid,
    /// Number of per-device commands created.
    pub device_count: i32,
}

/// One command exclusively leased to a worker for MQTT publication.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeasedCommand {
    /// Stable database identifier for the per-device command.
    pub id: Uuid,
    /// Hardware-facing UID used in the MQTT topic.
    pub device_uid: String,
    /// Validated, encoded generic command payload.
    pub payload: Vec<u8>,
    /// Number of times this row has been leased, including this lease.
    pub attempt_count: i32,
}

struct PendingCommand {
    id: Uuid,
    device_id: Uuid,
    sequence: i64,
    payload: Vec<u8>,
}

/// Outcome of idempotently recording a device's terminal command result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResultRecordOutcome {
    /// This result completed the database command row.
    Recorded,
    /// The same semantic result had already been recorded.
    AlreadyRecorded,
}

/// Errors from the durable device-command queue.
#[derive(Debug, Error)]
pub enum CommandQueueError {
    /// No target devices were supplied.
    #[error("a command batch must target at least one device")]
    EmptyTargets,

    /// At least one device appeared more than once.
    #[error("a command batch contains duplicate device IDs")]
    DuplicateTargets,

    /// The target list cannot be represented by the database schema.
    #[error("the command batch contains too many target devices")]
    TooManyTargets,

    /// Registered target devices were not found.
    #[error("command target devices do not exist: {0:?}")]
    MissingTargets(Vec<Uuid>),

    /// A registered device UID cannot safely form an MQTT topic.
    #[error("device {device_id} has an invalid MQTT device UID")]
    InvalidDeviceUid {
        /// Internal device ID with the invalid UID.
        device_id: Uuid,
    },

    /// A device's sequence counter cannot be represented on the MQTT wire.
    #[error("device {device_id} command sequence is outside the supported range")]
    InvalidSequence {
        /// Device whose sequence could not be allocated.
        device_id: Uuid,
    },

    /// The requested lease duration overflowed the system clock.
    #[error("command lease expiry is outside the supported system time range")]
    LeaseTimeOverflow,

    /// A command was no longer in the state required by an update.
    #[error("device command {command_id} is no longer leased")]
    LeaseConflict {
        /// Command whose lease changed concurrently.
        command_id: Uuid,
    },

    /// A result did not match the command's target device or sequence.
    #[error("result does not match device command {command_id}")]
    ResultMismatch {
        /// Command referenced by the result.
        command_id: Uuid,
    },

    /// A completed command received a different terminal result.
    #[error("device command {command_id} already has a different result")]
    ConflictingResult {
        /// Command referenced by the conflicting result.
        command_id: Uuid,
    },

    /// A stored result packet failed the shared decoder.
    #[error("stored result for device command {command_id} is invalid")]
    InvalidStoredResult {
        /// Command whose stored packet was invalid.
        command_id: Uuid,
        /// Decoder failure.
        #[source]
        source: CommandPayloadError,
    },

    /// A completed row is missing its required stored result packet.
    #[error("stored result for device command {command_id} is missing")]
    MissingStoredResult {
        /// Command whose packet was missing.
        command_id: Uuid,
    },

    /// A `PostgreSQL` pool connection could not be acquired.
    #[error("failed to acquire PostgreSQL connection: {0}")]
    AcquireConnection(String),

    /// A queue query failed.
    #[error("device command queue query failed")]
    Query(#[source] diesel::result::Error),
}

impl From<diesel::result::Error> for CommandQueueError {
    fn from(source: diesel::result::Error) -> Self {
        Self::Query(source)
    }
}

/// Atomically snapshots explicit device targets and creates one queued command per device.
///
/// The command is encoded with the shared generic-command codec before it is
/// stored. Fleet selection is intentionally outside this function; callers
/// must resolve the exact device IDs before enqueueing.
///
/// # Errors
///
/// Returns [`CommandQueueError`] when the targets are empty, duplicated,
/// missing, unsuitable for MQTT topics, or when `PostgreSQL` cannot create the
/// batch atomically.
pub async fn enqueue_batch(
    pool: &DbPool,
    target_device_ids: &[Uuid],
    command: &DeviceCommand,
) -> Result<EnqueuedBatch, CommandQueueError> {
    if target_device_ids.is_empty() {
        return Err(CommandQueueError::EmptyTargets);
    }

    let unique_ids: HashSet<_> = target_device_ids.iter().copied().collect();
    if unique_ids.len() != target_device_ids.len() {
        return Err(CommandQueueError::DuplicateTargets);
    }

    let device_count =
        i32::try_from(target_device_ids.len()).map_err(|_| CommandQueueError::TooManyTargets)?;
    let batch_id = Uuid::new_v4();

    let mut connection = pool
        .get()
        .await
        .map_err(|error| CommandQueueError::AcquireConnection(error.to_string()))?;

    connection
        .transaction::<_, CommandQueueError, _>(async move |connection| {
            let targets =
                diesel::update(devices::table.filter(devices::id.eq_any(target_device_ids)))
                    .set(devices::next_command_sequence.eq(devices::next_command_sequence + 1))
                    .returning((
                        devices::id,
                        devices::device_uid,
                        devices::next_command_sequence,
                    ))
                    .load::<(Uuid, String, i64)>(&mut *connection)
                    .await?;

            if targets.len() != target_device_ids.len() {
                let found: HashSet<_> = targets.iter().map(|device| device.0).collect();
                let missing = target_device_ids
                    .iter()
                    .filter(|id| !found.contains(id))
                    .copied()
                    .collect();
                return Err(CommandQueueError::MissingTargets(missing));
            }

            for target in &targets {
                if mqtt_topic::command_execution(&target.1).is_err() {
                    return Err(CommandQueueError::InvalidDeviceUid {
                        device_id: target.0,
                    });
                }
            }

            diesel::insert_into(command_batches::table)
                .values(NewCommandBatch {
                    id: batch_id,
                    device_count,
                })
                .execute(&mut *connection)
                .await?;

            let pending: Vec<_> = targets
                .iter()
                .map(|target| {
                    let sequence = target.2 - 1;
                    let wire_sequence = u64::try_from(sequence).map_err(|_| {
                        CommandQueueError::InvalidSequence {
                            device_id: target.0,
                        }
                    })?;
                    let id = Uuid::new_v4();
                    let execution = DeviceCommandExecution {
                        id,
                        seq: wire_sequence,
                        command: command.clone(),
                    };
                    Ok(PendingCommand {
                        id,
                        device_id: target.0,
                        sequence,
                        payload: mqtt_command::encode_device_command_execution(&execution),
                    })
                })
                .collect::<Result<_, CommandQueueError>>()?;

            let rows: Vec<_> = pending
                .iter()
                .map(|pending| NewDeviceCommand {
                    id: pending.id,
                    batch_id,
                    device_id: pending.device_id,
                    sequence: pending.sequence,
                    payload: &pending.payload,
                    state: QUEUED,
                })
                .collect();

            diesel::insert_into(device_commands::table)
                .values(&rows)
                .execute(&mut *connection)
                .await?;

            Ok(EnqueuedBatch {
                id: batch_id,
                device_count,
            })
        })
        .await
}

#[derive(Debug, QueryableByName)]
#[diesel(check_for_backend(Pg))]
struct ClaimCandidate {
    #[diesel(sql_type = SqlUuid)]
    id: Uuid,
    #[diesel(sql_type = Binary)]
    payload: Vec<u8>,
    #[diesel(sql_type = Int4)]
    attempt_count: i32,
    #[diesel(sql_type = Text)]
    device_uid: String,
}

/// Leases the oldest eligible command while preserving per-device queue order.
///
/// Concurrent workers use `FOR UPDATE SKIP LOCKED`. A later command for a
/// device remains blocked while that device has an older row awaiting broker
/// acceptance or a terminal device result.
///
/// # Errors
///
/// Returns [`CommandQueueError`] if the lease expiry cannot be represented or
/// `PostgreSQL` cannot claim the row atomically.
pub async fn lease_next(
    pool: &DbPool,
    lease_duration: Duration,
) -> Result<Option<LeasedCommand>, CommandQueueError> {
    let lease_milliseconds = i64::try_from(lease_duration.as_millis())
        .map_err(|_| CommandQueueError::LeaseTimeOverflow)?;
    let mut connection = pool
        .get()
        .await
        .map_err(|error| CommandQueueError::AcquireConnection(error.to_string()))?;

    connection
        .transaction::<_, CommandQueueError, _>(async move |connection| {
            let candidate = diesel::sql_query(
                "SELECT dc.id, dc.payload, dc.attempt_count, d.device_uid \
                     FROM device_commands dc \
                     INNER JOIN devices d ON d.id = dc.device_id \
                     WHERE dc.available_at <= now() \
                       AND (dc.state = 'queued' \
                            OR (dc.state = 'leased' AND dc.lease_expires_at <= now())) \
                       AND NOT EXISTS ( \
                           SELECT 1 FROM device_commands earlier \
                           WHERE earlier.device_id = dc.device_id \
                             AND earlier.state IN ('queued', 'leased', 'broker_accepted') \
                             AND (earlier.created_at, earlier.id) < (dc.created_at, dc.id) \
                       ) \
                     ORDER BY dc.created_at, dc.id \
                     FOR UPDATE OF dc SKIP LOCKED \
                     LIMIT 1",
            )
            .get_result::<ClaimCandidate>(&mut *connection)
            .await
            .optional()?;

            let Some(candidate) = candidate else {
                return Ok(None);
            };

            diesel::sql_query(
                "UPDATE device_commands \
                 SET state = 'leased', \
                     lease_expires_at = now() + ($2 * interval '1 millisecond'), \
                     broker_accepted_at = NULL, \
                     attempt_count = attempt_count + 1 \
                 WHERE id = $1",
            )
            .bind::<SqlUuid, _>(candidate.id)
            .bind::<diesel::sql_types::BigInt, _>(lease_milliseconds)
            .execute(&mut *connection)
            .await?;

            Ok(Some(LeasedCommand {
                id: candidate.id,
                device_uid: candidate.device_uid,
                payload: candidate.payload,
                attempt_count: candidate.attempt_count + 1,
            }))
        })
        .await
}

/// Marks a leased command as accepted by the MQTT broker after its `QoS` 1 PUBACK.
///
/// # Errors
///
/// Returns [`CommandQueueError::LeaseConflict`] if the command is no longer
/// leased, or another [`CommandQueueError`] if `PostgreSQL` cannot update it.
pub async fn mark_broker_accepted(
    pool: &DbPool,
    command_id: Uuid,
) -> Result<(), CommandQueueError> {
    let mut connection = pool
        .get()
        .await
        .map_err(|error| CommandQueueError::AcquireConnection(error.to_string()))?;
    let updated = diesel::update(
        device_commands::table
            .filter(device_commands::id.eq(command_id))
            .filter(device_commands::state.eq(LEASED)),
    )
    .set((
        device_commands::state.eq(BROKER_ACCEPTED),
        device_commands::lease_expires_at.eq(Option::<DateTime<Utc>>::None),
        device_commands::broker_accepted_at.eq(Some(Utc::now())),
    ))
    .execute(&mut connection)
    .await?;

    if updated == 1 {
        return Ok(());
    }

    let state = device_commands::table
        .find(command_id)
        .select(device_commands::state)
        .first::<String>(&mut connection)
        .await
        .optional()?;
    if matches!(state.as_deref(), Some(BROKER_ACCEPTED | DEVICE_COMPLETED)) {
        Ok(())
    } else {
        Err(CommandQueueError::LeaseConflict { command_id })
    }
}

/// Releases a command lease after publication could not be queued locally.
///
/// # Errors
///
/// Returns [`CommandQueueError::LeaseConflict`] if the command is no longer
/// leased, or another [`CommandQueueError`] if `PostgreSQL` cannot update it.
pub async fn release_lease(pool: &DbPool, command_id: Uuid) -> Result<(), CommandQueueError> {
    let mut connection = pool
        .get()
        .await
        .map_err(|error| CommandQueueError::AcquireConnection(error.to_string()))?;
    let updated = diesel::update(
        device_commands::table
            .filter(device_commands::id.eq(command_id))
            .filter(device_commands::state.eq(LEASED)),
    )
    .set((
        device_commands::state.eq(QUEUED),
        device_commands::available_at.eq(Utc::now()),
        device_commands::lease_expires_at.eq(Option::<DateTime<Utc>>::None),
        device_commands::broker_accepted_at.eq(Option::<DateTime<Utc>>::None),
    ))
    .execute(&mut connection)
    .await?;

    if updated == 1 {
        Ok(())
    } else {
        Err(CommandQueueError::LeaseConflict { command_id })
    }
}

/// Idempotently records a validated terminal result from the target device.
///
/// A result also proves that the broker accepted the command, so this transition
/// may complete a queued or leased row if the result races the worker's PUBACK
/// handling. Later commands for the same device become eligible only after this
/// transition.
///
/// # Errors
///
/// Returns [`CommandQueueError::ResultMismatch`] if the ID, sequence, or device
/// UID does not identify the same command. A semantically different second
/// result returns [`CommandQueueError::ConflictingResult`].
pub async fn record_device_result(
    pool: &DbPool,
    device_uid: &str,
    result: &DeviceCommandResult,
    packet: &[u8],
) -> Result<ResultRecordOutcome, CommandQueueError> {
    let sequence = i64::try_from(result.seq).map_err(|_| CommandQueueError::ResultMismatch {
        command_id: result.id,
    })?;
    let mut connection = pool
        .get()
        .await
        .map_err(|error| CommandQueueError::AcquireConnection(error.to_string()))?;

    connection
        .transaction::<_, CommandQueueError, _>(async move |connection| {
            let stored = device_commands::table
                .inner_join(devices::table)
                .filter(device_commands::id.eq(result.id))
                .select((
                    device_commands::sequence,
                    device_commands::state,
                    device_commands::result_packet,
                    devices::device_uid,
                ))
                .for_update()
                .first::<(i64, String, Option<Vec<u8>>, String)>(&mut *connection)
                .await
                .optional()?
                .ok_or(CommandQueueError::ResultMismatch {
                    command_id: result.id,
                })?;

            if stored.0 != sequence || stored.3 != device_uid {
                return Err(CommandQueueError::ResultMismatch {
                    command_id: result.id,
                });
            }

            if stored.1 == DEVICE_COMPLETED {
                let stored_packet = stored.2.ok_or(CommandQueueError::MissingStoredResult {
                    command_id: result.id,
                })?;
                let stored_result = mqtt_command::decode_device_command_result(&stored_packet)
                    .map_err(|source| CommandQueueError::InvalidStoredResult {
                        command_id: result.id,
                        source,
                    })?;
                return if stored_result == *result {
                    Ok(ResultRecordOutcome::AlreadyRecorded)
                } else {
                    Err(CommandQueueError::ConflictingResult {
                        command_id: result.id,
                    })
                };
            }

            if !matches!(stored.1.as_str(), QUEUED | LEASED | BROKER_ACCEPTED) {
                return Err(CommandQueueError::ResultMismatch {
                    command_id: result.id,
                });
            }

            let now = Utc::now();
            diesel::update(device_commands::table.find(result.id))
                .set((
                    device_commands::state.eq(DEVICE_COMPLETED),
                    device_commands::lease_expires_at.eq(Option::<DateTime<Utc>>::None),
                    device_commands::broker_accepted_at.eq(Some(now)),
                    device_commands::result_code.eq(Some(result.code)),
                    device_commands::result_packet.eq(Some(packet)),
                    device_commands::device_completed_at.eq(Some(now)),
                ))
                .execute(&mut *connection)
                .await?;

            Ok(ResultRecordOutcome::Recorded)
        })
        .await
}
