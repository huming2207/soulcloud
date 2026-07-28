use std::time::Duration;

use rumqttc::{
    AsyncClient, Event, EventLoop, Incoming, MqttOptions, Outgoing, Proxy, ProxyAuth, ProxyType,
    QoS, Transport,
};
use soulcloud_core::{
    command_queue::{self, CommandQueueError},
    config::{self, ConfigError},
    database::{self, DatabaseError, DbPool},
    mqtt_command, mqtt_stat,
    mqtt_topic::{self, DEVICE_TO_PLATFORM_FILTERS, DeviceMessageKind},
};
use thiserror::Error;
use tokio::time::{MissedTickBehavior, interval};
use url::Url;
use uuid::Uuid;

#[derive(Debug)]
struct Settings {
    database_url: String,
    broker_url: Url,
    client_id: String,
    credentials: Option<(String, String)>,
    http_proxy: Option<HttpProxy>,
    keep_alive: Duration,
    command_retain: bool,
    command_poll_interval: Duration,
    command_lease_duration: Duration,
}

#[derive(Debug)]
struct HttpProxy {
    host: String,
    port: u16,
    credentials: Option<(String, String)>,
}

impl Settings {
    fn from_env() -> Result<Self, WorkerError> {
        let broker_url = parse_url("MQTT_BROKER_URL", &config::required("MQTT_BROKER_URL")?)?;
        if !matches!(broker_url.scheme(), "ws" | "wss") {
            return Err(WorkerError::UnsupportedBrokerScheme(
                broker_url.scheme().to_owned(),
            ));
        }

        let http_proxy = config::optional("HTTP_PROXY_URL")
            .map(|value| parse_http_proxy(&value))
            .transpose()?;

        let command_poll_interval =
            Duration::from_millis(config::parse_or("COMMAND_POLL_INTERVAL_MS", 500_u64)?);
        let command_lease_duration =
            Duration::from_secs(config::parse_or("COMMAND_LEASE_SECONDS", 60_u64)?);
        if command_poll_interval.is_zero() {
            return Err(WorkerError::ZeroDuration("COMMAND_POLL_INTERVAL_MS"));
        }
        if command_lease_duration.is_zero() {
            return Err(WorkerError::ZeroDuration("COMMAND_LEASE_SECONDS"));
        }

        Ok(Self {
            database_url: config::required("DATABASE_URL")?,
            broker_url,
            client_id: config::required("MQTT_CLIENT_ID")?,
            credentials: config::optional_pair("MQTT_USERNAME", "MQTT_PASSWORD")?,
            http_proxy,
            keep_alive: Duration::from_secs(config::parse_or("MQTT_KEEP_ALIVE_SECONDS", 30_u64)?),
            command_retain: config::parse_required("MQTT_COMMAND_RETAIN")?,
            command_poll_interval,
            command_lease_duration,
        })
    }
}

#[derive(Debug, Error)]
enum WorkerError {
    #[error("invalid worker configuration")]
    Config(#[from] ConfigError),

    #[error("environment variable {name} is not a valid URL")]
    InvalidUrl {
        name: &'static str,
        #[source]
        source: url::ParseError,
    },

    #[error("MQTT_BROKER_URL must use ws:// or wss://, not {0}://")]
    UnsupportedBrokerScheme(String),

    #[error("HTTP_PROXY_URL must use http://, not {0}://")]
    UnsupportedProxyScheme(String),

    #[error("HTTP_PROXY_URL must contain a host")]
    MissingProxyHost,

    #[error("HTTP_PROXY_URL contains a username but no password")]
    IncompleteProxyCredentials,

    #[error("environment variable {0} must be greater than zero")]
    ZeroDuration(&'static str),

    #[error("worker database initialization failed")]
    Database(#[from] DatabaseError),

    #[error("failed to queue MQTT subscription")]
    Subscribe(#[source] rumqttc::ClientError),

    #[error("failed to queue MQTT command publication")]
    Publish(#[source] rumqttc::ClientError),

    #[error("device command queue failed")]
    CommandQueue(#[from] CommandQueueError),

    #[error("a queued command has an invalid device UID")]
    InvalidCommandTopic(#[source] mqtt_topic::TopicError),

    #[error("MQTT connection failed")]
    Connection(#[source] Box<rumqttc::ConnectionError>),

    #[error("failed to install shutdown signal handler")]
    ShutdownSignal(#[source] std::io::Error),
}

#[tokio::main]
async fn main() -> Result<(), WorkerError> {
    init_tracing();

    let settings = Settings::from_env()?;
    let database = database::create_pool(&settings.database_url).await?;
    database::ping(&database).await?;

    let (client, event_loop) = mqtt_client(&settings);
    for filter in DEVICE_TO_PLATFORM_FILTERS {
        client
            .subscribe(filter, QoS::AtLeastOnce)
            .await
            .map_err(WorkerError::Subscribe)?;
    }

    tracing::info!(
        broker = %settings.broker_url,
        "worker started"
    );

    run(
        database,
        client,
        event_loop,
        settings.command_poll_interval,
        settings.command_lease_duration,
        settings.command_retain,
    )
    .await
}

fn mqtt_client(settings: &Settings) -> (AsyncClient, EventLoop) {
    // For WebSocket transports rumqttc expects the complete URL in the host field.
    let mut options = MqttOptions::new(&settings.client_id, settings.broker_url.as_str(), 0);
    options.set_keep_alive(settings.keep_alive);
    options.set_transport(match settings.broker_url.scheme() {
        "wss" => Transport::wss_with_default_config(),
        "ws" => Transport::ws(),
        _ => unreachable!("broker URL scheme was validated during configuration"),
    });

    if let Some((username, password)) = &settings.credentials {
        options.set_credentials(username, password);
    }

    if let Some(proxy) = &settings.http_proxy {
        let auth = proxy
            .credentials
            .as_ref()
            .map_or(ProxyAuth::None, |pair| ProxyAuth::Basic {
                username: pair.0.clone(),
                password: pair.1.clone(),
            });
        options.set_proxy(Proxy {
            ty: ProxyType::Http,
            auth,
            addr: proxy.host.clone(),
            port: proxy.port,
        });
    }

    AsyncClient::new(options, 100)
}

#[derive(Debug)]
struct ActiveCommand {
    id: Uuid,
    packet_id: Option<u16>,
}

async fn run(
    database: DbPool,
    client: AsyncClient,
    mut event_loop: EventLoop,
    command_poll_interval: Duration,
    command_lease_duration: Duration,
    command_retain: bool,
) -> Result<(), WorkerError> {
    let mut command_poll = interval(command_poll_interval);
    command_poll.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut active_command: Option<ActiveCommand> = None;

    loop {
        tokio::select! {
            _ = command_poll.tick(), if active_command.is_none() => {
                active_command = publish_next_command(
                    &database,
                    &client,
                    command_lease_duration,
                    command_retain,
                ).await?;
            }
            event = event_loop.poll() => {
                let event =
                    event.map_err(|error| WorkerError::Connection(Box::new(error)))?;
                handle_mqtt_event(&database, event, &mut active_command).await?;
            }
            signal = tokio::signal::ctrl_c() => {
                signal.map_err(WorkerError::ShutdownSignal)?;
                tracing::info!("worker shutting down");
                return Ok(());
            }
        }
    }
}

async fn publish_next_command(
    database: &DbPool,
    client: &AsyncClient,
    lease_duration: Duration,
    retain: bool,
) -> Result<Option<ActiveCommand>, WorkerError> {
    let Some(command) = command_queue::lease_next(database, lease_duration).await? else {
        return Ok(None);
    };
    let topic = mqtt_topic::command_execution(&command.device_uid)
        .map_err(WorkerError::InvalidCommandTopic)?;
    tracing::debug!(
        command_id = %command.id,
        device_uid = %command.device_uid,
        attempt_count = command.attempt_count,
        "publishing queued device command"
    );

    if let Err(source) = client
        .publish(topic, QoS::AtLeastOnce, retain, command.payload)
        .await
    {
        if let Err(error) = command_queue::release_lease(database, command.id).await {
            tracing::error!(
                command_id = %command.id,
                %error,
                "failed to release command after local publish failure"
            );
        }
        return Err(WorkerError::Publish(source));
    }

    Ok(Some(ActiveCommand {
        id: command.id,
        packet_id: None,
    }))
}

async fn handle_mqtt_event(
    database: &DbPool,
    event: Event,
    active_command: &mut Option<ActiveCommand>,
) -> Result<(), WorkerError> {
    match event {
        Event::Incoming(Incoming::Publish(message)) => {
            handle_device_publish(database, &message.topic, &message.payload).await?;
        }
        Event::Incoming(Incoming::ConnAck(_)) => {
            tracing::info!("connected to MQTT broker");
        }
        Event::Outgoing(Outgoing::Publish(packet_id)) => {
            record_outgoing_packet(active_command, packet_id);
        }
        Event::Incoming(Incoming::PubAck(acknowledgement)) => {
            acknowledge_command(database, active_command, acknowledgement.pkid).await?;
        }
        _ => {}
    }
    Ok(())
}

async fn handle_device_publish(
    database: &DbPool,
    topic_name: &str,
    payload: &[u8],
) -> Result<(), WorkerError> {
    match mqtt_topic::parse_device_message(topic_name) {
        Ok(topic) => match topic.kind {
            DeviceMessageKind::CommandResult => {
                match mqtt_command::decode_device_command_result(payload) {
                    Ok(result) => {
                        match command_queue::record_device_result(
                            database,
                            topic.device_uid,
                            &result,
                            payload,
                        )
                        .await
                        {
                            Ok(outcome) => {
                                tracing::info!(
                                    device_uid = topic.device_uid,
                                    command_id = %result.id,
                                    sequence = result.seq,
                                    code = result.code,
                                    ?outcome,
                                    "recorded device command result"
                                );
                            }
                            Err(
                                error @ (CommandQueueError::ResultMismatch { .. }
                                | CommandQueueError::ConflictingResult { .. }),
                            ) => {
                                tracing::warn!(
                                    device_uid = topic.device_uid,
                                    command_id = %result.id,
                                    sequence = result.seq,
                                    %error,
                                    "ignored unmatched device command result"
                                );
                            }
                            Err(error) => return Err(WorkerError::CommandQueue(error)),
                        }
                    }
                    Err(error) => {
                        tracing::warn!(
                            device_uid = topic.device_uid,
                            payload_bytes = payload.len(),
                            %error,
                            "ignored invalid device command result"
                        );
                    }
                }
            }
            DeviceMessageKind::Log => {
                // The log payload contract has not yet been specified.
                tracing::debug!(
                    device_uid = topic.device_uid,
                    payload_bytes = payload.len(),
                    "received device log message"
                );
            }
            DeviceMessageKind::Stat => match mqtt_stat::decode_device_stat(payload) {
                Ok(stat) => {
                    tracing::debug!(
                        device_uid = topic.device_uid,
                        uptime = stat.uptime,
                        payload_bytes = payload.len(),
                        "received device status"
                    );
                    // Persistence belongs here once status storage semantics are agreed.
                }
                Err(error) => {
                    tracing::warn!(
                        device_uid = topic.device_uid,
                        payload_bytes = payload.len(),
                        %error,
                        "ignored invalid device status"
                    );
                }
            },
        },
        Err(error) => {
            tracing::warn!(topic = topic_name, %error, "ignored unexpected topic");
        }
    }
    Ok(())
}

fn record_outgoing_packet(active_command: &mut Option<ActiveCommand>, packet_id: u16) {
    if let Some(command) = active_command {
        if command.packet_id.is_none() {
            command.packet_id = Some(packet_id);
        } else {
            tracing::warn!(
                command_id = %command.id,
                packet_id,
                "observed an additional MQTT publish while a command is active"
            );
        }
    }
}

async fn acknowledge_command(
    database: &DbPool,
    active_command: &mut Option<ActiveCommand>,
    packet_id: u16,
) -> Result<(), WorkerError> {
    match active_command.as_ref() {
        Some(command) if command.packet_id == Some(packet_id) => {
            let command_id = command.id;
            command_queue::mark_broker_accepted(database, command_id).await?;
            tracing::info!(
                command_id = %command_id,
                packet_id,
                "MQTT broker accepted device command"
            );
            *active_command = None;
        }
        Some(command) => {
            tracing::warn!(
                command_id = %command.id,
                expected_packet_id = ?command.packet_id,
                packet_id,
                "ignored unmatched MQTT PUBACK"
            );
        }
        None => {
            tracing::warn!(packet_id, "ignored MQTT PUBACK without an active command");
        }
    }
    Ok(())
}

fn parse_url(name: &'static str, value: &str) -> Result<Url, WorkerError> {
    Url::parse(value).map_err(|source| WorkerError::InvalidUrl { name, source })
}

fn parse_http_proxy(value: &str) -> Result<HttpProxy, WorkerError> {
    let url = parse_url("HTTP_PROXY_URL", value)?;
    if url.scheme() != "http" {
        return Err(WorkerError::UnsupportedProxyScheme(url.scheme().to_owned()));
    }

    let credentials = if url.username().is_empty() {
        None
    } else {
        Some((
            url.username().to_owned(),
            url.password()
                .ok_or(WorkerError::IncompleteProxyCredentials)?
                .to_owned(),
        ))
    };

    Ok(HttpProxy {
        host: url
            .host_str()
            .ok_or(WorkerError::MissingProxyHost)?
            .to_owned(),
        port: url.port_or_known_default().unwrap_or(80),
        credentials,
    })
}

fn init_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "soulcloud_worker=info".into()),
        )
        .init();
}
