//! `MessagePack` payloads for platform-to-device generic MQTT commands.

use std::fmt;

use msgpacker::{Error as MsgpackerError, serde as msgpacker_serde};
use serde::{
    Deserialize, Deserializer, Serialize, Serializer,
    de::{self, MapAccess, Visitor},
    ser::SerializeMap,
};
use thiserror::Error;
use uuid::Uuid;

use crate::mqtt_payload::{self, ExactDecodeError};

/// The command name and optional arguments accepted by the human API.
///
/// A [`DeviceCommandExecution`] adds the per-device command ID and sequence
/// required by the MQTT wire contract.
#[derive(Debug, Clone, PartialEq)]
pub struct DeviceCommand {
    /// The required command name.
    pub cmd: String,

    /// An optional, nullable list of named command arguments.
    pub args: Option<Vec<CommandArgument>>,
}

/// A command execution published to a device's `cmd/exec` topic.
#[derive(Debug, Clone, PartialEq)]
pub struct DeviceCommandExecution {
    /// Stable per-device command identifier, encoded as 16 bytes.
    pub id: Uuid,
    /// Monotonically increasing per-device sequence.
    pub seq: u64,
    /// Command name and arguments.
    pub command: DeviceCommand,
}

/// A terminal execution result published by a device to its `cmd/result` topic.
#[derive(Debug, Clone, PartialEq)]
pub struct DeviceCommandResult {
    /// Identifier copied from the command execution.
    pub id: Uuid,
    /// Sequence copied from the command execution.
    pub seq: u64,
    /// Signed C-style result code: negative is failure and nonnegative is success.
    pub code: i32,
    /// Optional named return values using the same representation as command arguments.
    pub payload: Option<Vec<CommandArgument>>,
}

/// One named argument or result value.
///
/// This is represented on the wire as a `MessagePack` map containing exactly one
/// string key and one permitted value, for example `{ "delay": 30 }`.
#[derive(Debug, Clone, PartialEq)]
pub struct CommandArgument {
    name: String,
    value: CommandArgumentValue,
}

impl CommandArgument {
    /// Creates a command argument with the supplied name and value.
    #[must_use]
    pub fn new(name: impl Into<String>, value: CommandArgumentValue) -> Self {
        Self {
            name: name.into(),
            value,
        }
    }

    /// Returns the argument name.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the argument value.
    #[must_use]
    pub const fn value(&self) -> &CommandArgumentValue {
        &self.value
    }

    /// Splits this argument into its name and value.
    #[must_use]
    pub fn into_parts(self) -> (String, CommandArgumentValue) {
        (self.name, self.value)
    }
}

/// A value permitted in a [`CommandArgument`].
///
/// The numeric variants preserve the supported integer ranges and
/// floating-point values.
#[derive(Debug, Clone, PartialEq)]
pub enum CommandArgumentValue {
    /// `MessagePack` `nil`.
    Null,
    /// A `MessagePack` string.
    String(String),
    /// A `MessagePack` binary value.
    Binary(Vec<u8>),
    /// A signed `MessagePack` integer.
    Signed(i64),
    /// An unsigned `MessagePack` integer.
    Unsigned(u64),
    /// A `MessagePack` floating-point number.
    Float(f64),
    /// A `MessagePack` boolean.
    Boolean(bool),
}

/// Errors returned while decoding a generic command execution or result.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum CommandPayloadError {
    /// The payload is not a valid generic command `MessagePack` value.
    #[error("invalid generic command MessagePack payload")]
    Decode(#[source] MsgpackerError),

    /// The payload contains bytes after the complete command value.
    #[error("generic command MessagePack payload contains trailing bytes")]
    TrailingBytes,
}

/// Encodes a generic command execution for a device `cmd/exec` topic.
#[must_use]
pub fn encode_device_command_execution(command: &DeviceCommandExecution) -> Vec<u8> {
    msgpacker_serde::to_vec(command)
}

/// Decodes a generic command execution from a device `cmd/exec` payload.
///
/// # Errors
///
/// Returns [`CommandPayloadError::Decode`] when the payload is not a `MessagePack`
/// map with a 16-byte `id`, unsigned `seq`, non-null `cmd` string, and
/// optional/null `args` array.
pub fn decode_device_command_execution(
    payload: &[u8],
) -> Result<DeviceCommandExecution, CommandPayloadError> {
    mqtt_payload::decode_exact(payload).map_err(|error| match error {
        ExactDecodeError::Decode(source) => CommandPayloadError::Decode(source),
        ExactDecodeError::TrailingBytes => CommandPayloadError::TrailingBytes,
    })
}

/// Encodes the command name and arguments used by the human API.
#[must_use]
pub fn encode_device_command(command: &DeviceCommand) -> Vec<u8> {
    msgpacker_serde::to_vec(command)
}

/// Decodes a command name and arguments without an execution ID or sequence.
///
/// This is the human-API command body, not the `cmd/exec` MQTT envelope.
///
/// # Errors
///
/// Returns [`CommandPayloadError`] if the value is malformed or contains
/// trailing bytes.
pub fn decode_device_command(payload: &[u8]) -> Result<DeviceCommand, CommandPayloadError> {
    mqtt_payload::decode_exact(payload).map_err(|error| match error {
        ExactDecodeError::Decode(source) => CommandPayloadError::Decode(source),
        ExactDecodeError::TrailingBytes => CommandPayloadError::TrailingBytes,
    })
}

/// Encodes a terminal command result for a device `cmd/result` topic.
#[must_use]
pub fn encode_device_command_result(result: &DeviceCommandResult) -> Vec<u8> {
    msgpacker_serde::to_vec(result)
}

/// Decodes a terminal command result from a device `cmd/result` payload.
///
/// # Errors
///
/// Returns [`CommandPayloadError::Decode`] unless the payload is a map with a
/// 16-byte `id`, unsigned `seq`, signed-32-bit `code`, and optional/null
/// `payload` list using the shared named-value representation.
pub fn decode_device_command_result(
    payload: &[u8],
) -> Result<DeviceCommandResult, CommandPayloadError> {
    mqtt_payload::decode_exact(payload).map_err(|error| match error {
        ExactDecodeError::Decode(source) => CommandPayloadError::Decode(source),
        ExactDecodeError::TrailingBytes => CommandPayloadError::TrailingBytes,
    })
}

impl Serialize for DeviceCommandExecution {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(Some(4))?;
        map.serialize_entry("id", &WireCommandId(self.id))?;
        map.serialize_entry("seq", &self.seq)?;
        map.serialize_entry("cmd", &self.command.cmd)?;
        map.serialize_entry("args", &self.command.args)?;
        map.end()
    }
}

impl<'de> Deserialize<'de> for DeviceCommandExecution {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_map(DeviceCommandExecutionVisitor)
    }
}

struct DeviceCommandExecutionVisitor;

impl<'de> Visitor<'de> for DeviceCommandExecutionVisitor {
    type Value = DeviceCommandExecution;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a map containing a command ID, sequence, name, and optional arguments")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut id = None;
        let mut seq = None;
        let mut cmd = None;
        let mut args = None;
        let mut args_seen = false;

        while let Some(field) = map.next_key::<String>()? {
            match field.as_str() {
                "id" => {
                    if id.is_some() {
                        return Err(de::Error::duplicate_field("id"));
                    }
                    id = Some(map.next_value::<WireCommandId>()?.0);
                }
                "seq" => {
                    if seq.is_some() {
                        return Err(de::Error::duplicate_field("seq"));
                    }
                    seq = Some(map.next_value()?);
                }
                "cmd" => {
                    if cmd.is_some() {
                        return Err(de::Error::duplicate_field("cmd"));
                    }
                    cmd = Some(map.next_value()?);
                }
                "args" => {
                    if args_seen {
                        return Err(de::Error::duplicate_field("args"));
                    }
                    args = map.next_value()?;
                    args_seen = true;
                }
                _ => {
                    return Err(de::Error::unknown_field(
                        &field,
                        &["id", "seq", "cmd", "args"],
                    ));
                }
            }
        }

        Ok(DeviceCommandExecution {
            id: id.ok_or_else(|| de::Error::missing_field("id"))?,
            seq: seq.ok_or_else(|| de::Error::missing_field("seq"))?,
            command: DeviceCommand {
                cmd: cmd.ok_or_else(|| de::Error::missing_field("cmd"))?,
                args,
            },
        })
    }
}

impl Serialize for DeviceCommandResult {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(Some(4))?;
        map.serialize_entry("id", &WireCommandId(self.id))?;
        map.serialize_entry("seq", &self.seq)?;
        map.serialize_entry("code", &self.code)?;
        map.serialize_entry("payload", &self.payload)?;
        map.end()
    }
}

impl<'de> Deserialize<'de> for DeviceCommandResult {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_map(DeviceCommandResultVisitor)
    }
}

struct DeviceCommandResultVisitor;

impl<'de> Visitor<'de> for DeviceCommandResultVisitor {
    type Value = DeviceCommandResult;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(
            "a map containing a command ID, sequence, signed result code, and optional payload",
        )
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut id = None;
        let mut seq = None;
        let mut code = None;
        let mut payload = None;
        let mut payload_seen = false;

        while let Some(field) = map.next_key::<String>()? {
            match field.as_str() {
                "id" => {
                    if id.is_some() {
                        return Err(de::Error::duplicate_field("id"));
                    }
                    id = Some(map.next_value::<WireCommandId>()?.0);
                }
                "seq" => {
                    if seq.is_some() {
                        return Err(de::Error::duplicate_field("seq"));
                    }
                    seq = Some(map.next_value()?);
                }
                "code" => {
                    if code.is_some() {
                        return Err(de::Error::duplicate_field("code"));
                    }
                    code = Some(map.next_value()?);
                }
                "payload" => {
                    if payload_seen {
                        return Err(de::Error::duplicate_field("payload"));
                    }
                    payload = map.next_value()?;
                    payload_seen = true;
                }
                _ => {
                    return Err(de::Error::unknown_field(
                        &field,
                        &["id", "seq", "code", "payload"],
                    ));
                }
            }
        }

        Ok(DeviceCommandResult {
            id: id.ok_or_else(|| de::Error::missing_field("id"))?,
            seq: seq.ok_or_else(|| de::Error::missing_field("seq"))?,
            code: code.ok_or_else(|| de::Error::missing_field("code"))?,
            payload,
        })
    }
}

#[derive(Clone, Copy)]
struct WireCommandId(Uuid);

impl Serialize for WireCommandId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_bytes(self.0.as_bytes())
    }
}

impl<'de> Deserialize<'de> for WireCommandId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_bytes(WireCommandIdVisitor)
    }
}

struct WireCommandIdVisitor;

impl Visitor<'_> for WireCommandIdVisitor {
    type Value = WireCommandId;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("exactly 16 binary UUID bytes")
    }

    fn visit_bytes<E>(self, value: &[u8]) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        let bytes: [u8; 16] = value
            .try_into()
            .map_err(|_| de::Error::invalid_length(value.len(), &self))?;
        Ok(WireCommandId(Uuid::from_bytes(bytes)))
    }

    fn visit_borrowed_bytes<E>(self, value: &'_ [u8]) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        self.visit_bytes(value)
    }
}

impl Serialize for DeviceCommand {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("cmd", &self.cmd)?;
        map.serialize_entry("args", &self.args)?;
        map.end()
    }
}

impl<'de> Deserialize<'de> for DeviceCommand {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_map(DeviceCommandVisitor)
    }
}

struct DeviceCommandVisitor;

impl<'de> Visitor<'de> for DeviceCommandVisitor {
    type Value = DeviceCommand;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a map containing a command name and optional arguments")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut cmd = None;
        let mut args = None;
        let mut args_seen = false;

        while let Some(field) = map.next_key::<String>()? {
            match field.as_str() {
                "cmd" => {
                    if cmd.is_some() {
                        return Err(de::Error::duplicate_field("cmd"));
                    }
                    cmd = Some(map.next_value()?);
                }
                "args" => {
                    if args_seen {
                        return Err(de::Error::duplicate_field("args"));
                    }
                    args = map.next_value()?;
                    args_seen = true;
                }
                _ => {
                    return Err(de::Error::unknown_field(&field, &["cmd", "args"]));
                }
            }
        }

        let cmd = cmd.ok_or_else(|| de::Error::missing_field("cmd"))?;
        Ok(DeviceCommand { cmd, args })
    }
}

impl Serialize for CommandArgument {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(Some(1))?;
        map.serialize_entry(&self.name, &self.value)?;
        map.end()
    }
}

impl<'de> Deserialize<'de> for CommandArgument {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_map(CommandArgumentVisitor)
    }
}

struct CommandArgumentVisitor;

impl<'de> Visitor<'de> for CommandArgumentVisitor {
    type Value = CommandArgument;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a map containing exactly one string-keyed command argument")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let Some((name, value)) = map.next_entry::<String, CommandArgumentValue>()? else {
            return Err(de::Error::custom(
                "a command argument must contain exactly one key-value pair",
            ));
        };

        if map
            .next_entry::<de::IgnoredAny, de::IgnoredAny>()?
            .is_some()
        {
            return Err(de::Error::custom(
                "a command argument must contain exactly one key-value pair",
            ));
        }

        Ok(CommandArgument { name, value })
    }
}

impl Serialize for CommandArgumentValue {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Null => serializer.serialize_unit(),
            Self::String(value) => serializer.serialize_str(value),
            Self::Binary(value) => serializer.serialize_bytes(value),
            Self::Signed(value) => serializer.serialize_i64(*value),
            Self::Unsigned(value) => serializer.serialize_u64(*value),
            Self::Float(value) => serializer.serialize_f64(*value),
            Self::Boolean(value) => serializer.serialize_bool(*value),
        }
    }
}

impl<'de> Deserialize<'de> for CommandArgumentValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(CommandArgumentValueVisitor)
    }
}

struct CommandArgumentValueVisitor;

impl Visitor<'_> for CommandArgumentValueVisitor {
    type Value = CommandArgumentValue;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a null, string, binary, number, or boolean command argument value")
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(CommandArgumentValue::Null)
    }

    fn visit_none<E>(self) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(CommandArgumentValue::Null)
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(CommandArgumentValue::Boolean(value))
    }

    fn visit_i8<E>(self, value: i8) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(CommandArgumentValue::Signed(i64::from(value)))
    }

    fn visit_i16<E>(self, value: i16) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(CommandArgumentValue::Signed(i64::from(value)))
    }

    fn visit_i32<E>(self, value: i32) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(CommandArgumentValue::Signed(i64::from(value)))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(CommandArgumentValue::Signed(value))
    }

    fn visit_u8<E>(self, value: u8) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(CommandArgumentValue::Unsigned(u64::from(value)))
    }

    fn visit_u16<E>(self, value: u16) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(CommandArgumentValue::Unsigned(u64::from(value)))
    }

    fn visit_u32<E>(self, value: u32) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(CommandArgumentValue::Unsigned(u64::from(value)))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(CommandArgumentValue::Unsigned(value))
    }

    fn visit_f32<E>(self, value: f32) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(CommandArgumentValue::Float(f64::from(value)))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(CommandArgumentValue::Float(value))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(CommandArgumentValue::String(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(CommandArgumentValue::String(value))
    }

    fn visit_bytes<E>(self, value: &[u8]) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(CommandArgumentValue::Binary(value.to_vec()))
    }

    fn visit_borrowed_bytes<E>(self, value: &'_ [u8]) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(CommandArgumentValue::Binary(value.to_vec()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_and_decodes_command_execution_envelope() {
        let execution = DeviceCommandExecution {
            id: Uuid::from_bytes([0x5a; 16]),
            seq: 42,
            command: DeviceCommand {
                cmd: "getConfig".to_owned(),
                args: Some(vec![CommandArgument::new(
                    "key",
                    CommandArgumentValue::String("logging.level".to_owned()),
                )]),
            },
        };

        let encoded = encode_device_command_execution(&execution);
        assert_eq!(
            decode_device_command_execution(&encoded),
            Ok(execution.clone())
        );
        assert_eq!(encoded[4], 0xc4, "command ID must use MessagePack bin");
        assert_eq!(encoded[5], 16, "command ID must contain 16 bytes");
    }

    #[test]
    fn encodes_and_decodes_command_result_envelope() {
        let result = DeviceCommandResult {
            id: Uuid::from_bytes([0xa5; 16]),
            seq: 43,
            code: 0,
            payload: Some(vec![
                CommandArgument::new("logging.level", CommandArgumentValue::Unsigned(3)),
                CommandArgument::new("certificate", CommandArgumentValue::Binary(vec![0, 1, 255])),
            ]),
        };

        let encoded = encode_device_command_result(&result);
        assert_eq!(decode_device_command_result(&encoded), Ok(result));
    }

    #[test]
    fn command_result_accepts_negative_code_and_omitted_payload() {
        let payload = [
            0x83, 0xa2, b'i', b'd', 0xc4, 0x10, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
            15, 0xa3, b's', b'e', b'q', 0x01, 0xa4, b'c', b'o', b'd', b'e', 0xea,
        ];

        assert_eq!(
            decode_device_command_result(&payload),
            Ok(DeviceCommandResult {
                id: Uuid::from_bytes([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
                seq: 1,
                code: -22,
                payload: None,
            })
        );
    }

    #[test]
    fn command_envelopes_reject_bad_ids_unknown_fields_and_trailing_bytes() {
        let execution = DeviceCommandExecution {
            id: Uuid::from_bytes([0x5a; 16]),
            seq: 1,
            command: DeviceCommand {
                cmd: "reboot".to_owned(),
                args: None,
            },
        };
        let mut bad_id = encode_device_command_execution(&execution);
        bad_id[5] = 15;
        assert!(decode_device_command_execution(&bad_id).is_err());

        let unknown_result_field = [
            0x84, 0xa2, b'i', b'd', 0xc4, 0x10, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
            15, 0xa3, b's', b'e', b'q', 0x01, 0xa4, b'c', b'o', b'd', b'e', 0x00, 0xa1, b'x', 0xc0,
        ];
        assert!(decode_device_command_result(&unknown_result_field).is_err());

        let result = DeviceCommandResult {
            id: Uuid::new_v4(),
            seq: 1,
            code: 0,
            payload: None,
        };
        let mut trailing = encode_device_command_result(&result);
        trailing.push(0xff);
        assert_eq!(
            decode_device_command_result(&trailing),
            Err(CommandPayloadError::TrailingBytes)
        );
    }

    #[test]
    fn decodes_and_encodes_the_documented_command_shape() {
        let payload = [
            0x82, 0xa3, b'c', b'm', b'd', 0xab, b's', b'o', b'm', b'e', b'C', b'o', b'm', b'm',
            b'a', b'n', b'd', 0xa4, b'a', b'r', b'g', b's', 0x95, 0x81, 0xa4, b'a', b'r', b'g',
            b'1', 0xa3, b'f', b'o', b'o', 0x81, 0xa4, b'a', b'r', b'g', b'2', 0xa3, b'b', b'a',
            b'r', 0x81, 0xa4, b'a', b'r', b'g', b'3', 67, 0x81, 0xa4, b'a', b'r', b'g', b'4', 0xc3,
            0x81, 0xa4, b'a', b'r', b'g', b'5', 0xc0,
        ];
        let command = DeviceCommand {
            cmd: "someCommand".to_owned(),
            args: Some(vec![
                CommandArgument::new("arg1", CommandArgumentValue::String("foo".to_owned())),
                CommandArgument::new("arg2", CommandArgumentValue::String("bar".to_owned())),
                CommandArgument::new("arg3", CommandArgumentValue::Unsigned(67)),
                CommandArgument::new("arg4", CommandArgumentValue::Boolean(true)),
                CommandArgument::new("arg5", CommandArgumentValue::Null),
            ]),
        };

        assert_eq!(decode_device_command(&payload), Ok(command.clone()));
        assert_eq!(encode_device_command(&command), payload);
    }

    #[test]
    fn accepts_missing_or_null_args_and_encodes_none_as_null() {
        let omitted_args = [
            0x81, 0xa3, b'c', b'm', b'd', 0xa6, b'r', b'e', b'b', b'o', b'o', b't',
        ];
        let command = DeviceCommand {
            cmd: "reboot".to_owned(),
            args: None,
        };

        assert_eq!(decode_device_command(&omitted_args), Ok(command.clone()));
        assert_eq!(
            encode_device_command(&command),
            [
                0x82, 0xa3, b'c', b'm', b'd', 0xa6, b'r', b'e', b'b', b'o', b'o', b't', 0xa4, b'a',
                b'r', b'g', b's', 0xc0,
            ]
        );
        assert_eq!(
            decode_device_command(&encode_device_command(&command)),
            Ok(command)
        );
    }

    #[test]
    fn preserves_all_numeric_categories() {
        let command = DeviceCommand {
            cmd: "configure".to_owned(),
            args: Some(vec![
                CommandArgument::new("negative", CommandArgumentValue::Signed(-2)),
                CommandArgument::new("large", CommandArgumentValue::Unsigned(u64::MAX)),
                CommandArgument::new("ratio", CommandArgumentValue::Float(1.5)),
            ]),
        };

        let encoded = encode_device_command(&command);
        assert_eq!(decode_device_command(&encoded), Ok(command));
    }

    #[test]
    fn encodes_and_decodes_binary_argument_values() {
        let payload = [
            0x82, 0xa3, b'c', b'm', b'd', 0xa8, b't', b'r', b'a', b'n', b's', b'f', b'e', b'r',
            0xa4, b'a', b'r', b'g', b's', 0x91, 0x81, 0xa4, b'd', b'a', b't', b'a', 0xc4, 0x03,
            0x00, 0x01, 0xff,
        ];
        let command = DeviceCommand {
            cmd: "transfer".to_owned(),
            args: Some(vec![CommandArgument::new(
                "data",
                CommandArgumentValue::Binary(vec![0, 1, 255]),
            )]),
        };

        assert_eq!(decode_device_command(&payload), Ok(command.clone()));
        assert_eq!(encode_device_command(&command), payload);
    }

    #[test]
    fn rejects_missing_or_null_command_name() {
        let missing_command = [0x81, 0xa4, b'a', b'r', b'g', b's', 0xc0];
        let null_command = [0x81, 0xa3, b'c', b'm', b'd', 0xc0];

        assert!(decode_device_command(&missing_command).is_err());
        assert!(decode_device_command(&null_command).is_err());
    }

    #[test]
    fn rejects_unknown_top_level_fields() {
        let unknown_field = [
            0x82, 0xa3, b'c', b'm', b'd', 0xa6, b'r', b'e', b'b', b'o', b'o', b't', 0xa5, b'e',
            b'x', b't', b'r', b'a', 0xc0,
        ];

        assert!(decode_device_command(&unknown_field).is_err());
    }

    #[test]
    fn rejects_trailing_bytes() {
        let command = DeviceCommand {
            cmd: "reboot".to_owned(),
            args: None,
        };
        let mut payload = encode_device_command(&command);
        payload.extend([0xff, 0xff, 0xff]);

        assert_eq!(
            decode_device_command(&payload),
            Err(CommandPayloadError::TrailingBytes)
        );
    }

    #[test]
    fn rejects_argument_maps_without_exactly_one_pair() {
        let empty_argument = [
            0x82, 0xa3, b'c', b'm', b'd', 0xa6, b'r', b'e', b'b', b'o', b'o', b't', 0xa4, b'a',
            b'r', b'g', b's', 0x91, 0x80,
        ];
        let two_arguments = [
            0x82, 0xa3, b'c', b'm', b'd', 0xa6, b'r', b'e', b'b', b'o', b'o', b't', 0xa4, b'a',
            b'r', b'g', b's', 0x91, 0x82, 0xa1, b'a', 0x01, 0xa1, b'b', 0x02,
        ];
        let unsupported_argument_value = [
            0x82, 0xa3, b'c', b'm', b'd', 0xa6, b'r', b'e', b'b', b'o', b'o', b't', 0xa4, b'a',
            b'r', b'g', b's', 0x91, 0x81, 0xa5, b'e', b'x', b't', b'r', b'a', 0x90,
        ];

        assert!(decode_device_command(&empty_argument).is_err());
        assert!(decode_device_command(&two_arguments).is_err());
        assert!(decode_device_command(&unsupported_argument_value).is_err());
    }
}
