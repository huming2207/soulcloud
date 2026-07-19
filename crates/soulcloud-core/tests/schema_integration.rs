use diesel::{ExpressionMethods as _, QueryDsl as _, SelectableHelper as _};
use diesel_async::{AsyncPgConnection, RunQueryDsl as _, SimpleAsyncConnection as _};
use soulcloud_core::{
    database, migration,
    models::{
        Device, NewDevice, NewOrganisation, NewOrganisationProject, NewOrganisationUser,
        NewProject, NewUser,
    },
    schema::{devices, organisation_projects, organisation_users, organisations, projects, users},
};
use uuid::Uuid;

#[derive(Clone, Copy)]
struct TestIds {
    user_one: Uuid,
    user_two: Uuid,
    organisation_one: Uuid,
    organisation_two: Uuid,
    project: Uuid,
    device: Uuid,
}

impl TestIds {
    fn random() -> Self {
        Self {
            user_one: Uuid::new_v4(),
            user_two: Uuid::new_v4(),
            organisation_one: Uuid::new_v4(),
            organisation_two: Uuid::new_v4(),
            project: Uuid::new_v4(),
            device: Uuid::new_v4(),
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn schema_supports_agreed_memberships_and_device_ownership() {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("skipping database integration test: TEST_DATABASE_URL is not set");
        return;
    };

    migration::run_pending_migrations(&database_url)
        .await
        .expect("test database migrations should succeed");
    let pool = database::create_pool(&database_url)
        .await
        .expect("test database pool should be created");
    let mut connection = pool
        .get()
        .await
        .expect("test database connection should be acquired");
    connection
        .batch_execute("BEGIN")
        .await
        .expect("test transaction should begin");

    let ids = TestIds::random();
    insert_entities(&mut connection, ids).await;
    insert_relationships(&mut connection, ids).await;
    assert_relationships(&mut connection, ids).await;

    connection
        .batch_execute("ROLLBACK")
        .await
        .expect("test transaction should roll back");
}

async fn insert_entities(connection: &mut AsyncPgConnection, ids: TestIds) {
    diesel::insert_into(users::table)
        .values(&[
            NewUser {
                id: ids.user_one,
                username: "schema-test-user-one",
                password_hash: "$test-hash-one",
                email: "schema-test-one@example.invalid",
            },
            NewUser {
                id: ids.user_two,
                username: "schema-test-user-two",
                password_hash: "$test-hash-two",
                email: "schema-test-two@example.invalid",
            },
        ])
        .execute(connection)
        .await
        .expect("users should be inserted");

    diesel::insert_into(organisations::table)
        .values(&[
            NewOrganisation {
                id: ids.organisation_one,
                name: "Schema Test Organisation One",
                website_url: "https://one.example.invalid",
            },
            NewOrganisation {
                id: ids.organisation_two,
                name: "Schema Test Organisation Two",
                website_url: "https://two.example.invalid",
            },
        ])
        .execute(connection)
        .await
        .expect("organisations should be inserted");

    diesel::insert_into(projects::table)
        .values(NewProject {
            id: ids.project,
            name: "Schema Test Project",
        })
        .execute(connection)
        .await
        .expect("project should be inserted");
}

async fn insert_relationships(connection: &mut AsyncPgConnection, ids: TestIds) {
    diesel::insert_into(organisation_users::table)
        .values(&[
            NewOrganisationUser {
                organisation_id: ids.organisation_one,
                user_id: ids.user_one,
            },
            NewOrganisationUser {
                organisation_id: ids.organisation_one,
                user_id: ids.user_two,
            },
            NewOrganisationUser {
                organisation_id: ids.organisation_two,
                user_id: ids.user_one,
            },
        ])
        .execute(connection)
        .await
        .expect("organisation memberships should be inserted");

    diesel::insert_into(organisation_projects::table)
        .values(&[
            NewOrganisationProject {
                organisation_id: ids.organisation_one,
                project_id: ids.project,
            },
            NewOrganisationProject {
                organisation_id: ids.organisation_two,
                project_id: ids.project,
            },
        ])
        .execute(connection)
        .await
        .expect("organisation project memberships should be inserted");

    diesel::insert_into(devices::table)
        .values(NewDevice {
            id: ids.device,
            device_uid: "7cdfa1123456",
            assigned_id: "foo1",
            password_hash: "$test-device-hash",
            project_id: ids.project,
        })
        .execute(connection)
        .await
        .expect("device should be inserted");
}

async fn assert_relationships(connection: &mut AsyncPgConnection, ids: TestIds) {
    let user_organisation_count = organisation_users::table
        .filter(organisation_users::user_id.eq(ids.user_one))
        .count()
        .get_result::<i64>(connection)
        .await
        .expect("user memberships should be queryable");
    assert_eq!(user_organisation_count, 2);

    let project_organisation_count = organisation_projects::table
        .filter(organisation_projects::project_id.eq(ids.project))
        .count()
        .get_result::<i64>(connection)
        .await
        .expect("project memberships should be queryable");
    assert_eq!(project_organisation_count, 2);

    let stored_device = devices::table
        .find(ids.device)
        .select(Device::as_select())
        .first::<Device>(connection)
        .await
        .expect("device should be queryable");
    assert_eq!(stored_device.project_id, ids.project);
    assert_eq!(stored_device.assigned_id, "foo1");
}
