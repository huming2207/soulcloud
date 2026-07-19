CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(64) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    email VARCHAR(254) NOT NULL UNIQUE,
    CONSTRAINT users_username_not_blank CHECK (btrim(username) <> ''),
    CONSTRAINT users_password_hash_not_blank CHECK (btrim(password_hash) <> ''),
    CONSTRAINT users_email_not_blank CHECK (btrim(email) <> '')
);

CREATE TABLE organisations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    website_url TEXT NOT NULL,
    CONSTRAINT organisations_name_not_blank CHECK (btrim(name) <> ''),
    CONSTRAINT organisations_website_url_not_blank CHECK (btrim(website_url) <> '')
);

CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    CONSTRAINT projects_name_not_blank CHECK (btrim(name) <> '')
);

CREATE TABLE organisation_users (
    organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (organisation_id, user_id)
);

CREATE INDEX organisation_users_user_id_idx
    ON organisation_users (user_id);

CREATE TABLE organisation_projects (
    organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    PRIMARY KEY (organisation_id, project_id)
);

CREATE INDEX organisation_projects_project_id_idx
    ON organisation_projects (project_id);

CREATE TABLE devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_uid VARCHAR(128) NOT NULL UNIQUE,
    assigned_id VARCHAR(128) NOT NULL,
    password_hash TEXT NOT NULL,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    CONSTRAINT devices_device_uid_not_blank CHECK (btrim(device_uid) <> ''),
    CONSTRAINT devices_assigned_id_not_blank CHECK (btrim(assigned_id) <> ''),
    CONSTRAINT devices_password_hash_not_blank CHECK (btrim(password_hash) <> ''),
    CONSTRAINT devices_project_assigned_id_unique UNIQUE (project_id, assigned_id)
);
