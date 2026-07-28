// @generated automatically by Diesel CLI.

diesel::table! {
    /// Registered Soulcloud users.
    users (id) {
        id -> Uuid,
        username -> Varchar,
        password_hash -> Text,
        email -> Varchar,
    }
}

diesel::table! {
    /// API-created batches expanded into per-device MQTT commands.
    command_batches (id) {
        id -> Uuid,
        device_count -> Int4,
        created_at -> Timestamptz,
    }
}

diesel::table! {
    /// Durable per-device command queue consumed by MQTT workers.
    device_commands (id) {
        id -> Uuid,
        batch_id -> Uuid,
        device_id -> Uuid,
        sequence -> Int8,
        payload -> Bytea,
        state -> Varchar,
        attempt_count -> Int4,
        available_at -> Timestamptz,
        lease_expires_at -> Nullable<Timestamptz>,
        broker_accepted_at -> Nullable<Timestamptz>,
        result_code -> Nullable<Int4>,
        result_packet -> Nullable<Bytea>,
        device_completed_at -> Nullable<Timestamptz>,
        created_at -> Timestamptz,
    }
}

diesel::table! {
    /// Organisations such as companies or other account-owning groups.
    organisations (id) {
        id -> Uuid,
        name -> Varchar,
        website_url -> Text,
    }
}

diesel::table! {
    /// Projects that group devices and may be shared by organisations.
    projects (id) {
        id -> Uuid,
        name -> Varchar,
    }
}

diesel::table! {
    /// Devices registered with Soulcloud.
    devices (id) {
        id -> Uuid,
        device_uid -> Varchar,
        assigned_id -> Varchar,
        password_hash -> Text,
        project_id -> Uuid,
        next_command_sequence -> Int8,
    }
}

diesel::table! {
    /// Many-to-many membership between organisations and users.
    organisation_users (organisation_id, user_id) {
        organisation_id -> Uuid,
        user_id -> Uuid,
    }
}

diesel::table! {
    /// Many-to-many membership between organisations and projects.
    organisation_projects (organisation_id, project_id) {
        organisation_id -> Uuid,
        project_id -> Uuid,
    }
}

diesel::joinable!(devices -> projects (project_id));
diesel::joinable!(device_commands -> command_batches (batch_id));
diesel::joinable!(device_commands -> devices (device_id));
diesel::joinable!(organisation_projects -> organisations (organisation_id));
diesel::joinable!(organisation_projects -> projects (project_id));
diesel::joinable!(organisation_users -> organisations (organisation_id));
diesel::joinable!(organisation_users -> users (user_id));

diesel::allow_tables_to_appear_in_same_query!(
    command_batches,
    device_commands,
    devices,
    organisation_projects,
    organisation_users,
    organisations,
    projects,
    users,
);
