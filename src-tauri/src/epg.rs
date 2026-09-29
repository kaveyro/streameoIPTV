use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering::Relaxed},
    },
    thread::{self, sleep},
    time::Duration,
};

use anyhow::{Context, Result};
use chrono::Local;
use tauri::{AppHandle, State};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Mutex;

use crate::{
    log, source_type, sql,
    types::{AppState, Channel, EPG, EPGNotify},
    utils, xmltv, xtream,
};

pub fn poll(mut to_watch: Vec<EPGNotify>, stop: Arc<AtomicBool>, app: AppHandle) -> Result<()> {
    while !stop.load(Relaxed) && !to_watch.is_empty() {
        to_watch.retain(|epg| {
            let is_timestamp_over = match is_timestamp_over(epg.start_timestamp) {
                Ok(v) => v,
                Err(e) => {
                    log::log(format!("{:?}", e));
                    return false;
                }
            };
            if is_timestamp_over {
                match notify(epg, &app).context("Failed to notify EPG") {
                    Ok(_) => {}
                    Err(e) => log::log(format!("{:?}", e)),
                }
                return false;
            }
            true
        });
        sleep(Duration::from_secs(1));
    }
    Ok(())
}

fn notify(epg: &EPGNotify, app: &AppHandle) -> Result<()> {
    app.notification()
        .builder()
        .title(format!("LIVE: {}", epg.title))
        .body(format!("Watch on {}", epg.channel_name))
        .show()?;
    Ok(())
}

fn is_timestamp_over(timestamp: i64) -> Result<bool> {
    let time = utils::get_local_time(timestamp)?;
    let current_time = Local::now();
    Ok(current_time >= time)
}

pub async fn add_epg(
    state: State<'_, Mutex<AppState>>,
    app: AppHandle,
    epg: EPGNotify,
) -> Result<()> {
    sql::clean_epgs()?;
    sql::add_epg(epg)?;
    restart_poller(&state, app).await
}

pub async fn remove_epg(
    state: State<'_, Mutex<AppState>>,
    app: AppHandle,
    epg_id: String,
) -> Result<()> {
    sql::clean_epgs()?;
    sql::remove_epg(epg_id)?;
    restart_poller(&state, app).await
}

/// Replaces the reminder poller with one for the current reminder list.
///
/// Every poller gets its own stop flag, so the old one can be signalled and
/// left to exit on its own (it sleeps up to a second) instead of joining it
/// while holding the app state lock, which stalled every player command.
/// Replacing instead of adding also means a second start (e.g. after a
/// WebView reload) cannot leave two pollers firing every notification twice.
async fn restart_poller(state: &State<'_, Mutex<AppState>>, app: AppHandle) -> Result<()> {
    let list = sql::get_epgs()?;
    let mut state = state.lock().await;
    state.notify_stop.store(true, Relaxed);
    state.thread_handle = None;
    if list.is_empty() {
        return Ok(());
    }
    let stop = Arc::new(AtomicBool::new(false));
    state.notify_stop = stop.clone();
    state.thread_handle = Some(thread::spawn(|| poll(list, stop, app)));
    Ok(())
}

/// Returns EPG for a channel, preferring the provider's own guide (Xtream) and
/// falling back to external XMLTV data matched by the channel's tvg-id.
pub async fn get_epg_combined(channel: Channel) -> Result<Vec<EPG>> {
    // Try the Xtream provider EPG first when applicable.
    if channel.stream_id.is_some() {
        let is_xtream = channel
            .source_id
            .and_then(|id| sql::get_source_from_id(id).ok())
            .map(|s| s.source_type == source_type::XTREAM)
            .unwrap_or(false);
        if is_xtream {
            match xtream::get_epg(channel.clone()).await {
                Ok(epg) if !epg.is_empty() => return Ok(epg),
                Ok(_) => {} // empty -> fall through to XMLTV
                Err(e) => log::log(format!("{:?}", e)),
            }
        }
    }

    // Fallback: external XMLTV. First match by tvg-id / epg_channel_id, then
    // by normalized channel name (Xtream providers often expose opaque
    // epg_channel_id hashes that never equal the XMLTV channel id).
    let now = chrono::Utc::now().timestamp();
    let mut programmes = Vec::new();
    if let Some(id) = channel.epg_channel_id.as_deref().filter(|s| !s.is_empty()) {
        programmes = xmltv::programmes_for_channel(id, now)?;
    }
    if programmes.is_empty() {
        let norm = xmltv::normalize_name(&channel.name);
        if !norm.is_empty()
            && let Some(id) = sql::get_xmltv_channel_id_by_name(&norm)?
        {
            programmes = xmltv::programmes_for_channel(&id, now)?;
        }
    }
    let epg_id = channel.epg_channel_id.clone().unwrap_or_default();
    let mut epgs = Vec::with_capacity(programmes.len());
    for p in programmes {
        let now_playing = p.now_playing(now);
        epgs.push(EPG {
            epg_id: epg_id.clone(),
            title: p.title,
            description: p.description,
            start_time: utils::get_local_time(p.start)?
                .format("%B %d, %H:%M")
                .to_string(),
            start_timestamp: p.start,
            end_time: utils::get_local_time(p.end)?
                .format("%B %d, %H:%M")
                .to_string(),
            end_timestamp: p.end,
            timeshift_url: None,
            has_archive: false,
            now_playing,
        });
    }
    Ok(epgs)
}

pub async fn on_start_check_epg(state: State<'_, Mutex<AppState>>, app: AppHandle) -> Result<()> {
    sql::clean_epgs()?;
    restart_poller(&state, app).await
}
