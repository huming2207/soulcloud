use diesel_async::{AsyncConnection as _, AsyncMigrationHarness, AsyncPgConnection};
use diesel_migrations::{EmbeddedMigrations, MigrationHarness, embed_migrations};
use thiserror::Error;

pub const MIGRATIONS: EmbeddedMigrations = embed_migrations!("../../migrations");

#[derive(Debug, Error)]
pub enum MigrationError {
    #[error("failed to connect to PostgreSQL for migration")]
    Connect(#[source] diesel::result::ConnectionError),

    #[error("failed to run PostgreSQL migrations: {0}")]
    Run(String),
}

/// Applies all pending embedded Diesel migrations.
///
/// # Errors
///
/// Returns [`MigrationError`] if a connection cannot be acquired or a
/// migration cannot be applied.
pub async fn run_pending_migrations(database_url: &str) -> Result<(), MigrationError> {
    let connection = AsyncPgConnection::establish(database_url)
        .await
        .map_err(MigrationError::Connect)?;
    let mut harness = AsyncMigrationHarness::new(connection);
    harness
        .run_pending_migrations(MIGRATIONS)
        .map_err(|error| MigrationError::Run(error.to_string()))?;
    Ok(())
}
