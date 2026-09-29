//! OS-keychain storage for Xtream source passwords.
//!
//! Passwords are stored under the service name "streameoIPTV", one entry per
//! source, keyed by the source's database id ("source-{id}"). Source ids are
//! stable: refreshes reuse the existing row (`create_or_find_source_by_name`
//! looks the id up by name, and refresh wipes only channels/groups/seasons),
//! and there is no rename path for non-custom sources.
//!
//! Every keychain interaction is strictly best-effort. When the keychain is
//! unavailable (e.g. Linux without a running secret service), the password
//! stays in the database as plaintext, exactly as before this module existed.
//! When a password did make it into the keychain, the database column holds
//! the [`KEYCHAIN_PLACEHOLDER`] marker instead, and reads resolve the real
//! value through [`resolve_source_password`].

use crate::log::log;
use crate::sql;
use crate::types::Source;

/// Value stored in the sources.password column when the real password lives
/// in the OS keychain.
pub const KEYCHAIN_PLACEHOLDER: &str = "__keychain__";

fn account_for_source(source_id: i64) -> String {
    format!("source-{source_id}")
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
mod keychain {
    use crate::log::log;

    const SERVICE_NAME: &str = "streameoIPTV";

    /// Best-effort write. Returns false (and logs) on any keychain error.
    pub fn set_password(account: &str, value: &str) -> bool {
        match keyring::Entry::new(SERVICE_NAME, account).and_then(|e| e.set_password(value)) {
            Ok(()) => true,
            Err(e) => {
                log(format!("Keychain write failed for {account}: {e}"));
                false
            }
        }
    }

    /// Best-effort read. Returns None if the entry is missing or the keychain
    /// is unavailable (the latter is logged).
    pub fn get_password(account: &str) -> Option<String> {
        match keyring::Entry::new(SERVICE_NAME, account).and_then(|e| e.get_password()) {
            Ok(value) => Some(value),
            Err(keyring::Error::NoEntry) => None,
            Err(e) => {
                log(format!("Keychain read failed for {account}: {e}"));
                None
            }
        }
    }

    /// Best-effort delete. Missing entries are not an error.
    pub fn delete_password(account: &str) {
        match keyring::Entry::new(SERVICE_NAME, account).and_then(|e| e.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => log(format!("Keychain delete failed for {account}: {e}")),
        }
    }
}

/// Stub used on platforms without a supported keychain (mobile builds):
/// every call is a no-op, so passwords stay in the database as plaintext.
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod keychain {
    pub fn set_password(_account: &str, _value: &str) -> bool {
        false
    }

    pub fn get_password(_account: &str) -> Option<String> {
        None
    }

    pub fn delete_password(_account: &str) {}
}

pub use keychain::{delete_password, get_password, set_password};

/// Write `password` to the keychain and verify it with a read-back.
/// Returns true only when the stored value could be read back identically.
pub fn store_source_password(source_id: i64, password: &str) -> bool {
    let account = account_for_source(source_id);
    if !set_password(&account, password) {
        return false;
    }
    match get_password(&account) {
        Some(read_back) if read_back == password => true,
        _ => {
            log(format!(
                "Keychain read-back verification failed for {account}"
            ));
            false
        }
    }
}

pub fn get_source_password(source_id: i64) -> Option<String> {
    get_password(&account_for_source(source_id))
}

pub fn delete_source_password(source_id: i64) {
    delete_password(&account_for_source(source_id));
}

/// Decide what the sources.password DB column should contain when creating
/// or updating a source. Tries the keychain first (write + read-back verify)
/// and returns [`KEYCHAIN_PLACEHOLDER`] on success; on failure the plaintext
/// is returned unchanged so behavior matches the pre-keychain versions.
/// A cleared (None/empty) password also drops any stale keychain entry.
pub fn password_for_db(source_id: Option<i64>, password: Option<String>) -> Option<String> {
    let Some(id) = source_id else {
        return password;
    };
    match password {
        // Defensive: never treat the literal placeholder as a real password.
        Some(pw) if pw == KEYCHAIN_PLACEHOLDER => Some(pw),
        Some(pw) if !pw.is_empty() => {
            if store_source_password(id, &pw) {
                Some(KEYCHAIN_PLACEHOLDER.to_string())
            } else {
                Some(pw)
            }
        }
        other => {
            delete_source_password(id);
            other
        }
    }
}

/// Replace the [`KEYCHAIN_PLACEHOLDER`] in a source loaded from the database
/// with the real password from the OS keychain. Sources whose password is
/// stored as plaintext (keychain fallback) are left untouched. A missing
/// keychain entry resolves to an empty password and is logged.
pub fn resolve_source_password(source: &mut Source) {
    resolve_source_password_with(source, get_source_password);
}

fn resolve_source_password_with<F>(source: &mut Source, lookup: F)
where
    F: Fn(i64) -> Option<String>,
{
    if source.password.as_deref() != Some(KEYCHAIN_PLACEHOLDER) {
        return;
    }
    let resolved = source.id.and_then(&lookup);
    if resolved.is_none() {
        log(format!(
            "No keychain entry for source {:?} ({}); treating password as empty",
            source.id, source.name
        ));
    }
    source.password = Some(resolved.unwrap_or_default());
}

/// Move every plaintext source password from the database into the OS
/// keychain (write + read-back verify, then replace the DB value with the
/// placeholder). Rows are left untouched when the keychain is unavailable.
/// Called once at startup and again after a database restore.
pub fn migrate_passwords_to_keychain() {
    let sources = match sql::get_plaintext_source_passwords() {
        Ok(sources) => sources,
        Err(e) => {
            log(format!(
                "{:?}",
                e.context("Password migration failed to read sources")
            ));
            return;
        }
    };
    if sources.is_empty() {
        return;
    }
    let total = sources.len();
    let mut migrated = 0;
    for (id, password) in sources {
        if store_source_password(id, &password) {
            match sql::set_source_db_password(id, KEYCHAIN_PLACEHOLDER) {
                Ok(()) => migrated += 1,
                Err(e) => {
                    // DB write failed after the keychain write; the plaintext
                    // row remains authoritative, the keychain entry is ignored.
                    log(format!(
                        "{:?}",
                        e.context("Password migration DB update failed")
                    ));
                }
            }
        }
    }
    log(format!(
        "Password migration: moved {migrated}/{total} source password(s) to the OS keychain"
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source_type;
    use crate::types::Source;

    fn make_source(id: Option<i64>, password: Option<&str>) -> Source {
        Source {
            id,
            name: "test source".to_string(),
            url: Some("http://example.com".to_string()),
            url_origin: None,
            username: Some("user".to_string()),
            password: password.map(|p| p.to_string()),
            source_type: source_type::XTREAM,
            use_tvg_id: None,
            enabled: true,
            user_agent: None,
            max_streams: None,
            stream_user_agent: None,
            last_updated: None,
        }
    }

    #[test]
    fn placeholder_resolves_from_lookup() {
        let mut source = make_source(Some(7), Some(KEYCHAIN_PLACEHOLDER));
        resolve_source_password_with(&mut source, |id| {
            assert_eq!(id, 7);
            Some("s3cret".to_string())
        });
        assert_eq!(source.password.as_deref(), Some("s3cret"));
    }

    #[test]
    fn missing_keychain_entry_resolves_to_empty() {
        let mut source = make_source(Some(7), Some(KEYCHAIN_PLACEHOLDER));
        resolve_source_password_with(&mut source, |_| None);
        assert_eq!(source.password.as_deref(), Some(""));
    }

    #[test]
    fn placeholder_without_id_resolves_to_empty() {
        let mut source = make_source(None, Some(KEYCHAIN_PLACEHOLDER));
        resolve_source_password_with(&mut source, |_| panic!("lookup must not be called"));
        assert_eq!(source.password.as_deref(), Some(""));
    }

    #[test]
    fn plaintext_password_is_left_untouched() {
        let mut source = make_source(Some(7), Some("plaintext"));
        resolve_source_password_with(&mut source, |_| panic!("lookup must not be called"));
        assert_eq!(source.password.as_deref(), Some("plaintext"));
    }

    #[test]
    fn absent_password_is_left_untouched() {
        let mut source = make_source(Some(7), None);
        resolve_source_password_with(&mut source, |_| panic!("lookup must not be called"));
        assert_eq!(source.password, None);
    }

    /// Round-trips a value through the real OS keychain. Ignored by default
    /// so CI and keychain-less machines are unaffected; run explicitly with
    /// `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn keychain_round_trip() {
        let account = format!("test-round-trip-{}", std::process::id());
        assert!(
            set_password(&account, "round-trip-value"),
            "keychain write failed"
        );
        assert_eq!(get_password(&account).as_deref(), Some("round-trip-value"));
        delete_password(&account);
        assert_eq!(get_password(&account), None);
    }
}
