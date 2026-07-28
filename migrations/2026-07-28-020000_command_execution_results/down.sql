DROP INDEX device_commands_device_pending_idx;

ALTER TABLE device_commands
    DROP CONSTRAINT device_commands_result_consistent,
    DROP CONSTRAINT device_commands_broker_acceptance_consistent,
    DROP CONSTRAINT device_commands_state_valid,
    DROP CONSTRAINT device_commands_device_sequence_unique,
    DROP CONSTRAINT device_commands_sequence_positive;

UPDATE device_commands
SET
    state = 'broker_accepted',
    result_code = NULL,
    result_packet = NULL,
    device_completed_at = NULL
WHERE state = 'device_completed';

ALTER TABLE device_commands
    ADD CONSTRAINT device_commands_state_valid
        CHECK (state IN ('queued', 'leased', 'broker_accepted')),
    ADD CONSTRAINT device_commands_broker_acceptance_consistent CHECK (
        (state = 'broker_accepted' AND broker_accepted_at IS NOT NULL)
        OR (state <> 'broker_accepted' AND broker_accepted_at IS NULL)
    );

ALTER TABLE device_commands
    DROP COLUMN device_completed_at,
    DROP COLUMN result_packet,
    DROP COLUMN result_code,
    DROP COLUMN sequence;

ALTER TABLE devices
    DROP CONSTRAINT devices_next_command_sequence_positive,
    DROP COLUMN next_command_sequence;

CREATE INDEX device_commands_device_pending_idx
    ON device_commands (device_id, created_at, id)
    WHERE state IN ('queued', 'leased');
