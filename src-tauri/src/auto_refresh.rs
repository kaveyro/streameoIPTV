//! Automatic background source refresh.
//!
//! A tokio task (started from the app setup hook, next to the recording
//! scheduler) wakes up every 30 minutes, reads the `auto_refresh_hours`
//! setting and refreshes every enabled source whose `last_updated` is older
//! than the configured interval (a NULL `last_updated` counts as due).
//! Refreshing reuses `utils::refresh_source`, the same code path the manual
//! "Refresh"/"Refresh all" buttons and refresh-on-start use, which also
//! updates `sources.last_updated` on success.
//!
//! External XMLTV guides follow the same interval, or once a day when the
//! automatic source refresh is off: a guide only covers a few days, so
//! without it the TV guide would silently run empty. They are also checked
//! shortly after start, since the app is often closed for longer than that.

use std::time::Duration;

use anyhow::{Context, Result};
use tauri::{AppHandle, Emitter};

use crate::{log::log, settings, source_type, sql};

const POLL_INTERVAL: Duration = Duration::from_secs(30 * 60);
/// Delay of the XMLTV check after start, so it does not compete with the
/// first page of channels.
const START_DELAY: Duration = Duration::from_secs(20);
/// XMLTV refresh interval while the automatic source refresh is off.
const XMLTV_DEFAULT_HOURS: i64 = 24;

/// Event emitted after a round that refreshed at least one source.
/// Payload: the names of the refreshed sources.
pub const SOURCES_AUTO_REFRESHED_EVENT: &str = "sources-auto-refreshed";
/// Event emitted after the XMLTV guides were refreshed in the background.
pub const XMLTV_REFRESHED_EVENT: &str = "xmltv-refreshed";

/// Starts the background auto refresh loop. Called once from the tauri setup hook.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(START_DELAY).await;
        refresh_xmltv_if_due(&app).await;
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            if let Err(e) = tick(&app).await {
                log(format!("{:?}", e.context("auto refresh tick")));
            }
        }
    });
}

/// One auto refresh iteration: refresh every enabled, due source. Failures are
/// logged per source and do not abort the round.
async fn tick(app: &AppHandle) -> Result<()> {
    let hours = settings::get_settings()?.auto_refresh_hours.unwrap_or(0);
    if hours == 0 {
        refresh_xmltv_if_due(app).await;
        return Ok(());
    }
    let threshold = chrono::Utc::now().timestamp() - hours as i64 * 3600;
    let mut refreshed: Vec<String> = Vec::new();
    for source in sql::get_enabled_sources()? {
        // Custom sources have no upstream to refresh from.
        if source.source_type == source_type::CUSTOM {
            continue;
        }
        // NULL last_updated means the source was never refreshed: treat as due.
        if source.last_updated.is_some_and(|t| t > threshold) {
            continue;
        }
        let name = source.name.clone();
        // refresh_source updates sources.last_updated itself on success,
        // so no extra bookkeeping is needed here.
        match crate::utils::refresh_source(source).await {
            Ok(()) => refreshed.push(name),
            Err(e) => log(format!(
                "{:?}",
                e.context(format!("auto refresh failed for source {name}"))
            )),
        }
    }
    if !refreshed.is_empty() {
        app.emit(SOURCES_AUTO_REFRESHED_EVENT, &refreshed)
            .context("failed to emit sources-auto-refreshed")?;
    }
    refresh_xmltv_if_due(app).await;
    Ok(())
}

/// Refreshes the XMLTV guides once they are older than the refresh interval
/// (best-effort) and tells the frontend, whose EPG caches are then stale.
async fn refresh_xmltv_if_due(app: &AppHandle) {
    let hours = settings::get_settings()
        .ok()
        .and_then(|s| s.auto_refresh_hours)
        .filter(|h| *h > 0)
        .map(i64::from)
        .unwrap_or(XMLTV_DEFAULT_HOURS);
    match crate::xmltv::refresh_if_due(hours * 3600).await {
        Ok(true) => {
            if let Err(e) = app.emit(XMLTV_REFRESHED_EVENT, ()) {
                log(format!("failed to emit {XMLTV_REFRESHED_EVENT}: {e:?}"));
            }
        }
        Ok(false) => {}
        Err(e) => log(format!("{:?}", e.context("auto refresh xmltv"))),
    }
}
