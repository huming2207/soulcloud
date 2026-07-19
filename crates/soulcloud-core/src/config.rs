use std::{env, net::SocketAddr, str::FromStr};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("required environment variable {name} is not set")]
    Missing { name: &'static str },

    #[error("environment variable {name} has invalid value {value:?}: {reason}")]
    Invalid {
        name: &'static str,
        value: String,
        reason: String,
    },

    #[error("environment variables {first} and {second} must either both be set or both be unset")]
    IncompletePair {
        first: &'static str,
        second: &'static str,
    },
}

/// Reads a required, non-empty environment variable.
///
/// # Errors
///
/// Returns [`ConfigError::Missing`] if the variable is unset or empty.
pub fn required(name: &'static str) -> Result<String, ConfigError> {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or(ConfigError::Missing { name })
}

/// Reads an optional, non-empty environment variable.
#[must_use]
pub fn optional(name: &'static str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.trim().is_empty())
}

/// Reads two optional environment variables that must be configured together.
///
/// # Errors
///
/// Returns [`ConfigError::IncompletePair`] if only one variable is configured.
pub fn optional_pair(
    first_name: &'static str,
    second_name: &'static str,
) -> Result<Option<(String, String)>, ConfigError> {
    match (optional(first_name), optional(second_name)) {
        (Some(first), Some(second)) => Ok(Some((first, second))),
        (None, None) => Ok(None),
        _ => Err(ConfigError::IncompletePair {
            first: first_name,
            second: second_name,
        }),
    }
}

/// Parses an environment variable or returns a supplied default when it is unset.
///
/// # Errors
///
/// Returns [`ConfigError::Invalid`] if the configured value cannot be parsed.
pub fn parse_or<T>(name: &'static str, default: T) -> Result<T, ConfigError>
where
    T: FromStr,
    T::Err: std::fmt::Display,
{
    let Some(value) = optional(name) else {
        return Ok(default);
    };

    value.parse().map_err(|error: T::Err| ConfigError::Invalid {
        name,
        value,
        reason: error.to_string(),
    })
}

/// Parses a socket address from an environment variable, with a supplied default.
///
/// # Errors
///
/// Returns [`ConfigError::Invalid`] if the configured value is not a socket address.
pub fn socket_addr(name: &'static str, default: SocketAddr) -> Result<SocketAddr, ConfigError> {
    parse_or(name, default)
}
