use std::net::{Ipv4Addr, SocketAddr};

use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use soulcloud_core::{
    command_queue::{self, CommandQueueError},
    config::{self, ConfigError},
    database::{self, DatabaseError, DbPool},
    mqtt_command::DeviceCommand,
};
use thiserror::Error;
use tokio::net::TcpListener;
use uuid::Uuid;

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
enum StartupError {
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
async fn main() -> Result<(), StartupError> {
    init_tracing();

    let settings = Settings::from_env()?;
    let database = database::create_pool(&settings.database_url).await?;
    let state = AppState { database };

    let app = Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/v1/command-batches", post(create_command_batch))
        .with_state(state);

    let listener = TcpListener::bind(settings.bind_address)
        .await
        .map_err(StartupError::Bind)?;
    tracing::info!(address = %settings.bind_address, "API server listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(StartupError::Serve)
}

#[derive(Debug, Deserialize)]
struct CreateCommandBatchRequest {
    device_ids: Vec<Uuid>,
    command: DeviceCommand,
}

#[derive(Debug, Serialize)]
struct CreateCommandBatchResponse {
    batch_id: Uuid,
    device_count: i32,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: &'static str,
    message: String,
}

#[derive(Debug, Error)]
enum CommandApiError {
    #[error(transparent)]
    Queue(#[from] CommandQueueError),
}

impl IntoResponse for CommandApiError {
    fn into_response(self) -> Response {
        let (status, code, message) = match &self {
            Self::Queue(
                CommandQueueError::EmptyTargets
                | CommandQueueError::DuplicateTargets
                | CommandQueueError::TooManyTargets,
            ) => (StatusCode::BAD_REQUEST, "invalid_targets", self.to_string()),
            Self::Queue(CommandQueueError::MissingTargets(_)) => (
                StatusCode::NOT_FOUND,
                "target_devices_not_found",
                self.to_string(),
            ),
            Self::Queue(CommandQueueError::InvalidDeviceUid { .. }) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_device_uid",
                self.to_string(),
            ),
            Self::Queue(
                CommandQueueError::AcquireConnection(_)
                | CommandQueueError::Query(_)
                | CommandQueueError::LeaseTimeOverflow
                | CommandQueueError::LeaseConflict { .. }
                | CommandQueueError::InvalidSequence { .. }
                | CommandQueueError::ResultMismatch { .. }
                | CommandQueueError::ConflictingResult { .. }
                | CommandQueueError::InvalidStoredResult { .. }
                | CommandQueueError::MissingStoredResult { .. },
            ) => {
                tracing::error!(error = %self, "failed to enqueue command batch");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "command_queue_unavailable",
                    "device command queue is unavailable".to_owned(),
                )
            }
        };
        (
            status,
            Json(ErrorResponse {
                error: code,
                message,
            }),
        )
            .into_response()
    }
}

async fn create_command_batch(
    State(state): State<AppState>,
    Json(request): Json<CreateCommandBatchRequest>,
) -> Result<(StatusCode, Json<CreateCommandBatchResponse>), CommandApiError> {
    let batch =
        command_queue::enqueue_batch(&state.database, &request.device_ids, &request.command)
            .await?;
    tracing::info!(
        batch_id = %batch.id,
        device_count = batch.device_count,
        "enqueued device command batch"
    );

    Ok((
        StatusCode::ACCEPTED,
        Json(CreateCommandBatchResponse {
            batch_id: batch.id,
            device_count: batch.device_count,
        }),
    ))
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
