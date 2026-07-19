use std::time::Duration;

use rumqttc::{
    AsyncClient, Event, EventLoop, Incoming, MqttOptions, Proxy, ProxyAuth, ProxyType, QoS,
    Transport,
};
use soulcloud_core::{
    config::{self, ConfigError},
    database::{self, DatabaseError, DbPool},
    mqtt_stat,
    mqtt_topic::{self, DEVICE_TO_PLATFORM_FILTERS, DeviceMessageKind},
};
use thiserror::Error;
use url::Url;

#[derive(Debug)]
struct Settings {
    database_url: String,
    broker_url: Url,
    client_id: String,
    credentials: Option<(String, String)>,
    http_proxy: Option<HttpProxy>,
    keep_alive: Duration,
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

        Ok(Self {
            database_url: config::required("DATABASE_URL")?,
            broker_url,
            client_id: config::required("MQTT_CLIENT_ID")?,
            credentials: config::optional_pair("MQTT_USERNAME", "MQTT_PASSWORD")?,
            http_proxy,
            keep_alive: Duration::from_secs(config::parse_or("MQTT_KEEP_ALIVE_SECONDS", 30_u64)?),
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

    #[error("worker database initialization failed")]
    Database(#[from] DatabaseError),

    #[error("failed to queue MQTT subscription")]
    Subscribe(#[source] rumqttc::ClientError),

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

    run(database, event_loop).await
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

async fn run(_database: DbPool, mut event_loop: EventLoop) -> Result<(), WorkerError> {
    loop {
        tokio::select! {
            event = event_loop.poll() => {
                match event.map_err(|error| WorkerError::Connection(Box::new(error)))? {
                    Event::Incoming(Incoming::Publish(message)) => {
                        match mqtt_topic::parse_device_message(&message.topic) {
                            Ok(topic) => match topic.kind {
                                DeviceMessageKind::Log => {
                                    // The log payload contract has not yet been specified.
                                    tracing::debug!(
                                        device_uid = topic.device_uid,
                                        payload_bytes = message.payload.len(),
                                        "received device log message"
                                    );
                                }
                                DeviceMessageKind::Stat => match mqtt_stat::decode_device_stat(&message.payload) {
                                    Ok(stat) => {
                                        tracing::debug!(
                                            device_uid = topic.device_uid,
                                            uptime = stat.uptime,
                                            payload_bytes = message.payload.len(),
                                            "received device status"
                                        );
                                        // Persistence belongs here once status storage semantics are agreed.
                                    }
                                    Err(error) => {
                                        tracing::warn!(
                                            device_uid = topic.device_uid,
                                            payload_bytes = message.payload.len(),
                                            %error,
                                            "ignored invalid device status"
                                        );
                                    }
                                },
                            }
                            Err(error) => {
                                tracing::warn!(topic = %message.topic, %error, "ignored unexpected topic");
                            }
                        }
                    }
                    Event::Incoming(Incoming::ConnAck(_)) => {
                        tracing::info!("connected to MQTT broker");
                    }
                    _ => {}
                }
            }
            signal = tokio::signal::ctrl_c() => {
                signal.map_err(WorkerError::ShutdownSignal)?;
                tracing::info!("worker shutting down");
                return Ok(());
            }
        }
    }
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
