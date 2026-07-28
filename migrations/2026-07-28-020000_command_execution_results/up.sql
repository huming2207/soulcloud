DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM device_commands) THEN
        RAISE EXCEPTION
            'cannot add command execution IDs and sequences while legacy device_commands rows exist';
    END IF;
END
$$;

ALTER TABLE devices
    ADD COLUMN next_command_sequence BIGINT NOT NULL DEFAULT 1,
    ADD CONSTRAINT devices_next_command_sequence_positive
        CHECK (next_command_sequence > 0);

ALTER TABLE device_commands
    ADD COLUMN sequence BIGINT NOT NULL,
    ADD COLUMN result_code INTEGER,
    ADD COLUMN result_packet BYTEA,
    ADD COLUMN device_completed_at TIMESTAMPTZ;

ALTER TABLE device_commands
    ADD CONSTRAINT device_commands_sequence_positive CHECK (sequence > 0),
    ADD CONSTRAINT device_commands_device_sequence_unique UNIQUE (device_id, sequence);

ALTER TABLE device_commands
    DROP CONSTRAINT device_commands_state_valid,
    DROP CONSTRAINT device_commands_broker_acceptance_consistent;

ALTER TABLE device_commands
    ADD CONSTRAINT device_commands_state_valid
        CHECK (state IN ('queued', 'leased', 'broker_accepted', 'device_completed')),
    ADD CONSTRAINT device_commands_broker_acceptance_consistent CHECK (
        (
            state IN ('broker_accepted', 'device_completed')
            AND broker_accepted_at IS NOT NULL
        )
        OR (
            state NOT IN ('broker_accepted', 'device_completed')
            AND broker_accepted_at IS NULL
        )
    ),
    ADD CONSTRAINT device_commands_result_consistent CHECK (
        (
            state = 'device_completed'
            AND result_code IS NOT NULL
            AND result_packet IS NOT NULL
            AND device_completed_at IS NOT NULL
        )
        OR (
            state <> 'device_completed'
            AND result_code IS NULL
            AND result_packet IS NULL
            AND device_completed_at IS NULL
        )
    );

DROP INDEX device_commands_device_pending_idx;

CREATE INDEX device_commands_device_pending_idx
    ON device_commands (device_id, created_at, id)
    WHERE state IN ('queued', 'leased', 'broker_accepted');
