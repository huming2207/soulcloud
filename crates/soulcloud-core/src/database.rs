use diesel_async::{
    AsyncPgConnection, RunQueryDsl as _,
    pooled_connection::{AsyncDieselConnectionManager, bb8::Pool},
};
use thiserror::Error;

pub type DbPool = Pool<AsyncPgConnection>;

#[derive(Debug, Error)]
pub enum DatabaseError {
    #[error("failed to create PostgreSQL connection pool: {0}")]
    CreatePool(String),

    #[error("failed to acquire PostgreSQL connection: {0}")]
    AcquireConnection(String),

    #[error("PostgreSQL readiness query failed")]
    ReadinessQuery(#[source] diesel::result::Error),
}

/// Creates an asynchronous `PostgreSQL` connection pool.
///
/// # Errors
///
/// Returns [`DatabaseError::CreatePool`] if the initial pool connection cannot be established.
pub async fn create_pool(database_url: &str) -> Result<DbPool, DatabaseError> {
    let manager = AsyncDieselConnectionManager::<AsyncPgConnection>::new(database_url);
    Pool::builder()
        .build(manager)
        .await
        .map_err(|error| DatabaseError::CreatePool(error.to_string()))
}

/// Verifies that a pooled `PostgreSQL` connection can execute a trivial query.
///
/// # Errors
///
/// Returns [`DatabaseError`] when connection acquisition or the query fails.
pub async fn ping(pool: &DbPool) -> Result<(), DatabaseError> {
    let mut connection = pool
        .get()
        .await
        .map_err(|error| DatabaseError::AcquireConnection(error.to_string()))?;

    diesel::sql_query("SELECT 1")
        .execute(&mut connection)
        .await
        .map_err(DatabaseError::ReadinessQuery)?;

    Ok(())
}
