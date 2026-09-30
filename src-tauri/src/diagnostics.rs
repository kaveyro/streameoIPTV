//! "Export diagnostics": one text file to attach to a bug report.
//!
//! It holds what helps to find a problem, and nothing that identifies the
//! user's accounts: no source URLs or logins (only the server's host), no
//! parental PIN, and every log line goes through [`crate::redact`] again,
//! including mpv's own log, which records every stream address.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::{log, redact::redact, settings, source_type, sql, xmltv};

/// Settings that are not shown: secrets, and values that are only noise.
const HIDDEN_SETTINGS: [&str; 3] = [
    crate::parental::PARENTAL_PIN,
    settings::XMLTV_STATUS,
    "miniPlayerBounds",
];
/// Newest app logs included.
const APP_LOGS: usize = 3;
/// Tail of each log included, so a huge mpv.log does not bloat the report.
const LOG_TAIL_BYTES: u64 = 256 * 1024;

fn source_type_name(t: u8) -> &'static str {
    match t {
        source_type::M3U => "M3U file",
        source_type::M3U_LINK => "M3U link",
        source_type::XTREAM => "Xtream",
        source_type::CUSTOM => "Custom",
        _ => "unknown",
    }
}

fn host_of(url: Option<&str>) -> String {
    url.and_then(|u| url::Url::parse(u).ok())
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| "-".to_string())
}

/// The last `LOG_TAIL_BYTES` of a file, redacted.
fn log_tail(path: &Path) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = std::fs::File::open(path) else {
        return "(not readable)\n".to_string();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if len > LOG_TAIL_BYTES {
        let _ = file.seek(SeekFrom::Start(len - LOG_TAIL_BYTES));
    }
    let mut bytes = Vec::new();
    let _ = file.read_to_end(&mut bytes);
    redact(&String::from_utf8_lossy(&bytes))
}

/// The app logs, newest first, and mpv.log when it exists.
fn log_files(dir: &Path) -> (Vec<PathBuf>, Option<PathBuf>) {
    let mut logs: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    p.extension().is_some_and(|e| e == "log")
                        && p.file_name().is_some_and(|n| n != "mpv.log")
                })
                .collect()
        })
        .unwrap_or_default();
    logs.sort();
    logs.reverse();
    logs.truncate(APP_LOGS);
    let mpv = dir.join("mpv.log");
    (logs, mpv.exists().then_some(mpv))
}

pub fn build_report(version: &str) -> Result<String> {
    let mut out = String::new();
    writeln!(out, "streameoIPTV {version} diagnostics")?;
    writeln!(
        out,
        "OS: {} {}",
        std::env::consts::OS,
        std::env::consts::ARCH
    )?;
    writeln!(out, "Created: {}", chrono::Local::now().to_rfc3339())?;

    writeln!(out, "\n## Settings")?;
    let mut map: Vec<(String, String)> = sql::get_settings()?.into_iter().collect();
    map.sort();
    for (key, value) in map {
        if HIDDEN_SETTINGS.contains(&key.as_str()) {
            continue;
        }
        writeln!(out, "{key} = {}", redact(&value))?;
    }

    writeln!(out, "\n## Sources")?;
    for source in sql::get_sources()? {
        let id = source.id.unwrap_or_default();
        writeln!(
            out,
            "#{id} {} · enabled: {} · host: {} · channels: {} · last updated: {}",
            source_type_name(source.source_type),
            source.enabled,
            host_of(source.url.as_deref()),
            sql::get_channel_count_by_source(id).unwrap_or(0),
            source
                .last_updated
                .map(|t| t.to_string())
                .unwrap_or_else(|| "never".to_string()),
        )?;
    }

    writeln!(out, "\n## XMLTV guides")?;
    for status in xmltv::get_status().unwrap_or_default() {
        writeln!(
            out,
            "{} · updated: {:?} · programmes: {:?} · channels: {:?} · error: {}",
            host_of(Some(&status.url)),
            status.updated,
            status.programmes,
            status.channels,
            status.error.as_deref().map(redact).unwrap_or_default(),
        )?;
    }

    let dir = log::log_dir();
    let (logs, mpv) = log_files(&dir);
    for path in logs.iter().chain(mpv.iter()) {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string());
        writeln!(out, "\n## Log {}", name.unwrap_or_default())?;
        out.push_str(&log_tail(path));
    }
    Ok(out)
}

/// Writes the report to `path` (chosen in a save dialog).
pub fn export(version: &str, path: &str) -> Result<()> {
    let report = build_report(version)?;
    std::fs::write(path, report).context("failed to write the diagnostics file")?;
    Ok(())
}

#[cfg(test)]
mod test_diagnostics {
    use super::{host_of, log_files};

    #[test]
    fn test_host_only() {
        assert_eq!(
            host_of(Some(
                "http://user:pass@example.com:8080/get.php?username=u&password=p"
            )),
            "example.com"
        );
        assert_eq!(host_of(Some("C:/playlists/list.m3u")), "-");
        assert_eq!(host_of(None), "-");
    }

    #[test]
    fn test_newest_logs_first() {
        let dir = std::env::temp_dir().join(format!("streameo-diag-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for day in 1..=5 {
            std::fs::write(dir.join(format!("2026-09-0{day}-10-00-00.log")), "x").unwrap();
        }
        std::fs::write(dir.join("mpv.log"), "x").unwrap();
        let (logs, mpv) = log_files(&dir);
        let names: Vec<String> = logs
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(
            names,
            vec![
                "2026-09-05-10-00-00.log",
                "2026-09-04-10-00-00.log",
                "2026-09-03-10-00-00.log"
            ]
        );
        assert!(mpv.is_some());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
