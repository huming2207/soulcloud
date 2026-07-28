use std::time::Duration;

use diesel::{ExpressionMethods as _, QueryDsl as _, SelectableHelper as _};
use diesel_async::{AsyncPgConnection, RunQueryDsl as _, SimpleAsyncConnection as _};
use soulcloud_core::{
    command_queue::{self, LeasedCommand, ResultRecordOutcome},
    database, migration,
    models::{
        Device, NewDevice, NewOrganisation, NewOrganisationProject, NewOrganisationUser,
        NewProject, NewUser,
    },
    mqtt_command::{
        DeviceCommand, DeviceCommandExecution, DeviceCommandResult,
        decode_device_command_execution, encode_device_command_result,
    },
    schema::{
        command_batches, device_commands, devices, organisation_projects, organisation_users,
        organisations, projects, users,
    },
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

#[tokio::test(flavor = "multi_thread")]
async fn command_queue_expands_batches_and_preserves_device_order() {
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
    let project_id = Uuid::new_v4();
    let device_one = Uuid::new_v4();
    let device_two = Uuid::new_v4();
    let uid_one = format!("queue-test-{device_one}");
    let uid_two = format!("queue-test-{device_two}");

    insert_queue_test_devices(
        &pool, project_id, device_one, device_two, &uid_one, &uid_two,
    )
    .await;

    let first_command = DeviceCommand {
        cmd: "first".to_owned(),
        args: None,
    };
    let second_command = DeviceCommand {
        cmd: "second".to_owned(),
        args: None,
    };
    let first_batch =
        command_queue::enqueue_batch(&pool, &[device_one, device_two], &first_command)
            .await
            .expect("multi-device command batch should be enqueued");
    assert_eq!(first_batch.device_count, 2);
    let second_batch = command_queue::enqueue_batch(&pool, &[device_one], &second_command)
        .await
        .expect("later device command should be enqueued");

    let first_lease = command_queue::lease_next(&pool, Duration::from_secs(30))
        .await
        .expect("first command lease should succeed")
        .expect("first command should be available");
    let second_lease = command_queue::lease_next(&pool, Duration::from_secs(30))
        .await
        .expect("second command lease should succeed")
        .expect("other device command should be available");
    let first_execution = decode_device_command_execution(&first_lease.payload)
        .expect("stored command should decode");
    let second_execution = decode_device_command_execution(&second_lease.payload)
        .expect("stored command should decode");
    assert_eq!(first_execution.command.cmd, "first");
    assert_eq!(second_execution.command.cmd, "first");
    assert_eq!(first_execution.id, first_lease.id);
    assert_eq!(second_execution.id, second_lease.id);
    assert_eq!(first_execution.seq, 1);
    assert_eq!(second_execution.seq, 1);
    assert!(
        command_queue::lease_next(&pool, Duration::from_secs(30))
            .await
            .expect("empty lease attempt should succeed")
            .is_none(),
        "later command for a leased device must remain blocked"
    );

    command_queue::mark_broker_accepted(&pool, first_lease.id)
        .await
        .expect("first command should be acknowledged");
    command_queue::mark_broker_accepted(&pool, second_lease.id)
        .await
        .expect("second command should be acknowledged");
    assert!(
        command_queue::lease_next(&pool, Duration::from_secs(30))
            .await
            .expect("blocked lease attempt should succeed")
            .is_none(),
        "later command must wait for the preceding device result"
    );

    record_success(&pool, &first_lease, &first_execution).await;
    record_success(&pool, &second_lease, &second_execution).await;

    let third_lease = command_queue::lease_next(&pool, Duration::from_secs(30))
        .await
        .expect("third command lease should succeed")
        .expect("later command should become available");
    let third_execution = decode_device_command_execution(&third_lease.payload)
        .expect("stored command should decode");
    assert_eq!(third_execution.command.cmd, "second");
    assert_eq!(third_execution.id, third_lease.id);
    assert_eq!(third_execution.seq, 2);
    command_queue::mark_broker_accepted(&pool, third_lease.id)
        .await
        .expect("third command should be acknowledged");
    record_success(&pool, &third_lease, &third_execution).await;

    assert_accepted_and_cleanup(
        &pool,
        project_id,
        [device_one, device_two],
        [first_batch.id, second_batch.id],
    )
    .await;
}

async fn record_success(
    pool: &database::DbPool,
    leased: &LeasedCommand,
    execution: &DeviceCommandExecution,
) {
    let result = DeviceCommandResult {
        id: execution.id,
        seq: execution.seq,
        code: 0,
        payload: None,
    };
    let packet = encode_device_command_result(&result);
    assert_eq!(
        command_queue::record_device_result(pool, &leased.device_uid, &result, &packet)
            .await
            .expect("device result should be recorded"),
        ResultRecordOutcome::Recorded
    );
    assert_eq!(
        command_queue::record_device_result(pool, &leased.device_uid, &result, &packet)
            .await
            .expect("duplicate device result should be idempotent"),
        ResultRecordOutcome::AlreadyRecorded
    );
}

async fn insert_queue_test_devices(
    pool: &database::DbPool,
    project_id: Uuid,
    device_one: Uuid,
    device_two: Uuid,
    uid_one: &str,
    uid_two: &str,
) {
    let mut connection = pool
        .get()
        .await
        .expect("test database connection should be acquired");
    diesel::insert_into(projects::table)
        .values(NewProject {
            id: project_id,
            name: "Command Queue Test Project",
        })
        .execute(&mut connection)
        .await
        .expect("queue test project should be inserted");
    diesel::insert_into(devices::table)
        .values(NewDevice {
            id: device_one,
            device_uid: uid_one,
            assigned_id: "queue-test-one",
            password_hash: "$test-device-hash",
            project_id,
        })
        .execute(&mut connection)
        .await
        .expect("first queue test device should be inserted");
    diesel::insert_into(devices::table)
        .values(NewDevice {
            id: device_two,
            device_uid: uid_two,
            assigned_id: "queue-test-two",
            password_hash: "$test-device-hash",
            project_id,
        })
        .execute(&mut connection)
        .await
        .expect("second queue test device should be inserted");
}

async fn assert_accepted_and_cleanup(
    pool: &database::DbPool,
    project_id: Uuid,
    device_ids: [Uuid; 2],
    batch_ids: [Uuid; 2],
) {
    let mut connection = pool
        .get()
        .await
        .expect("cleanup connection should be acquired");
    let completed_count = device_commands::table
        .filter(device_commands::batch_id.eq_any(batch_ids))
        .filter(device_commands::state.eq("device_completed"))
        .filter(device_commands::result_code.eq(0))
        .count()
        .get_result::<i64>(&mut connection)
        .await
        .expect("accepted commands should be countable");
    assert_eq!(completed_count, 3);

    diesel::delete(command_batches::table.filter(command_batches::id.eq_any(batch_ids)))
        .execute(&mut connection)
        .await
        .expect("queue test batches should be deleted");
    diesel::delete(devices::table.filter(devices::id.eq_any(device_ids)))
        .execute(&mut connection)
        .await
        .expect("queue test devices should be deleted");
    diesel::delete(projects::table.find(project_id))
        .execute(&mut connection)
        .await
        .expect("queue test project should be deleted");
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
