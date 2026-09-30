//! Parental lock: a PIN protects groups marked as locked. Locked groups and
//! their channels are left out of every listing until the PIN is entered; the
//! frontend then asks for them with `Filters::show_locked` for the session.
//!
//! The PIN is stored as a salted SHA-256 hash in the settings table.

use std::collections::HashMap;

use anyhow::{Result, bail};
use sha2::{Digest, Sha256};

use crate::sql;

pub const PARENTAL_PIN: &str = "parentalPin";

fn hash(salt: &str, pin: &str) -> String {
    let digest = Sha256::digest(format!("{salt}:{pin}").as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn stored() -> Result<Option<String>> {
    Ok(sql::get_settings()?
        .remove(PARENTAL_PIN)
        .filter(|v| !v.is_empty()))
}

fn store(value: Option<String>) -> Result<()> {
    sql::update_settings(HashMap::from([(PARENTAL_PIN.to_string(), value)]))
}

fn matches(stored: &str, pin: &str) -> bool {
    match stored.split_once(':') {
        Some((salt, expected)) => hash(salt, pin) == expected,
        None => false,
    }
}

fn validate_new_pin(pin: &str) -> Result<()> {
    if !(4..=8).contains(&pin.len()) || !pin.chars().all(|c| c.is_ascii_digit()) {
        bail!("The PIN must be 4 to 8 digits");
    }
    Ok(())
}

pub fn has_pin() -> Result<bool> {
    Ok(stored()?.is_some())
}

/// True when no PIN is set, or when `pin` is the PIN. A wrong PIN is slowed
/// down a little so it cannot be brute-forced through the UI in a blink.
pub async fn verify(pin: &str) -> Result<bool> {
    let ok = match stored()? {
        Some(stored) => matches(&stored, pin),
        None => true,
    };
    if !ok {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    Ok(ok)
}

/// Sets, changes or (with `new_pin` = None) removes the PIN. Changing or
/// removing requires the current PIN. Removing it unlocks every group, since
/// nothing could ever unlock them again otherwise.
pub async fn set_pin(current_pin: Option<String>, new_pin: Option<String>) -> Result<()> {
    if stored()?.is_some() && !verify(current_pin.as_deref().unwrap_or("")).await? {
        bail!("Wrong PIN");
    }
    match new_pin {
        Some(pin) => {
            validate_new_pin(&pin)?;
            let mut salt = [0u8; 16];
            getrandom::getrandom(&mut salt)?;
            let salt: String = salt.iter().map(|b| format!("{b:02x}")).collect();
            let hashed = hash(&salt, &pin);
            store(Some(format!("{salt}:{hashed}")))
        }
        None => {
            store(None)?;
            sql::unlock_all_groups()
        }
    }
}

/// Locks or unlocks a group; needs the PIN, and a PIN must exist to lock.
pub async fn set_group_locked(group_id: i64, locked: bool, pin: String) -> Result<()> {
    if locked && !has_pin()? {
        bail!("Set a parental PIN in the settings first");
    }
    if !verify(&pin).await? {
        bail!("Wrong PIN");
    }
    sql::set_group_locked(group_id, locked)
}

#[cfg(test)]
mod test_parental {
    use super::{hash, matches, validate_new_pin};

    #[test]
    fn test_hash_roundtrip() {
        let stored = format!("abc:{}", hash("abc", "1234"));
        assert!(matches(&stored, "1234"));
        assert!(!matches(&stored, "4321"));
        assert!(!matches("garbage", "1234"));
    }

    #[test]
    fn test_pin_format() {
        assert!(validate_new_pin("1234").is_ok());
        assert!(validate_new_pin("12345678").is_ok());
        assert!(validate_new_pin("123").is_err());
        assert!(validate_new_pin("12a4").is_err());
        assert!(validate_new_pin("123456789").is_err());
    }
}
