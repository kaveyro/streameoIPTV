//! Texts the backend shows itself (tray menu, notifications, the quit
//! dialog). The frontend owns the translations and sends them on startup and
//! on every language change; until then the English defaults apply.

use std::{
    collections::HashMap,
    sync::{LazyLock, RwLock},
};

static STRINGS: LazyLock<RwLock<HashMap<String, String>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

const DEFAULTS: [(&str, &str); 15] = [
    ("tray_show", "Show"),
    ("tray_quit", "Quit"),
    ("tray_pause", "Play/Pause"),
    ("tray_stop", "Stop playback"),
    ("reminder_title", "LIVE: {title}"),
    ("reminder_body", "Watch on {channel}"),
    ("recording_started", "Recording started: {title}"),
    ("recording_finished", "Recording finished: {title}"),
    ("recording_failed", "Recording failed: {title}"),
    ("scheduled_program", "Scheduled program"),
    ("local_livestream", "Local livestream"),
    ("quit_title", "Quit streameoIPTV?"),
    (
        "quit_body",
        "{count} recordings or downloads are running or due soon. Quitting stops them.",
    ),
    ("quit_confirm", "Quit"),
    ("quit_cancel", "Cancel"),
];

/// Replaces the stored texts. Unknown keys are kept as well; empty values
/// fall back to the defaults.
pub fn set(strings: HashMap<String, String>) {
    if let Ok(mut stored) = STRINGS.write() {
        *stored = strings
            .into_iter()
            .filter(|(_, v)| !v.trim().is_empty())
            .collect();
    }
}

/// The text for `key`, with `{name}` placeholders filled from `args`.
pub fn text(key: &str, args: &[(&str, &str)]) -> String {
    let template = STRINGS
        .read()
        .ok()
        .and_then(|s| s.get(key).cloned())
        .or_else(|| {
            DEFAULTS
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v.to_string())
        })
        .unwrap_or_else(|| key.to_string());
    fill(&template, args)
}

fn fill(template: &str, args: &[(&str, &str)]) -> String {
    args.iter()
        .fold(template.to_string(), |text, (name, value)| {
            text.replace(&format!("{{{name}}}"), value)
        })
}

#[cfg(test)]
mod test_native_strings {
    use super::*;

    #[test]
    fn test_fill_replaces_placeholders() {
        assert_eq!(
            fill(
                "LIVE: {title} on {channel}",
                &[("title", "News"), ("channel", "ARD")]
            ),
            "LIVE: News on ARD"
        );
        assert_eq!(fill("no placeholder", &[("title", "x")]), "no placeholder");
    }

    #[test]
    fn test_defaults_cover_every_key_once() {
        let mut keys: Vec<&str> = DEFAULTS.iter().map(|(k, _)| *k).collect();
        keys.sort();
        keys.dedup();
        assert_eq!(keys.len(), DEFAULTS.len());
    }

    #[test]
    fn test_text_falls_back_to_default() {
        // Only checks a key no test ever sets, since STRINGS is global.
        assert_eq!(text("quit_cancel", &[]), "Cancel");
        assert_eq!(text("unknown_key", &[]), "unknown_key");
    }
}
