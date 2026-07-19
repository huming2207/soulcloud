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
diesel::joinable!(organisation_projects -> organisations (organisation_id));
diesel::joinable!(organisation_projects -> projects (project_id));
diesel::joinable!(organisation_users -> organisations (organisation_id));
diesel::joinable!(organisation_users -> users (user_id));

diesel::allow_tables_to_appear_in_same_query!(
    devices,
    organisation_projects,
    organisation_users,
    organisations,
    projects,
    users,
);
