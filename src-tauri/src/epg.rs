use std::{
    collections::HashMap,
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
    types::{AppState, Channel, EPG, EPGNotify, EpgCoverage, ProgrammeHit},
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

/// Returns EPG for a channel: the XMLTV channel assigned by hand wins, then
/// the provider's own guide (Xtream), then external XMLTV data matched by the
/// channel's tvg-id or name.
pub async fn get_epg_combined(channel: Channel) -> Result<Vec<EPG>> {
    let mapped = match channel.source_id {
        Some(source_id) => sql::get_epg_mapping(source_id, &channel.name)?,
        None => None,
    };
    let is_mapped = mapped.is_some();
    // Try the Xtream provider EPG first when applicable.
    if !is_mapped && channel.stream_id.is_some() {
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
    let mut xmltv_id = String::new();
    if let Some(id) = mapped {
        programmes = xmltv::programmes_for_channel(&id, now)?;
        xmltv_id = id;
    } else if let Some(id) = channel.epg_channel_id.as_deref().filter(|s| !s.is_empty()) {
        programmes = xmltv::programmes_for_channel(id, now)?;
        xmltv_id = id.to_string();
    }
    // A channel assigned by hand keeps its choice, even while that guide is empty.
    if programmes.is_empty() && !is_mapped {
        let norm = xmltv::normalize_name(&channel.name);
        if !norm.is_empty() {
            let candidates = sql::get_xmltv_channel_candidates(&norm, now)?;
            if let Some(id) = xmltv::pick_channel(&channel.name, candidates) {
                programmes = xmltv::programmes_for_channel(&id, now)?;
                xmltv_id = id;
            }
        }
    }
    let mut epgs = Vec::with_capacity(programmes.len());
    for p in programmes {
        let now_playing = p.now_playing(now);
        epgs.push(EPG {
            // Reminders are keyed by this id, so it must name one programme.
            epg_id: format!("xmltv:{xmltv_id}:{}", p.start),
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

/// Matches many channels to XMLTV channel ids at once, the same way
/// [`get_epg_combined`] does for one, from data loaded up front.
pub struct EpgResolver {
    mappings: HashMap<(i64, String), String>,
    /// Upcoming programmes per XMLTV channel id.
    counts: HashMap<String, i64>,
    /// Normalized name -> XMLTV channel ids.
    index: HashMap<String, Vec<String>>,
}

impl EpgResolver {
    pub fn load(now: i64) -> Result<Self> {
        let mut index: HashMap<String, Vec<String>> = HashMap::new();
        for (norm, id) in sql::get_xmltv_name_index()? {
            index.entry(norm).or_default().push(id);
        }
        Ok(Self {
            mappings: sql::get_all_epg_mappings()?,
            counts: sql::get_xmltv_programme_counts(now)?,
            index,
        })
    }

    fn has_programmes(&self, id: &str) -> bool {
        self.counts.get(id).is_some_and(|c| *c > 0)
    }

    /// The XMLTV channel with upcoming programmes for a playlist channel.
    pub fn resolve(&self, channel: &Channel) -> Option<String> {
        if let Some(source_id) = channel.source_id
            && let Some(id) = self.mappings.get(&(source_id, channel.name.clone()))
        {
            return self.has_programmes(id).then(|| id.clone());
        }
        if let Some(id) = channel.epg_channel_id.as_deref().filter(|s| !s.is_empty())
            && self.has_programmes(id)
        {
            return Some(id.to_string());
        }
        let ids = self.index.get(&xmltv::normalize_name(&channel.name))?;
        let candidates = ids
            .iter()
            .map(|id| (id.clone(), self.counts.get(id).copied().unwrap_or(0)))
            .collect();
        xmltv::pick_channel(&channel.name, candidates)
    }
}

/// How many live channels of enabled sources the XMLTV guides cover.
pub fn coverage() -> Result<EpgCoverage> {
    let now = chrono::Utc::now().timestamp();
    let resolver = EpgResolver::load(now)?;
    let channels = sql::get_live_channels_for_epg(true)?;
    let matched = channels
        .iter()
        .filter(|c| resolver.resolve(c).is_some())
        .count();
    Ok(EpgCoverage {
        live: channels.len(),
        matched,
    })
}

/// How far ahead the guide search looks.
const SEARCH_DAYS: i64 = 7;
/// Most programmes a guide search returns.
const SEARCH_LIMIT: usize = 200;

/// Upcoming programmes whose title contains `query`, on the channels of the
/// playlist that show them (one channel per guide channel, favorites first).
/// Only the XMLTV guides are searched: provider EPG is fetched per channel.
pub fn search_programmes(query: &str, show_locked: bool) -> Result<Vec<ProgrammeHit>> {
    let query = query.trim();
    if query.chars().count() < 2 {
        return Ok(Vec::new());
    }
    let now = chrono::Utc::now().timestamp();
    let resolver = EpgResolver::load(now)?;
    let mut by_id: HashMap<String, Channel> = HashMap::new();
    for channel in sql::get_live_channels_for_epg(show_locked)? {
        if let Some(id) = resolver.resolve(&channel) {
            by_id.entry(id).or_insert(channel);
        }
    }
    if by_id.is_empty() {
        return Ok(Vec::new());
    }
    let rows = sql::search_xmltv_programmes(query, now, now + SEARCH_DAYS * 86_400, 5_000)?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, start, end, title, description)| {
            by_id.get(&id).map(|channel| ProgrammeHit {
                channel: channel.clone(),
                epg_id: format!("xmltv:{id}:{start}"),
                title,
                description: description.unwrap_or_default(),
                start_timestamp: start,
                end_timestamp: end,
            })
        })
        .take(SEARCH_LIMIT)
        .collect())
}
