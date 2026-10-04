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
use tauri::{AppHandle, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Mutex;

use crate::{
    log, source_type, sql,
    types::{AppState, Channel, EPG, EPGNotify, EpgCoverage, ProgrammeHit},
    utils, xmltv, xtream,
};

pub fn poll(mut to_watch: Vec<EPGNotify>, stop: Arc<AtomicBool>, app: AppHandle) -> Result<()> {
    let mut lead = reminder_lead_secs();
    let mut lead_read = std::time::Instant::now();
    while !stop.load(Relaxed) && !to_watch.is_empty() {
        // The setting may change while reminders wait; read it now and then.
        if lead_read.elapsed() >= Duration::from_secs(60) {
            lead = reminder_lead_secs();
            lead_read = std::time::Instant::now();
        }
        to_watch.retain(|epg| {
            let is_timestamp_over = match is_timestamp_over(epg.start_timestamp - lead) {
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
    let minutes = minutes_until(epg.start_timestamp, chrono::Utc::now().timestamp());
    // With a lead time the programme has not started yet.
    let body = if minutes > 0 {
        crate::native_strings::text(
            "reminder_soon_body",
            &[
                ("minutes", &minutes.to_string()),
                ("channel", &epg.channel_name),
            ],
        )
    } else {
        crate::native_strings::text("reminder_body", &[("channel", &epg.channel_name)])
    };
    app.notification()
        .builder()
        .title(crate::native_strings::text(
            "reminder_title",
            &[("title", &epg.title)],
        ))
        .body(body)
        .show()?;
    Ok(())
}

/// Whole minutes until `start`, rounded; 0 once it started.
fn minutes_until(start: i64, now: i64) -> i64 {
    ((start - now).max(0) + 30) / 60
}

/// How long before a programme its reminder fires (the setting, in seconds).
fn reminder_lead_secs() -> i64 {
    crate::settings::get_settings()
        .ok()
        .and_then(|s| s.reminder_lead_minutes)
        .map_or(0, |m| {
            i64::from(m.min(crate::settings::MAX_REMINDER_LEAD_MINUTES)) * 60
        })
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
    // Channels in locked groups are not counted: the numbers are shown
    // without the PIN.
    let channels = sql::get_live_channels_for_epg(false)?;
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
    let ids: Vec<&str> = by_id.keys().map(String::as_str).collect();
    let rows = sql::search_xmltv_programmes(
        query,
        &ids,
        now,
        now + SEARCH_DAYS * 86_400,
        SEARCH_LIMIT as u32,
    )?;
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

/// Quality rank of a feed name for the fallback order: 4K/UHD first, then
/// FHD, HD, unmarked, SD last.
fn quality_rank(name: &str) -> u8 {
    let lower = name.to_lowercase();
    let tokens: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect();
    let has = |t: &str| tokens.contains(&t);
    if has("4k") || has("uhd") {
        0
    } else if has("fhd") || (has("full") && has("hd")) {
        1
    } else if has("hd") {
        2
    } else if has("sd") {
        4
    } else {
        3
    }
}

/// Other feeds of the same channel in the same source ("HD: beIN Sports 1"
/// for "SD: beIN Sports 1"), best quality first, for the automatic fallback
/// when a live stream fails.
pub fn alternatives(channel: &Channel, show_locked: bool) -> Result<Vec<Channel>> {
    let Some(source_id) = channel.source_id else {
        return Ok(Vec::new());
    };
    let key = xmltv::normalize_name(&channel.name);
    if key.is_empty() {
        return Ok(Vec::new());
    }
    let mut out: Vec<Channel> = sql::get_live_channels_of_source(source_id, show_locked)?
        .into_iter()
        .filter(|c| c.id != channel.id && xmltv::normalize_name(&c.name) == key)
        .collect();
    out.sort_by(|a, b| {
        quality_rank(&a.name)
            .cmp(&quality_rank(&b.name))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

/// Applies the saved guide searches: a reminder, or a scheduled recording,
/// for every upcoming programme they find. Runs after each XMLTV refresh
/// check and when an alert is added. Idempotent: existing reminders are
/// skipped and the recording schedule refuses duplicates.
/// One alert run at a time: the 30-minute tick and a newly added alert must
/// not both schedule the same programme.
static ALERTS_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub async fn process_alerts(app: &AppHandle) -> Result<()> {
    let _running = ALERTS_LOCK.lock().await;
    let alerts = sql::get_epg_alerts()?;
    if alerts.is_empty() {
        return Ok(());
    }
    let now = chrono::Utc::now().timestamp();
    sql::prune_alert_applied(now)?;
    let mut added_reminder = false;
    for alert in alerts {
        let query = alert.query.clone();
        let hits = tokio::task::spawn_blocking(move || search_programmes(&query, false)).await??;
        for hit in hits {
            // One programme is often in two guides (SD and HD channel ids):
            // start time and title identify it. Each programme is handled
            // once, so what the user cancels or removes stays gone.
            let programme = format!("{}:{}", hit.start_timestamp, hit.title);
            if hit.start_timestamp <= now || !sql::mark_alert_applied(alert.id, &programme)? {
                continue;
            }
            match alert.action.as_str() {
                "record" => {
                    if let Some(channel_id) = hit.channel.id
                        && let Err(e) = crate::recording_scheduler::schedule(
                            channel_id,
                            Some(hit.title.clone()),
                            hit.start_timestamp,
                            hit.end_timestamp,
                        )
                    {
                        // Usually scheduled by hand already.
                        log::info(format!("guide alert: not scheduled: {e}"));
                    }
                }
                _ => {
                    let reminder = EPGNotify {
                        epg_id: hit.epg_id,
                        title: hit.title,
                        start_timestamp: hit.start_timestamp,
                        channel_name: hit.channel.name,
                    };
                    added_reminder |= sql::add_epg_if_missing(&reminder)?;
                }
            }
        }
    }
    if added_reminder {
        let state = app.state::<Mutex<AppState>>();
        restart_poller(&state, app.clone()).await?;
    }
    Ok(())
}

#[cfg(test)]
mod test_reminder {
    use super::minutes_until;

    #[test]
    fn test_minutes_until_the_programme() {
        assert_eq!(minutes_until(10_000, 10_000 - 600), 10);
        assert_eq!(minutes_until(10_000, 10_000 - 590), 10);
        assert_eq!(minutes_until(10_000, 10_000 - 20), 0);
        assert_eq!(minutes_until(10_000, 10_100), 0);
    }
}

#[cfg(test)]
mod test_epg_fallback {
    use super::quality_rank;

    #[test]
    fn test_quality_order() {
        let mut names = vec![
            "SD: beIN Sports 1",
            "beIN Sports 1",
            "HD: beIN Sports 1",
            "Full HD: beIN Sports 1",
            "beIN Sports 1 4K",
            "FHD beIN Sports 1",
        ];
        names.sort_by_key(|n| quality_rank(n));
        assert_eq!(
            names,
            vec![
                "beIN Sports 1 4K",
                "Full HD: beIN Sports 1",
                "FHD beIN Sports 1",
                "HD: beIN Sports 1",
                "beIN Sports 1",
                "SD: beIN Sports 1"
            ]
        );
    }
}
