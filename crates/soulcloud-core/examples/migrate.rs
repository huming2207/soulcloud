use soulcloud_core::{
    config::{self, ConfigError},
    migration::{self, MigrationError},
};
use thiserror::Error;

#[derive(Debug, Error)]
enum MigrateError {
    #[error("invalid migration configuration")]
    Config(#[from] ConfigError),

    #[error("database migration failed")]
    Migration(#[from] MigrationError),
}

#[tokio::main]
async fn main() -> Result<(), MigrateError> {
    let database_url = config::required("DATABASE_URL")?;
    migration::run_pending_migrations(&database_url).await?;
    Ok(())
}
