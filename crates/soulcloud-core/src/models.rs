use diesel::{Associations, Identifiable, Insertable, Queryable, Selectable};
use uuid::Uuid;

use crate::schema::{
    devices, organisation_projects, organisation_users, organisations, projects, users,
};

#[derive(Queryable, Selectable, Identifiable)]
#[diesel(table_name = users)]
#[diesel(check_for_backend(diesel::pg::Pg))]
pub struct User {
    pub id: Uuid,
    pub username: String,
    pub password_hash: String,
    pub email: String,
}

#[derive(Insertable)]
#[diesel(table_name = users)]
pub struct NewUser<'a> {
    pub id: Uuid,
    pub username: &'a str,
    pub password_hash: &'a str,
    pub email: &'a str,
}

#[derive(Queryable, Selectable, Identifiable)]
#[diesel(table_name = organisations)]
#[diesel(check_for_backend(diesel::pg::Pg))]
pub struct Organisation {
    pub id: Uuid,
    pub name: String,
    pub website_url: String,
}

#[derive(Insertable)]
#[diesel(table_name = organisations)]
pub struct NewOrganisation<'a> {
    pub id: Uuid,
    pub name: &'a str,
    pub website_url: &'a str,
}

#[derive(Queryable, Selectable, Identifiable)]
#[diesel(table_name = projects)]
#[diesel(check_for_backend(diesel::pg::Pg))]
pub struct Project {
    pub id: Uuid,
    pub name: String,
}

#[derive(Insertable)]
#[diesel(table_name = projects)]
pub struct NewProject<'a> {
    pub id: Uuid,
    pub name: &'a str,
}

#[derive(Queryable, Selectable, Identifiable, Associations)]
#[diesel(table_name = devices)]
#[diesel(belongs_to(Project))]
#[diesel(check_for_backend(diesel::pg::Pg))]
pub struct Device {
    /// Soulcloud's immutable internal identifier.
    pub id: Uuid,
    /// Hardware-reported identifier, such as a canonical base MAC or chip ID.
    pub device_uid: String,
    /// Human-assigned identifier, unique within the device's project.
    pub assigned_id: String,
    pub password_hash: String,
    pub project_id: Uuid,
}

#[derive(Insertable)]
#[diesel(table_name = devices)]
pub struct NewDevice<'a> {
    pub id: Uuid,
    pub device_uid: &'a str,
    pub assigned_id: &'a str,
    pub password_hash: &'a str,
    pub project_id: Uuid,
}

#[derive(Queryable, Selectable, Identifiable, Associations)]
#[diesel(table_name = organisation_users)]
#[diesel(primary_key(organisation_id, user_id))]
#[diesel(belongs_to(Organisation))]
#[diesel(belongs_to(User))]
#[diesel(check_for_backend(diesel::pg::Pg))]
pub struct OrganisationUser {
    pub organisation_id: Uuid,
    pub user_id: Uuid,
}

#[derive(Insertable)]
#[diesel(table_name = organisation_users)]
pub struct NewOrganisationUser {
    pub organisation_id: Uuid,
    pub user_id: Uuid,
}

#[derive(Queryable, Selectable, Identifiable, Associations)]
#[diesel(table_name = organisation_projects)]
#[diesel(primary_key(organisation_id, project_id))]
#[diesel(belongs_to(Organisation))]
#[diesel(belongs_to(Project))]
#[diesel(check_for_backend(diesel::pg::Pg))]
pub struct OrganisationProject {
    pub organisation_id: Uuid,
    pub project_id: Uuid,
}

#[derive(Insertable)]
#[diesel(table_name = organisation_projects)]
pub struct NewOrganisationProject {
    pub organisation_id: Uuid,
    pub project_id: Uuid,
}
