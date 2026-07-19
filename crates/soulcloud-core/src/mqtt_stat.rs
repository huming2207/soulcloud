//! `MessagePack` payloads for device-to-platform status MQTT messages.

use std::fmt;

use msgpacker::{Error as MsgpackerError, serde as msgpacker_serde};
use serde::{
    Deserialize, Deserializer, Serialize, Serializer,
    de::{self, MapAccess, Visitor},
    ser::SerializeMap,
};
use thiserror::Error;

use crate::mqtt_payload::{self, ExactDecodeError};

/// A device status report received on a device's `stat` topic.
///
/// It is encoded as a `MessagePack` map with four required fields: `sn`, `fw`,
/// `up`, and `rst`. The serial number and firmware hash use the `MessagePack`
/// binary type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceStat {
    /// The device's chip-unique serial number as raw binary data.
    pub serial_number: Vec<u8>,

    /// The firmware hash as raw binary data.
    pub firmware_hash: Vec<u8>,

    /// The device-reported uptime counter as an unsigned 64-bit integer.
    pub uptime: u64,

    /// The device-provided reset reason.
    pub reset_reason: String,
}

/// Errors returned while decoding a device status payload.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum DeviceStatPayloadError {
    /// The payload is not a valid device status `MessagePack` value.
    #[error("invalid device status MessagePack payload")]
    Decode(#[source] MsgpackerError),

    /// The payload contains bytes after the complete status value.
    #[error("device status MessagePack payload contains trailing bytes")]
    TrailingBytes,
}

/// Encodes a device status report as a `MessagePack` map for a device `stat`
/// topic.
#[must_use]
pub fn encode_device_stat(stat: &DeviceStat) -> Vec<u8> {
    msgpacker_serde::to_vec(stat)
}

/// Decodes a device status report from a device `stat` topic payload.
///
/// # Errors
///
/// Returns [`DeviceStatPayloadError::Decode`] when the payload is not a
/// `MessagePack` map containing non-null binary `sn` and `fw`, an unsigned
/// 64-bit `up`, and a non-null string `rst`.
pub fn decode_device_stat(payload: &[u8]) -> Result<DeviceStat, DeviceStatPayloadError> {
    mqtt_payload::decode_exact(payload).map_err(|error| match error {
        ExactDecodeError::Decode(source) => DeviceStatPayloadError::Decode(source),
        ExactDecodeError::TrailingBytes => DeviceStatPayloadError::TrailingBytes,
    })
}

impl Serialize for DeviceStat {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(Some(4))?;
        map.serialize_entry("sn", &BinaryRef(&self.serial_number))?;
        map.serialize_entry("fw", &BinaryRef(&self.firmware_hash))?;
        map.serialize_entry("up", &self.uptime)?;
        map.serialize_entry("rst", &self.reset_reason)?;
        map.end()
    }
}

impl<'de> Deserialize<'de> for DeviceStat {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_map(DeviceStatVisitor)
    }
}

struct DeviceStatVisitor;

impl<'de> Visitor<'de> for DeviceStatVisitor {
    type Value = DeviceStat;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a map containing device status fields")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut serial_number = None;
        let mut firmware_hash = None;
        let mut uptime = None;
        let mut reset_reason = None;

        while let Some(field) = map.next_key::<String>()? {
            match field.as_str() {
                "sn" => {
                    if serial_number.is_some() {
                        return Err(de::Error::duplicate_field("sn"));
                    }
                    serial_number = Some(map.next_value::<Binary>()?.0);
                }
                "fw" => {
                    if firmware_hash.is_some() {
                        return Err(de::Error::duplicate_field("fw"));
                    }
                    firmware_hash = Some(map.next_value::<Binary>()?.0);
                }
                "up" => {
                    if uptime.is_some() {
                        return Err(de::Error::duplicate_field("up"));
                    }
                    uptime = Some(map.next_value()?);
                }
                "rst" => {
                    if reset_reason.is_some() {
                        return Err(de::Error::duplicate_field("rst"));
                    }
                    reset_reason = Some(map.next_value()?);
                }
                _ => {
                    return Err(de::Error::unknown_field(&field, &["sn", "fw", "up", "rst"]));
                }
            }
        }

        Ok(DeviceStat {
            serial_number: serial_number.ok_or_else(|| de::Error::missing_field("sn"))?,
            firmware_hash: firmware_hash.ok_or_else(|| de::Error::missing_field("fw"))?,
            uptime: uptime.ok_or_else(|| de::Error::missing_field("up"))?,
            reset_reason: reset_reason.ok_or_else(|| de::Error::missing_field("rst"))?,
        })
    }
}

struct BinaryRef<'a>(&'a [u8]);

impl Serialize for BinaryRef<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_bytes(self.0)
    }
}

struct Binary(Vec<u8>);

impl<'de> Deserialize<'de> for Binary {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_bytes(BinaryVisitor)
    }
}

struct BinaryVisitor;

impl Visitor<'_> for BinaryVisitor {
    type Value = Binary;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a MessagePack binary value")
    }

    fn visit_bytes<E>(self, value: &[u8]) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Binary(value.to_vec()))
    }

    fn visit_borrowed_bytes<E>(self, value: &'_ [u8]) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Binary(value.to_vec()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_and_encodes_the_documented_status_shape() {
        let payload = [
            0x84, 0xa2, b's', b'n', 0xc4, 0x03, 0x01, 0x02, 0x03, 0xa2, b'f', b'w', 0xc4, 0x02,
            0xaa, 0xbb, 0xa2, b'u', b'p', 0xcf, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
            0xa3, b'r', b's', b't', 0xa5, b'w', b'a', b't', b'c', b'h',
        ];
        let stat = DeviceStat {
            serial_number: vec![1, 2, 3],
            firmware_hash: vec![0xaa, 0xbb],
            uptime: 4_294_967_296,
            reset_reason: "watch".to_owned(),
        };

        assert_eq!(decode_device_stat(&payload), Ok(stat.clone()));
        assert_eq!(encode_device_stat(&stat), payload);
    }

    #[test]
    fn rejects_missing_unknown_or_wrongly_typed_fields() {
        let missing_reset_reason = [
            0x83, 0xa2, b's', b'n', 0xc4, 0x00, 0xa2, b'f', b'w', 0xc4, 0x00, 0xa2, b'u', b'p',
            0x00,
        ];
        let unknown_field = [
            0x85, 0xa2, b's', b'n', 0xc4, 0x00, 0xa2, b'f', b'w', 0xc4, 0x00, 0xa2, b'u', b'p',
            0x00, 0xa3, b'r', b's', b't', 0xa1, b'p', 0xa5, b'e', b'x', b't', b'r', b'a', 0xc0,
        ];
        let string_serial_number = [
            0x84, 0xa2, b's', b'n', 0xa3, b'a', b'b', b'c', 0xa2, b'f', b'w', 0xc4, 0x00, 0xa2,
            b'u', b'p', 0x00, 0xa3, b'r', b's', b't', 0xa1, b'p',
        ];
        let negative_uptime = [
            0x84, 0xa2, b's', b'n', 0xc4, 0x00, 0xa2, b'f', b'w', 0xc4, 0x00, 0xa2, b'u', b'p',
            0xff, 0xa3, b'r', b's', b't', 0xa1, b'p',
        ];

        assert!(decode_device_stat(&missing_reset_reason).is_err());
        assert!(decode_device_stat(&unknown_field).is_err());
        assert!(decode_device_stat(&string_serial_number).is_err());
        assert!(decode_device_stat(&negative_uptime).is_err());
    }

    #[test]
    fn rejects_trailing_bytes() {
        let stat = DeviceStat {
            serial_number: vec![1, 2, 3],
            firmware_hash: vec![0xaa, 0xbb],
            uptime: 42,
            reset_reason: "power-on".to_owned(),
        };
        let mut payload = encode_device_stat(&stat);
        payload.extend([0xff, 0xff, 0xff]);

        assert_eq!(
            decode_device_stat(&payload),
            Err(DeviceStatPayloadError::TrailingBytes)
        );
    }
}
