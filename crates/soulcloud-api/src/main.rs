use std::net::{Ipv4Addr, SocketAddr};

use axum::{Json, Router, extract::State, http::StatusCode, routing::get};
use serde::Serialize;
use soulcloud_core::{
    config::{self, ConfigError},
    database::{self, DatabaseError, DbPool},
};
use thiserror::Error;
use tokio::net::TcpListener;

#[derive(Clone)]
struct AppState {
    database: DbPool,
}

#[derive(Debug)]
struct Settings {
    bind_address: SocketAddr,
    database_url: String,
}

impl Settings {
    fn from_env() -> Result<Self, ConfigError> {
        Ok(Self {
            bind_address: config::socket_addr(
                "API_BIND_ADDRESS",
                SocketAddr::from((Ipv4Addr::UNSPECIFIED, 8080)),
            )?,
            database_url: config::required("DATABASE_URL")?,
        })
    }
}

#[derive(Debug, Error)]
enum ApiError {
    #[error("invalid API server configuration")]
    Config(#[from] ConfigError),

    #[error("API server database initialization failed")]
    Database(#[from] DatabaseError),

    #[error("failed to bind API listener")]
    Bind(#[source] std::io::Error),

    #[error("API server stopped unexpectedly")]
    Serve(#[source] std::io::Error),
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
}

#[tokio::main]
async fn main() -> Result<(), ApiError> {
    init_tracing();

    let settings = Settings::from_env()?;
    let database = database::create_pool(&settings.database_url).await?;
    let state = AppState { database };

    let app = Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .with_state(state);

    let listener = TcpListener::bind(settings.bind_address)
        .await
        .map_err(ApiError::Bind)?;
    tracing::info!(address = %settings.bind_address, "API server listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(ApiError::Serve)
}

async fn live() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

async fn ready(State(state): State<AppState>) -> (StatusCode, Json<HealthResponse>) {
    match database::ping(&state.database).await {
        Ok(()) => (StatusCode::OK, Json(HealthResponse { status: "ready" })),
        Err(error) => {
            tracing::warn!(%error, "readiness check failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(HealthResponse {
                    status: "not_ready",
                }),
            )
        }
    }
}

async fn shutdown_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        tracing::error!(%error, "failed to install shutdown signal handler");
    }
}

fn init_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "soulcloud_api=info,tower_http=info".into()),
        )
        .init();
}
