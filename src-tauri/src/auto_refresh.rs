//! Automatic background source refresh.
//!
//! A tokio task (started from the app setup hook, next to the recording
//! scheduler) wakes up every 30 minutes, reads the `auto_refresh_hours`
//! setting and refreshes every enabled source whose `last_updated` is older
//! than the configured interval (a NULL `last_updated` counts as due).
//! Refreshing reuses `utils::refresh_source`, the same code path the manual
//! "Refresh"/"Refresh all" buttons and refresh-on-start use, which also
//! updates `sources.last_updated` on success.

use std::time::Duration;

use anyhow::{Context, Result};
use tauri::{AppHandle, Emitter};

use crate::{log::log, settings, source_type, sql};

const POLL_INTERVAL: Duration = Duration::from_secs(30 * 60);

/// Event emitted after a round that refreshed at least one source.
/// Payload: the names of the refreshed sources.
pub const SOURCES_AUTO_REFRESHED_EVENT: &str = "sources-auto-refreshed";

/// Starts the background auto refresh loop. Called once from the tauri setup hook.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
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
    // Refresh external XMLTV EPG on the same schedule (best-effort).
    if !settings::get_xmltv_sources().unwrap_or_default().is_empty()
        && let Err(e) = crate::xmltv::refresh().await
    {
        log(format!("{:?}", e.context("auto refresh xmltv")));
    }
    Ok(())
}
