use std::{
    collections::HashMap,
    sync::{Arc, atomic::AtomicBool},
    thread::JoinHandle,
};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize, Default)]
pub struct Channel {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    pub name: String,
    pub url: Option<String>,
    pub group: Option<String>,
    pub image: Option<String>,
    pub media_type: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<i64>,
    pub favorite: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tv_archive: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub season_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub episode_num: Option<i64>,
    pub hidden: Option<bool>,
    /// XMLTV / tvg-id used to match external EPG data. None when unknown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub epg_channel_id: Option<String>,
    /// Channel number from the playlist (tvg-chno) or the Xtream provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<i64>,
    /// Movies and episodes: where the user stopped watching (seconds).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watch_position: Option<f64>,
    /// Length of the movie or episode as the player last saw it (seconds).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watch_duration: Option<f64>,
    /// Watched to the end.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watch_finished: Option<bool>,
}

/// How far a movie or episode was watched, keyed like `epg_mappings` by
/// source and stored URL (credential-free and stable across refreshes).
#[derive(Clone, PartialEq, Debug, Serialize)]
pub struct WatchProgress {
    pub source_id: i64,
    pub url: String,
    /// None when finished (or reset): the next play starts at the beginning.
    pub position: Option<f64>,
    pub duration: Option<f64>,
    pub finished: bool,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize, Default)]
pub struct Season {
    pub id: Option<i64>,
    pub name: String,
    pub season_number: i64,
    pub image: Option<String>,
    pub series_id: u64,
    pub source_id: i64,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct Source {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url_origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    pub source_type: u8,
    pub use_tvg_id: Option<bool>,
    pub enabled: bool,
    pub user_agent: Option<String>,
    pub max_streams: Option<u8>,
    pub stream_user_agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_updated: Option<i64>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct XtreamStatus {
    pub user_info: XtreamStatusUserInfo,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct XtreamStatusUserInfo {
    pub exp_date: serde_json::Value,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize, Default)]
pub struct Settings {
    pub recording_path: Option<String>,
    pub mpv_params: Option<String>,
    pub use_stream_caching: Option<bool>,
    pub default_view: Option<u8>,
    pub volume: Option<u8>,
    pub refresh_on_start: Option<bool>,
    pub restream_port: Option<u16>,
    pub enable_tray_icon: Option<bool>,
    pub zoom: Option<u16>,
    pub default_sort: Option<u8>,
    pub enable_hwdec: Option<bool>,
    pub always_ask_save: Option<bool>,
    pub enable_gpu: Option<bool>,
    pub preferred_subtitle_language: Option<String>,
    pub preferred_audio_language: Option<String>,
    pub theme: Option<String>,
    pub accent_color: Option<String>,
    pub use_external_player: Option<bool>,
    pub external_player_path: Option<String>,
    pub external_player_args: Option<String>,
    pub player_ui: Option<String>,
    pub normalize_volume: Option<bool>,
    pub auto_refresh_hours: Option<u16>,
    pub language: Option<String>,
    pub show_channel_source: Option<bool>,
    pub auto_update: Option<bool>,
    pub mpv_debug_log: Option<bool>,
    /// How channel names show their country prefix: "show", "hide" or "badge".
    #[serde(default)]
    pub country_prefix: Option<String>,
    /// Switch to another feed of the same channel when a live stream fails.
    #[serde(default)]
    pub auto_fallback: Option<bool>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct Filters {
    pub query: Option<String>,
    pub source_ids: Vec<i64>,
    pub media_types: Option<Vec<u8>>,
    pub view_type: u8,
    pub page: u32,
    pub series_id: Option<i64>,
    pub group_id: Option<i64>,
    pub use_keywords: bool,
    pub sort: u8,
    pub season: Option<i64>,
    /// Include groups locked by the parental PIN (the frontend sets it after
    /// the PIN was entered in this session).
    #[serde(default)]
    pub show_locked: bool,
    /// Only names with this country prefix ("TR" for "TR: Kanal D").
    #[serde(default)]
    pub country: Option<String>,
    /// In the favorites view: a favorites list instead of the favorites.
    #[serde(default)]
    pub favorite_list: Option<i64>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize, Default)]
pub struct ChannelHttpHeaders {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<i64>,
    pub referrer: Option<String>,
    pub user_agent: Option<String>,
    pub http_origin: Option<String>,
    pub ignore_ssl: Option<bool>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct CustomChannel {
    pub data: Channel,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<ChannelHttpHeaders>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct Group {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    pub name: String,
    pub image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<i64>,
    pub hidden: Option<bool>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct IdName {
    pub id: i64,
    pub name: String,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct CustomChannelExtraData {
    pub headers: Option<ChannelHttpHeaders>,
    pub group: Option<Group>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct ExportedGroup {
    pub group: Group,
    pub channels: Vec<CustomChannel>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct ExportedSource {
    pub source: Source,
    pub groups: Vec<ExportedGroup>,
    pub channels: Vec<CustomChannel>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct EPG {
    pub epg_id: String,
    pub title: String,
    pub description: String,
    pub start_time: String,
    pub start_timestamp: i64,
    pub end_time: String,
    pub end_timestamp: i64,
    pub timeshift_url: Option<String>,
    pub has_archive: bool,
    pub now_playing: bool,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct ScheduledRecording {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    pub channel_id: i64,
    pub title: Option<String>,
    pub start_timestamp: i64,
    pub end_timestamp: i64,
    pub status: u8,
    /// Filled by the listing queries only.
    #[serde(default)]
    pub channel_name: Option<String>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct EPGNotify {
    pub epg_id: String,
    pub title: String,
    pub start_timestamp: i64,
    pub channel_name: String,
}

#[derive(Debug, Default)]
pub struct AppState {
    pub notify_stop: Arc<AtomicBool>,
    pub thread_handle: Option<JoinHandle<Result<(), anyhow::Error>>>,
    pub restream_stop_signal: Arc<AtomicBool>,

    pub play_stop: HashMap<i64, IndexMap<String, CancellationToken>>,

    /// Embedded player (Windows): the native child window hosting mpv (stored as
    /// a raw HWND value, since HWND itself is not `Send`), the persistent mpv
    /// process, and the sender used to push JSON IPC commands to it.
    pub player_child_hwnd: Option<isize>,
    pub player_mpv: Option<tokio::process::Child>,
    pub player_ipc_tx: Option<tokio::sync::mpsc::UnboundedSender<serde_json::Value>>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct NetworkInfo {
    pub port: u16,
    pub local_ips: Vec<String>,
    pub wan_ip: String,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct ChannelPreserve {
    pub name: String,
    pub favorite: bool,
    pub last_watched: Option<usize>,
    pub hidden: Option<bool>,
    #[serde(default)]
    pub is_group: bool,
    /// Group locked by the parental PIN. A restore only ever adds locks.
    #[serde(default)]
    pub locked: bool,
    /// Place in the user's own favorites order.
    #[serde(default)]
    pub favorite_position: Option<i64>,
}

/// Xtream login found in an M3U link such as `http://host/get.php?username=u&password=p`.
#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct XtreamLogin {
    /// The player API of the same server, as an Xtream source stores it.
    pub url: String,
    pub username: String,
    pub password: String,
}

/// Result of the last refresh of one XMLTV source.
#[derive(Clone, PartialEq, Debug, Deserialize, Serialize, Default)]
pub struct XmltvSourceStatus {
    pub url: String,
    /// Unix seconds of the last successful load.
    pub updated: Option<i64>,
    pub programmes: Option<usize>,
    pub channels: Option<usize>,
    /// Why the last attempt failed; None when it worked.
    pub error: Option<String>,
}

/// How many live channels the XMLTV guides cover.
#[derive(Clone, PartialEq, Debug, Serialize, Default)]
pub struct EpgCoverage {
    pub live: usize,
    pub matched: usize,
}

/// An XMLTV channel offered when assigning a guide by hand.
#[derive(Clone, PartialEq, Debug, Serialize)]
pub struct XmltvChannelHit {
    pub id: String,
    /// Programmes that have not ended yet.
    pub programmes: i64,
    pub now_title: Option<String>,
}

/// A programme found by the guide search, with the channel that shows it.
#[derive(Clone, PartialEq, Debug, Serialize)]
pub struct ProgrammeHit {
    pub channel: Channel,
    /// Same id as the programme has in `get_epg`, for reminders.
    pub epg_id: String,
    pub title: String,
    pub description: String,
    pub start_timestamp: i64,
    pub end_timestamp: i64,
}

/// A country prefix of channel names and how many channels carry it.
#[derive(Clone, PartialEq, Debug, Serialize)]
pub struct CountryCount {
    pub code: String,
    pub count: usize,
}

/// A named favorites list besides the favorites themselves.
#[derive(Clone, PartialEq, Debug, Serialize)]
pub struct FavoriteList {
    pub id: i64,
    pub name: String,
    pub position: i64,
    pub count: i64,
}

/// A saved guide search: remind of, or record, every programme it finds.
#[derive(Clone, PartialEq, Debug, Serialize)]
pub struct EpgAlert {
    pub id: i64,
    pub query: String,
    /// "remind" or "record".
    pub action: String,
    pub created: i64,
}

/// A hand-made EPG assignment in a favorites backup.
#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct EpgMappingEntry {
    pub channel_name: String,
    pub xmltv_id: String,
}

/// A channel's place in a favorites list, in a favorites backup.
#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct FavoriteListEntry {
    pub list: String,
    pub channel_name: String,
    pub position: i64,
}

/// Favorites backup file, version 2. Version 1 was the bare `items` array.
#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct FavoritesBackup {
    pub version: u32,
    pub items: Vec<ChannelPreserve>,
    #[serde(default)]
    pub epg_mappings: Vec<EpgMappingEntry>,
    #[serde(default)]
    pub favorite_lists: Vec<FavoriteListEntry>,
}
