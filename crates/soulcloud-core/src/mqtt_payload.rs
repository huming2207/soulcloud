//! Shared `MessagePack` decoding helpers for MQTT payload contracts.

use msgpacker::{Error as MsgpackerError, serde as msgpacker_serde};
use serde::Deserialize;

/// An error while decoding exactly one `MessagePack` value.
#[derive(Debug)]
pub(crate) enum ExactDecodeError {
    /// The payload could not be decoded into the requested type.
    Decode(MsgpackerError),
    /// The payload contained bytes after its first complete `MessagePack` value.
    TrailingBytes,
}

/// Decodes a single complete `MessagePack` value.
pub(crate) fn decode_exact<'a, T>(payload: &'a [u8]) -> Result<T, ExactDecodeError>
where
    T: Deserialize<'a>,
{
    let value = msgpacker_serde::from_slice(payload).map_err(ExactDecodeError::Decode)?;
    let value_len = message_len(payload).map_err(ExactDecodeError::Decode)?;

    if value_len == payload.len() {
        Ok(value)
    } else {
        Err(ExactDecodeError::TrailingBytes)
    }
}

fn message_len(payload: &[u8]) -> Result<usize, MsgpackerError> {
    let mut remaining = payload;
    parse_value(&mut remaining)?;
    Ok(payload.len() - remaining.len())
}

fn parse_value(remaining: &mut &[u8]) -> Result<(), MsgpackerError> {
    let marker = take(remaining, 1)?[0];

    match marker {
        0x00..=0x7f | 0xe0..=0xff | 0xc0 | 0xc2 | 0xc3 => Ok(()),
        0x80..=0x8f => parse_map(remaining, usize::from(marker & 0x0f)),
        0x90..=0x9f => parse_array(remaining, usize::from(marker & 0x0f)),
        0xa0..=0xbf => take(remaining, usize::from(marker & 0x1f)).map(|_| ()),
        0xc1 => Err(MsgpackerError::UnexpectedFormatTag),
        0xc4 | 0xd9 => {
            let length = usize::from(take(remaining, 1)?[0]);
            parse_bytes(remaining, length)
        }
        0xc5 | 0xda => {
            let length = usize::from(read_u16(remaining)?);
            parse_bytes(remaining, length)
        }
        0xc6 | 0xdb => {
            let length = read_u32(remaining)?;
            parse_bytes(remaining, length)
        }
        0xc7 => {
            let length = usize::from(take(remaining, 1)?[0]);
            parse_extension(remaining, length)
        }
        0xc8 => {
            let length = usize::from(read_u16(remaining)?);
            parse_extension(remaining, length)
        }
        0xc9 => {
            let length = read_u32(remaining)?;
            parse_extension(remaining, length)
        }
        0xca | 0xce | 0xd2 => take(remaining, 4).map(|_| ()),
        0xcb | 0xcf | 0xd3 => take(remaining, 8).map(|_| ()),
        0xcc | 0xd0 => take(remaining, 1).map(|_| ()),
        0xcd | 0xd1 => take(remaining, 2).map(|_| ()),
        0xd4 => parse_extension(remaining, 1),
        0xd5 => parse_extension(remaining, 2),
        0xd6 => parse_extension(remaining, 4),
        0xd7 => parse_extension(remaining, 8),
        0xd8 => parse_extension(remaining, 16),
        0xdc => {
            let length = usize::from(read_u16(remaining)?);
            parse_array(remaining, length)
        }
        0xdd => {
            let length = read_u32(remaining)?;
            parse_array(remaining, length)
        }
        0xde => {
            let length = usize::from(read_u16(remaining)?);
            parse_map(remaining, length)
        }
        0xdf => {
            let length = read_u32(remaining)?;
            parse_map(remaining, length)
        }
    }
}

fn parse_array(remaining: &mut &[u8], length: usize) -> Result<(), MsgpackerError> {
    for _ in 0..length {
        parse_value(remaining)?;
    }
    Ok(())
}

fn parse_map(remaining: &mut &[u8], length: usize) -> Result<(), MsgpackerError> {
    for _ in 0..length {
        parse_value(remaining)?;
        parse_value(remaining)?;
    }
    Ok(())
}

fn parse_bytes(remaining: &mut &[u8], length: usize) -> Result<(), MsgpackerError> {
    take(remaining, length).map(|_| ())
}

fn parse_extension(remaining: &mut &[u8], length: usize) -> Result<(), MsgpackerError> {
    let total_length = length
        .checked_add(1)
        .ok_or(MsgpackerError::BufferTooShort)?;
    take(remaining, total_length).map(|_| ())
}

fn read_u16(remaining: &mut &[u8]) -> Result<u16, MsgpackerError> {
    let bytes = take(remaining, 2)?;
    Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
}

fn read_u32(remaining: &mut &[u8]) -> Result<usize, MsgpackerError> {
    let bytes = take(remaining, 4)?;
    let value = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    usize::try_from(value).map_err(|_| MsgpackerError::BufferTooShort)
}

fn take<'a>(remaining: &mut &'a [u8], length: usize) -> Result<&'a [u8], MsgpackerError> {
    if remaining.len() < length {
        return Err(MsgpackerError::BufferTooShort);
    }

    let (value, rest) = remaining.split_at(length);
    *remaining = rest;
    Ok(value)
}
