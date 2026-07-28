CREATE TABLE command_batches (
    id UUID PRIMARY KEY,
    device_count INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT command_batches_device_count_positive CHECK (device_count > 0)
);

CREATE TABLE device_commands (
    id UUID PRIMARY KEY,
    batch_id UUID NOT NULL REFERENCES command_batches(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
    payload BYTEA NOT NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'queued',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_expires_at TIMESTAMPTZ,
    broker_accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT device_commands_batch_device_unique UNIQUE (batch_id, device_id),
    CONSTRAINT device_commands_state_valid
        CHECK (state IN ('queued', 'leased', 'broker_accepted')),
    CONSTRAINT device_commands_attempt_count_nonnegative CHECK (attempt_count >= 0),
    CONSTRAINT device_commands_lease_consistent CHECK (
        (state = 'leased' AND lease_expires_at IS NOT NULL)
        OR (state <> 'leased' AND lease_expires_at IS NULL)
    ),
    CONSTRAINT device_commands_broker_acceptance_consistent CHECK (
        (state = 'broker_accepted' AND broker_accepted_at IS NOT NULL)
        OR (state <> 'broker_accepted' AND broker_accepted_at IS NULL)
    )
);

CREATE INDEX device_commands_claim_idx
    ON device_commands (available_at, created_at, id)
    WHERE state IN ('queued', 'leased');

CREATE INDEX device_commands_device_pending_idx
    ON device_commands (device_id, created_at, id)
    WHERE state IN ('queued', 'leased');

CREATE INDEX device_commands_batch_state_idx
    ON device_commands (batch_id, state);
