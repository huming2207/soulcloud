use thiserror::Error;

const PREFIX: &str = "soulcloud/v1/devices";

pub const LOG_FILTER: &str = "soulcloud/v1/devices/+/log";
pub const STAT_FILTER: &str = "soulcloud/v1/devices/+/stat";

pub const DEVICE_TO_PLATFORM_FILTERS: [&str; 2] = [LOG_FILTER, STAT_FILTER];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceMessageKind {
    Log,
    Stat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeviceTopic<'a> {
    pub device_uid: &'a str,
    pub kind: DeviceMessageKind,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TopicError {
    #[error("topic does not match the Soulcloud v1 device topic scheme")]
    Invalid,
}

/// Parses an inbound v1 device-to-platform topic.
///
/// # Errors
///
/// Returns [`TopicError::Invalid`] for an unknown shape or unsafe device UID.
pub fn parse_device_message(topic: &str) -> Result<DeviceTopic<'_>, TopicError> {
    let segments: Vec<_> = topic.split('/').collect();
    let (device_uid, kind) = match segments.as_slice() {
        ["soulcloud", "v1", "devices", device_uid, "log"] => (*device_uid, DeviceMessageKind::Log),
        ["soulcloud", "v1", "devices", device_uid, "stat"] => {
            (*device_uid, DeviceMessageKind::Stat)
        }
        _ => return Err(TopicError::Invalid),
    };

    if !valid_device_uid(device_uid) {
        return Err(TopicError::Invalid);
    }

    Ok(DeviceTopic { device_uid, kind })
}

/// Builds the platform-to-device OTA command topic.
///
/// # Errors
///
/// Returns [`TopicError::Invalid`] if the device UID is empty or contains topic
/// separators, wildcards, or whitespace.
pub fn ota_command(device_uid: &str) -> Result<String, TopicError> {
    platform_to_device_topic(device_uid, "ota")
}

/// Builds the platform-to-device generic command topic.
///
/// # Errors
///
/// Returns [`TopicError::Invalid`] if the device UID is empty or contains topic
/// separators, wildcards, or whitespace.
pub fn command(device_uid: &str) -> Result<String, TopicError> {
    platform_to_device_topic(device_uid, "cmd")
}

fn platform_to_device_topic(device_uid: &str, suffix: &str) -> Result<String, TopicError> {
    if !valid_device_uid(device_uid) {
        return Err(TopicError::Invalid);
    }

    Ok(format!("{PREFIX}/{device_uid}/{suffix}"))
}

fn valid_device_uid(device_uid: &str) -> bool {
    !device_uid.is_empty()
        && !device_uid.contains(['/', '+', '#'])
        && !device_uid.chars().any(char::is_whitespace)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_device_to_platform_topics() {
        assert_eq!(
            parse_device_message("soulcloud/v1/devices/dev-42/log"),
            Ok(DeviceTopic {
                device_uid: "dev-42",
                kind: DeviceMessageKind::Log,
            })
        );
    }

    #[test]
    fn builds_platform_to_device_topics() {
        assert_eq!(
            ota_command("dev-42").as_deref(),
            Ok("soulcloud/v1/devices/dev-42/ota")
        );
        assert_eq!(
            command("dev-42").as_deref(),
            Ok("soulcloud/v1/devices/dev-42/cmd")
        );
    }

    #[test]
    fn rejects_wildcards_and_unknown_topics() {
        assert_eq!(
            parse_device_message("soulcloud/v1/devices/+/log"),
            Err(TopicError::Invalid)
        );
        assert_eq!(
            parse_device_message("soulcloud/v1/devices/dev-42/ota"),
            Err(TopicError::Invalid)
        );
        assert_eq!(
            parse_device_message("soulcloud/v1/devices/dev-42/ota/status"),
            Err(TopicError::Invalid)
        );
        assert_eq!(
            parse_device_message("soulcloud/v1/devices/dev-42/cmd"),
            Err(TopicError::Invalid)
        );
        assert_eq!(ota_command("bad/device"), Err(TopicError::Invalid));
        assert_eq!(command("bad/device"), Err(TopicError::Invalid));
    }
}
