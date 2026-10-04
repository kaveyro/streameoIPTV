//! Embedded, persistent mpv player (Windows).
//!
//! Instead of spawning a fresh mpv process in its own OS window on every channel
//! click (see [`crate::mpv::play`]), this module starts **one** mpv process,
//! embeds it into a native Win32 child window parented to the app's main window
//! via mpv's `--wid`, and drives it over mpv's JSON IPC (`--input-ipc-server`).
//! Switching channels is a single `loadfile` command over the pipe — mpv never
//! restarts, and the video stays inside the app.
//!
//! The frontend positions the video by sending the pixel rectangle of a DOM
//! placeholder to [`set_bounds`]. All per-channel behaviour (URL, HTTP headers,
//! title, caching, resume) is applied through IPC at play time so it never
//! requires relaunching mpv; only truly global options live in
//! [`crate::mpv::get_global_mpv_args`].
//!
//! Windows-only for now: `--wid` embedding is a Win32/X11 concept and is
//! unreliable on Wayland. On other platforms the commands return an error and
//! the app keeps using the classic spawn-per-click path.

use crate::types::{AppState, Channel, ChannelHttpHeaders, Settings, Source};
use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicIsize, AtomicU32, AtomicU64, Ordering};
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

#[cfg(target_os = "windows")]
use {
    std::process::Stdio,
    tauri::{Emitter, Manager},
    tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
};

/// IPC pipe for our mpv, unique per app run. With a fixed name a leftover mpv
/// from an earlier run keeps ownership of it, our client connects to that stale
/// process, and every command goes to an invisible player while the embedded
/// one sits idle showing a black surface - with no error anywhere.
static PIPE_NAME: LazyLock<String> =
    LazyLock::new(|| format!(r"\\.\pipe\streameo-mpv-{}", std::process::id()));

/// Request id carried by the `loadfile` command so the IPC reader can tell its
/// error reply apart from the property sets sent alongside it.
const LOADFILE_REQUEST_ID: u64 = 1;

/// mpv's built-in default user agent. The classic spawn-per-channel path simply
/// omits `--user-agent` when nothing is configured, but the embedded player
/// reuses one process, so the property has to be reset explicitly on every
/// channel - with this value rather than an empty string, which many providers
/// answer with 403.
const MPV_DEFAULT_USER_AGENT: &str = "libmpv";

/// Raw HWND of the native mpv host window, mirrored here so synchronous window
/// event / tray handlers (which cannot lock the async `AppState` mutex) can
/// show/hide it. 0 means "no player window".
static PLAYER_HWND: AtomicIsize = AtomicIsize::new(0);

/// Whether the host window floats as its own always-on-top window (the mini
/// player) instead of sitting inside the main window. The frontend's in-app
/// bounds are ignored meanwhile, and the tray keeps it visible.
static POPPED_OUT: AtomicBool = AtomicBool::new(false);

/// Settings key of the floating window's last position and size ("x,y,w,h",
/// physical screen pixels, outer window rectangle).
#[cfg(target_os = "windows")]
const POPOUT_BOUNDS: &str = "miniPlayerBounds";

/// For the host window procedure, which reports the floating window's close
/// button and caption double-click to the frontend.
#[cfg(target_os = "windows")]
static APP_HANDLE: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

/// The floating window's close button was pressed.
#[cfg(target_os = "windows")]
const POPOUT_CLOSE_EVENT: &str = "player-popout-close";
/// The floating window's caption was double-clicked: back into the app.
#[cfg(target_os = "windows")]
const POPOUT_DOCK_EVENT: &str = "player-popout-dock";

/// Process id of the embedded mpv, for the synchronous exit path. 0 means "no
/// player process".
static PLAYER_MPV_PID: AtomicU32 = AtomicU32::new(0);

/// A movie, or an episode with the ones after it, as the embedded player got
/// them: the stored URLs of its playlist, for saving the watch progress.
#[derive(Clone)]
struct VodSession {
    id: u64,
    source_id: i64,
    urls: Vec<String>,
}

/// The latest sessions. Progress replies of one just left may still be on
/// their way when the next one starts.
static VOD_SESSIONS: std::sync::Mutex<Vec<VodSession>> = std::sync::Mutex::new(Vec::new());
/// Id of the session playing now, 0 while no movie or episode is.
static CURRENT_VOD: AtomicU64 = AtomicU64::new(0);
static VOD_SEQ: AtomicU64 = AtomicU64::new(0);
const VOD_SESSIONS_KEPT: usize = 4;

/// Request ids from here on are progress queries: this plus the session id.
/// The reply names the session, so it is saved for the right movie even when
/// the player has moved on meanwhile.
const PROGRESS_REQUEST_BASE: u64 = 1 << 32;
/// Playlist index, position and length in one reply ("" when unavailable).
const PROGRESS_QUERY: &str = "${=playlist-pos}|${=time-pos:}|${=duration:}";
/// How often the progress is saved while a movie plays, so a crash or a
/// power cut loses at most this much.
#[cfg(target_os = "windows")]
const PROGRESS_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

/// The channel banner (number, name, now/next) drawn over the video with
/// mpv's `osd-overlay`, see [`show_banner`].
const BANNER_OVERLAY_ID: u64 = 1;
const BANNER_DURATION_MS: u64 = 5000;
/// A newer banner (or OSD message) replaced the one a hide timer is for.
static BANNER_SEQ: AtomicU64 = AtomicU64::new(0);
/// Banner text longer than this is cut: the banner does not wrap, and at 720
/// lines a 16:9 picture is only 1280 wide. The title is the largest text.
const BANNER_TITLE_MAX_CHARS: usize = 45;
const BANNER_LINE_MAX_CHARS: usize = 64;
const BANNER_DETAIL_MAX_CHARS: usize = 16;
const BANNER_FOOTER_MAX_CHARS: usize = 72;
/// The status in the middle of the picture ("Connecting…", "Buffering…"),
/// a second overlay so it does not replace the banner.
const STATUS_OVERLAY_ID: u64 = 2;

/// Whether the frontend shows the player view. The tray and single-instance
/// handlers bring the video window back only then: mpv stays alive while the
/// player is closed, and its window would cover the home page.
static PLAYER_SHOWN: AtomicBool = AtomicBool::new(false);

/// For the tray and window handlers, which run on the main thread and cannot
/// lock the async `AppState`. Weak, so destroy() dropping the real sender
/// still ends the IPC task.
static SYNC_TX: std::sync::Mutex<Option<tokio::sync::mpsc::WeakUnboundedSender<Value>>> =
    std::sync::Mutex::new(None);

/// mpv's `pause` property, as last reported.
static PAUSED: AtomicBool = AtomicBool::new(false);

/// Volume and mute of this session (-1: none yet), so a rebuilt mpv (crash,
/// changed player settings) keeps what the user set instead of starting
/// over at the volume from the settings.
static SESSION_VOLUME: AtomicI64 = AtomicI64::new(-1);
static SESSION_MUTE: AtomicI64 = AtomicI64::new(-1);

/// Source of the channel that plays (-1: none), so a starting recording can
/// tell it needs the same provider connection.
static CURRENT_SOURCE: AtomicI64 = AtomicI64::new(-1);

/// Source id under which local files (recordings, downloads) keep their
/// progress; real sources start at 1.
pub const LOCAL_FILE_SOURCE: i64 = 0;

/// Volume keys of the app (mpv's own 9/0 are channel digits here).
const VOLUME_KEYS: [(&str, &str); 4] = [
    ("+", "add volume 5"),
    ("KP_ADD", "add volume 5"),
    ("-", "add volume -5"),
    ("KP_SUBTRACT", "add volume -5"),
];

/// The player was paused because the window went to the tray, so showing it
/// again resumes (a pause of the user's own stays).
static PAUSED_BY_HIDE: AtomicBool = AtomicBool::new(false);

/// Serializes `init`: its liveness check and the state update are separate
/// lock scopes, so two overlapping calls (a double-click on a channel) would
/// both create a window and an mpv, leaving a stray black window behind.
#[cfg(target_os = "windows")]
static INIT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// mpv keys that control the app while the video has keyboard focus. The
/// WebView gets no key events then, so they come back as script-messages and
/// are forwarded to the frontend as a `player-key` event with the action.
/// The digits (channel number zapping) come back as `digit-N`. `i` shows the
/// channel banner again (mpv's stats stay on `I`), Home starts a movie over.
/// Enter confirms a typed number (mpv would skip in the playlist). Up/Down
/// depend on what plays, see [`arrow_keybinds`].
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const APP_KEYS: [(&str, &str); 28] = [
    ("PGDWN", "next"),
    ("PGUP", "prev"),
    ("ENTER", "commit"),
    ("KP_ENTER", "commit"),
    ("ESC", "back"),
    ("BS", "last"),
    ("i", "info"),
    ("HOME", "restart"),
    ("0", "digit-0"),
    ("1", "digit-1"),
    ("2", "digit-2"),
    ("3", "digit-3"),
    ("4", "digit-4"),
    ("5", "digit-5"),
    ("6", "digit-6"),
    ("7", "digit-7"),
    ("8", "digit-8"),
    ("9", "digit-9"),
    ("KP0", "digit-0"),
    ("KP1", "digit-1"),
    ("KP2", "digit-2"),
    ("KP3", "digit-3"),
    ("KP4", "digit-4"),
    ("KP5", "digit-5"),
    ("KP6", "digit-6"),
    ("KP7", "digit-7"),
    ("KP8", "digit-8"),
    ("KP9", "digit-9"),
];

/// mpv default keys that make no sense inside the app: quitting leaves a black
/// video area the app cannot tell from a slow stream, screenshots land
/// unnoticed in the working directory.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const IGNORED_KEYS: [&str; 11] = [
    "q",
    "Q",
    "POWER",
    "STOP",
    "CLOSE_WIN",
    "ctrl+w",
    "ctrl+c",
    "s",
    "S",
    "ctrl+s",
    "alt+s",
];

/// mpv properties behind the stream info in the player bar
/// (`player-stream-info`). Observed with the index as id.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const STREAM_INFO_PROPS: [&str; 5] = [
    "video-params",
    "video-format",
    "audio-codec-name",
    "video-bitrate",
    "container-fps",
];

/// What the player bar shows about the running stream.
#[derive(serde::Serialize, Clone, Default, PartialEq, Debug)]
struct StreamInfo {
    width: Option<u64>,
    height: Option<u64>,
    video_codec: Option<String>,
    audio_codec: Option<String>,
    /// Bits per second.
    bitrate: Option<f64>,
    fps: Option<f64>,
}

impl StreamInfo {
    /// Applies one `property-change`; returns whether something other than
    /// the bitrate changed (the bitrate changes all the time).
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    fn apply(&mut self, name: &str, data: &Value) -> bool {
        let before = self.clone();
        match name {
            "video-params" => {
                self.width = data.get("w").and_then(Value::as_u64);
                self.height = data.get("h").and_then(Value::as_u64);
            }
            "video-format" => self.video_codec = data.as_str().map(str::to_string),
            "audio-codec-name" => self.audio_codec = data.as_str().map(str::to_string),
            "video-bitrate" => {
                self.bitrate = data.as_f64();
                return false;
            }
            "container-fps" => self.fps = data.as_f64(),
            _ => return false,
        }
        before != *self
    }
}

/// Creates the native child window + persistent mpv process and wires up IPC.
/// Idempotent: a second call while a player already exists is a no-op.
pub async fn init(app: AppHandle, state: State<'_, Mutex<AppState>>) -> Result<()> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app, &state);
        anyhow::bail!("The embedded player is only available on Windows");
    }
    #[cfg(target_os = "windows")]
    {
        let _init = INIT_LOCK.lock().await;
        let _ = APP_HANDLE.set(app.clone());
        // Reuse a healthy player; tear down a dead one (mpv crashed, IPC pipe
        // broke) so this call rebuilds it instead of leaving a black window
        // whose commands go nowhere.
        if player_alive(&state).await {
            return Ok(());
        }
        destroy(app.clone(), state.clone()).await?;
        let parent: isize = app
            .get_webview_window("main")
            .context("no main window")?
            .hwnd()?
            .0 as isize;

        // Win32 window creation must happen on the thread that owns the event
        // loop, otherwise the window has no message pump (dead input/repaint).
        let (tx, rx) = std::sync::mpsc::channel::<isize>();
        app.run_on_main_thread(move || {
            let child = unsafe { win::create_child(parent, 0, 0, 1, 1) };
            let _ = tx.send(child);
        })?;
        let child_hwnd = rx.recv().context("failed to create player window")?;
        if child_hwnd == 0 {
            anyhow::bail!("failed to create the native player window");
        }
        PLAYER_HWND.store(child_hwnd, Ordering::SeqCst);

        let args = crate::mpv::get_global_mpv_args(child_hwnd, &PIPE_NAME)?;
        let mpv = tokio::process::Command::new(crate::mpv::get_mpv_path())
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                PLAYER_HWND.store(0, Ordering::SeqCst);
                crate::utils::friendly_spawn_error("mpv", e)
            })?;

        PLAYER_MPV_PID.store(mpv.id().unwrap_or(0), Ordering::SeqCst);

        let (ipc_tx, ipc_rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        tokio::spawn(run_ipc(app.clone(), PIPE_NAME.clone(), ipc_rx));

        // Route double-click and the `f` key to a script-message we catch on the
        // IPC read side and turn into app-level fullscreen (mpv's own fullscreen
        // does nothing for an embedded child window). Queued now; the IPC task
        // flushes them once it connects.
        let _ = ipc_tx.send(json!({
            "command": ["keybind", "MBTN_LEFT_DBL", "script-message streameo-fullscreen"]
        }));
        for key in ["f", "F11"] {
            let _ = ipc_tx.send(json!({
                "command": ["keybind", key, "script-message streameo-fullscreen"]
            }));
        }
        for (key, action) in VOLUME_KEYS {
            let _ = ipc_tx.send(json!({ "command": ["keybind", key, action] }));
        }
        for (key, action) in APP_KEYS {
            let _ = ipc_tx.send(json!({
                "command": ["keybind", key, format!("script-message streameo-key {action}")]
            }));
        }
        for key in IGNORED_KEYS {
            let _ = ipc_tx.send(json!({ "command": ["keybind", key, "ignore"] }));
        }
        // mpv seeks 10 s on the wheel, which is useless for live TV.
        let _ = ipc_tx.send(json!({ "command": ["keybind", "WHEEL_UP", "add volume 2"] }));
        let _ = ipc_tx.send(json!({ "command": ["keybind", "WHEEL_DOWN", "add volume -2"] }));
        for (id, prop) in STREAM_INFO_PROPS.iter().enumerate() {
            let _ = ipc_tx.send(json!({ "command": ["observe_property", id + 1, prop] }));
        }
        let _ = ipc_tx.send(json!({
            "command": ["observe_property", STREAM_INFO_PROPS.len() + 1, "paused-for-cache"]
        }));
        let _ = ipc_tx.send(json!({
            "command": ["observe_property", STREAM_INFO_PROPS.len() + 2, "pause"]
        }));
        for cmd in session_audio_commands() {
            let _ = ipc_tx.send(cmd);
        }
        for (offset, prop) in [(3, "volume"), (4, "mute")] {
            let _ = ipc_tx.send(json!({
                "command": ["observe_property", STREAM_INFO_PROPS.len() + offset, prop]
            }));
        }
        // Saves the progress of a running movie now and then. Holds only a
        // weak sender: destroy() dropping the real one ends the IPC task.
        {
            let weak = ipc_tx.downgrade();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(PROGRESS_INTERVAL).await;
                    let Some(tx) = weak.upgrade() else { break };
                    query_progress(&tx);
                }
            });
        }

        // mpv creates its video window (a WS_DISABLED child of our host) a moment
        // after spawn. Windows routes a disabled child's mouse/keyboard input to
        // the PARENT, so mpv sees nothing and the OSC never appears. Enable it as
        // soon as it exists so mpv handles input itself again — hover OSC, clicks
        // and the right-click functions all come back.
        {
            let app = app.clone();
            tokio::spawn(async move {
                for _ in 0..40 {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    let (tx, rx) = std::sync::mpsc::channel::<bool>();
                    if app
                        .run_on_main_thread(move || {
                            let _ = tx.send(unsafe { win::enable_child_input(child_hwnd) });
                        })
                        .is_err()
                    {
                        break;
                    }
                    if rx.recv().unwrap_or(false) {
                        break;
                    }
                }
            });
        }

        let mut s = state.lock().await;
        s.player_child_hwnd = Some(child_hwnd);
        s.player_mpv = Some(mpv);
        if let Ok(mut sync_tx) = SYNC_TX.lock() {
            *sync_tx = Some(ipc_tx.downgrade());
        }
        s.player_ipc_tx = Some(ipc_tx);
        Ok(())
    }
}

/// Switches the embedded player to `channel` without restarting mpv.
/// Returns where a movie or episode was resumed (seconds), if it was.
pub async fn play(
    app: AppHandle,
    channel: Channel,
    state: State<'_, Mutex<AppState>>,
) -> Result<Option<f64>> {
    // Without this check the commands below would be queued into a channel
    // nobody reads any more and the video area would simply stay black.
    if !player_alive(&state).await {
        destroy(app, state).await?;
        anyhow::bail!("the player is not running anymore");
    }
    let tx = state
        .lock()
        .await
        .player_ipc_tx
        .clone()
        .context("player not initialized")?;
    let source = channel
        .source_id
        .and_then(|id| crate::sql::get_source_from_id(id).ok());
    let headers = crate::sql::get_channel_headers_by_id(channel.id.context("no channel id")?)?;
    let settings = crate::settings::get_settings()?;
    let start = resume_position(&channel);
    let commands = build_play_commands(&channel, &source, headers, &settings, start)?;
    // The progress of what is left, before the session changes.
    query_progress(&tx);
    begin_vod_session(&channel);
    for cmd in commands {
        let _ = tx.send(cmd);
    }
    CURRENT_SOURCE.store(channel.source_id.unwrap_or(-1), Ordering::SeqCst);
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    crate::tray::set_now_playing(&app, Some(&channel.name));
    Ok(start)
}

/// Where a movie or episode was left, if it is to be resumed.
fn resume_position(channel: &Channel) -> Option<f64> {
    let (source_id, url) = (progress_source(channel)?, channel.url.as_deref()?);
    crate::sql::get_resume_position(source_id, url)
        .map_err(|e| crate::log::log(format!("{e:?}")))
        .ok()
        .flatten()
}

/// The source a movie or episode keeps its progress under: its own, or
/// `LOCAL_FILE_SOURCE` for a local file (recording, download). Live TV and
/// other pseudo channels (catch-up: its URL holds the login) keep none.
fn progress_source(channel: &Channel) -> Option<i64> {
    if channel.media_type == crate::media_type::LIVESTREAM {
        return None;
    }
    match channel.id? {
        id if id >= 0 => channel.source_id,
        _ if channel.source_id.is_none() && channel.url.as_deref().is_some_and(is_local_path) => {
            Some(LOCAL_FILE_SOURCE)
        }
        _ => None,
    }
}

fn is_local_path(url: &str) -> bool {
    !url.contains("://")
}

/// Makes `channel` the session whose progress is saved (none for live TV).
fn begin_vod_session(channel: &Channel) {
    let session = match (progress_source(channel), channel.url.clone()) {
        (Some(source_id), Some(url)) => {
            let mut urls = vec![url];
            // The episodes queued after it, in the order build_play_commands
            // appends them, so the playlist index finds the right one.
            if channel.episode_num.is_some() {
                urls.extend(crate::sql::find_all_episodes_after(channel).unwrap_or_default());
            }
            Some(VodSession {
                id: VOD_SEQ.fetch_add(1, Ordering::SeqCst) + 1,
                source_id,
                urls,
            })
        }
        _ => None,
    };
    let id = session.as_ref().map_or(0, |s| s.id);
    if let Some(session) = session
        && let Ok(mut sessions) = VOD_SESSIONS.lock()
    {
        sessions.push(session);
        let excess = sessions.len().saturating_sub(VOD_SESSIONS_KEPT);
        sessions.drain(..excess);
    }
    CURRENT_VOD.store(id, Ordering::SeqCst);
}

/// Asks mpv where the current movie is; the reply is saved by the IPC reader
/// ([`save_progress_reply`]). Nothing while live TV plays.
fn query_progress(tx: &tokio::sync::mpsc::UnboundedSender<Value>) {
    let id = CURRENT_VOD.load(Ordering::SeqCst);
    if id == 0 {
        return;
    }
    let _ = tx.send(json!({
        "command": ["expand-text", PROGRESS_QUERY],
        "request_id": PROGRESS_REQUEST_BASE + id,
    }));
}

/// Parses a [`PROGRESS_QUERY`] reply: playlist index, position, length.
fn parse_progress(data: &str) -> Option<(usize, f64, Option<f64>)> {
    let mut parts = data.split('|');
    let index = parts.next()?.trim().parse::<i64>().ok()?;
    let position = parts.next()?.trim().parse::<f64>().ok()?;
    let duration = parts.next().and_then(|d| d.trim().parse::<f64>().ok());
    Some((usize::try_from(index).ok()?, position, duration))
}

/// Saves the reply to a progress query and tells the frontend (the tiles'
/// progress bars).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn save_progress_reply(app: &AppHandle, request_id: u64, data: &str) {
    let session_id = request_id - PROGRESS_REQUEST_BASE;
    let session = VOD_SESSIONS
        .lock()
        .ok()
        .and_then(|s| s.iter().find(|s| s.id == session_id).cloned());
    let (Some(session), Some((index, position, duration))) = (session, parse_progress(data)) else {
        return;
    };
    let Some(url) = session.urls.get(index).cloned() else {
        return;
    };
    let app = app.clone();
    tokio::task::spawn_blocking(move || {
        match crate::sql::save_watch_progress(session.source_id, &url, position, duration) {
            Ok(Some(progress)) => {
                #[cfg(target_os = "windows")]
                let _ = app.emit("watch-progress", progress);
                #[cfg(not(target_os = "windows"))]
                let _ = (&app, progress);
            }
            Ok(None) => {}
            Err(e) => crate::log::log(format!("{e:?}")),
        }
    });
}

/// What the channel banner shows. The frontend puts the texts together (it
/// has the translations and the guide), the backend lays them out.
#[derive(Deserialize, Debug, Default, Clone)]
pub struct OsdBanner {
    pub number: Option<String>,
    pub title: String,
    /// Below the title, e.g. "20:00–20:15  Tagesschau".
    pub line: Option<String>,
    /// Dimmed after the line, e.g. "7 min left".
    pub detail: Option<String>,
    /// Progress bar under the line, 0..=1.
    pub progress: Option<f64>,
    /// Last, smaller line, e.g. "Next  20:15  Tatort".
    pub footer: Option<String>,
}

/// Text for an ASS event: override blocks and escapes stay literal, lines
/// become one (the banner does not wrap) and text over `max` characters is cut.
fn ass_text(text: &str, max: usize) -> String {
    let flat: String = text
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    let flat = flat.trim().to_string();
    let cut: String = if flat.chars().count() > max {
        let mut s: String = flat
            .chars()
            .take(max - 1)
            .collect::<String>()
            .trim_end()
            .to_string();
        s.push('…');
        s
    } else {
        flat
    };
    // Like mpv's own escaping: a word joiner after a backslash keeps it
    // from starting an escape, braces are escaped.
    cut.replace('\\', "\\\u{2060}")
        .replace('{', "\\{")
        .replace('}', "\\}")
}

/// The banner as ASS events at 720 lines: a dark, soft band over the top of
/// the picture with the texts on it.
fn banner_ass(banner: &OsdBanner) -> String {
    const X: i32 = 48;
    const TEXT: &str = "\\bord1.5\\shad0\\3c&H000000&";
    let mut events = Vec::new();
    let number = banner
        .number
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(|n| format!("{{\\1c&HF7AB4D&}}{}   {{\\1c&HFFFFFF&}}", ass_text(n, 6)))
        .unwrap_or_default();
    events.push(format!(
        "{{\\an7\\q2\\pos({X},34)\\fs40\\b1{TEXT}}}{number}{}",
        ass_text(&banner.title, BANNER_TITLE_MAX_CHARS)
    ));
    let mut y = 90;
    if let Some(line) = banner.line.as_deref().filter(|l| !l.trim().is_empty()) {
        let detail = banner
            .detail
            .as_deref()
            .filter(|d| !d.trim().is_empty())
            .map(|d| {
                format!(
                    "   {{\\1c&HC8C8C8&}}{}",
                    ass_text(d, BANNER_DETAIL_MAX_CHARS)
                )
            })
            .unwrap_or_default();
        events.push(format!(
            "{{\\an7\\q2\\pos({X},{y})\\fs27{TEXT}}}{}{detail}",
            ass_text(line, BANNER_LINE_MAX_CHARS)
        ));
        y += 40;
    }
    if let Some(progress) = banner.progress.filter(|p| p.is_finite()) {
        const WIDTH: f64 = 500.0;
        let done = (progress.clamp(0.0, 1.0) * WIDTH).round() as i32;
        let rest = WIDTH as i32 - done;
        if done > 0 {
            events.push(format!(
                "{{\\an7\\pos({X},{y})\\bord0\\shad0\\1c&HF7AB4D&\\p1}}m 0 0 l {done} 0 {done} 5 0 5{{\\p0}}"
            ));
        }
        if rest > 0 {
            events.push(format!(
                "{{\\an7\\pos({},{y})\\bord0\\shad0\\1c&HFFFFFF&\\1a&HA0&\\p1}}m 0 0 l {rest} 0 {rest} 5 0 5{{\\p0}}",
                X + done
            ));
        }
        y += 16;
    }
    if let Some(footer) = banner.footer.as_deref().filter(|f| !f.trim().is_empty()) {
        events.push(format!(
            "{{\\an7\\q2\\pos({X},{y})\\fs24\\bord1.2\\shad0\\3c&H000000&\\1c&HDCDCDC&}}{}",
            ass_text(footer, BANNER_FOOTER_MAX_CHARS)
        ));
        y += 34;
    }
    let band = y + 34;
    events.insert(
        0,
        format!(
            "{{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H000000&\\1a&H50&\\blur30\\p1}}m 0 0 l 6000 0 6000 {band} 0 {band}{{\\p0}}"
        ),
    );
    events.join("\n")
}

/// Shows the channel banner over the video for a few seconds. Like the OSD
/// messages it is drawn by mpv: the native video window covers the WebView.
pub async fn show_banner(state: State<'_, Mutex<AppState>>, banner: OsdBanner) -> Result<()> {
    let Some(tx) = state.lock().await.player_ipc_tx.clone() else {
        return Ok(());
    };
    let seq = BANNER_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    // A message still up (the typed channel number) would sit on top of it.
    let _ = tx.send(json!({ "command": ["show-text", "", 1] }));
    let _ = tx.send(json!({ "command": {
        "name": "osd-overlay",
        "id": BANNER_OVERLAY_ID,
        "format": "ass-events",
        "data": banner_ass(&banner),
        "res_x": 0,
        "res_y": 720,
        "z": 0,
    }}));
    let weak = tx.downgrade();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(BANNER_DURATION_MS)).await;
        if BANNER_SEQ.load(Ordering::SeqCst) == seq
            && let Some(tx) = weak.upgrade()
        {
            hide_banner(&tx);
        }
    });
    Ok(())
}

fn hide_banner(tx: &tokio::sync::mpsc::UnboundedSender<Value>) {
    let _ = tx.send(json!({ "command": {
        "name": "osd-overlay",
        "id": BANNER_OVERLAY_ID,
        "format": "none",
        "data": "",
    }}));
}

/// Shows a short status in the middle of the picture ("Connecting…"), or
/// removes it with `None`. The frontend decides when (it debounces) and
/// translates the text.
pub async fn show_status(state: State<'_, Mutex<AppState>>, text: Option<String>) -> Result<()> {
    let Some(tx) = state.lock().await.player_ipc_tx.clone() else {
        return Ok(());
    };
    let _ = tx.send(status_overlay(text.as_deref()));
    Ok(())
}

/// Each line of a status (an error and the keys that help) on its own OSD
/// line, each cut to fit.
fn status_lines(text: &str) -> String {
    text.lines()
        .map(|line| ass_text(line, BANNER_LINE_MAX_CHARS))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\\N")
}

fn status_overlay(text: Option<&str>) -> Value {
    match text.map(str::trim).filter(|t| !t.is_empty()) {
        Some(text) => json!({ "command": {
            "name": "osd-overlay",
            "id": STATUS_OVERLAY_ID,
            "format": "ass-events",
            "data": format!(
                "{{\\an5\\fs34\\bord2\\shad0\\3c&H000000&\\1c&HFFFFFF&}}{}",
                status_lines(text)
            ),
            "res_x": 0,
            "res_y": 720,
            "z": 1,
        }}),
        None => json!({ "command": {
            "name": "osd-overlay",
            "id": STATUS_OVERLAY_ID,
            "format": "none",
            "data": "",
        }}),
    }
}

/// Changes the volume of the running player (the setting itself only applies
/// when mpv is started).
pub async fn set_volume(state: State<'_, Mutex<AppState>>, volume: u8) -> Result<()> {
    if let Some(tx) = state.lock().await.player_ipc_tx.clone() {
        let _ = tx.send(set_prop("volume", json!(volume.min(100))));
    }
    Ok(())
}

/// Pause and mute from the app's keys while the WebView has focus (mpv has
/// the same keys itself when the video has it).
pub async fn command(state: State<'_, Mutex<AppState>>, command: &str) -> Result<()> {
    let cmd = player_command(command).with_context(|| format!("unknown command {command}"))?;
    if let Some(tx) = state.lock().await.player_ipc_tx.clone() {
        let _ = tx.send(cmd);
    }
    Ok(())
}

fn player_command(command: &str) -> Option<Value> {
    Some(match command {
        "toggle_pause" => json!({ "command": ["cycle", "pause"] }),
        "toggle_mute" => json!({ "command": ["cycle", "mute"] }),
        "volume_up" => json!({ "command": ["add", "volume", 5] }),
        "volume_down" => json!({ "command": ["add", "volume", -5] }),
        "seek_forward" => json!({ "command": ["seek", 60] }),
        "seek_back" => json!({ "command": ["seek", -60] }),
        _ => return None,
    })
}

/// Restores the session's volume and mute in a new mpv.
fn session_audio_commands() -> Vec<Value> {
    let mut commands = Vec::new();
    let volume = SESSION_VOLUME.load(Ordering::SeqCst);
    if volume >= 0 {
        commands.push(set_prop("volume", json!(volume)));
    }
    let mute = SESSION_MUTE.load(Ordering::SeqCst);
    if mute >= 0 {
        commands.push(set_prop("mute", json!(mute == 1)));
    }
    commands
}

/// The source the embedded player streams from while its view is open.
pub fn playing_source() -> Option<i64> {
    let source = CURRENT_SOURCE.load(Ordering::SeqCst);
    (PLAYER_SHOWN.load(Ordering::SeqCst) && source >= 0).then_some(source)
}

/// Starts the movie or episode over.
pub async fn restart(state: State<'_, Mutex<AppState>>) -> Result<()> {
    if let Some(tx) = state.lock().await.player_ipc_tx.clone() {
        let _ = tx.send(json!({ "command": ["seek", 0, "absolute"] }));
    }
    Ok(())
}

/// True while mpv is still running and its IPC channel is still connected.
async fn player_alive(state: &State<'_, Mutex<AppState>>) -> bool {
    let mut s = state.lock().await;
    if s.player_ipc_tx.is_none() {
        return false;
    }
    match s.player_mpv.as_mut() {
        // try_wait yields Ok(Some(status)) once the process has exited.
        Some(child) => child.try_wait().ok().flatten().is_none(),
        None => false,
    }
}

/// Shows a message on mpv's own on-screen display. The native video window
/// always composites above the WebView, so a DOM toast placed over the video
/// area is invisible while the player is open - mpv's OSD is the only surface
/// that is guaranteed to be seen, fullscreen included.
pub async fn show_message(state: State<'_, Mutex<AppState>>, message: String) -> Result<()> {
    if let Some(tx) = state.lock().await.player_ipc_tx.clone() {
        // The message would sit on the banner: it goes.
        BANNER_SEQ.fetch_add(1, Ordering::SeqCst);
        hide_banner(&tx);
        let _ = tx.send(json!({ "command": ["show-text", message, 6000] }));
    }
    Ok(())
}

/// Unloads the current file but keeps mpv alive and idle.
pub async fn stop(state: State<'_, Mutex<AppState>>) -> Result<()> {
    if let Some(tx) = state.lock().await.player_ipc_tx.clone() {
        query_progress(&tx);
        CURRENT_VOD.store(0, Ordering::SeqCst);
        BANNER_SEQ.fetch_add(1, Ordering::SeqCst);
        hide_banner(&tx);
        let _ = tx.send(status_overlay(None));
        let _ = tx.send(json!({ "command": ["stop"] }));
    }
    PAUSED_BY_HIDE.store(false, Ordering::SeqCst);
    CURRENT_SOURCE.store(-1, Ordering::SeqCst);
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if let Some(app) = APP_HANDLE.get() {
        crate::tray::set_now_playing(app, None);
    }
    Ok(())
}

/// Positions/resizes the native video window (physical pixels, parent client
/// space). Re-asserts top z-order so it stays above the WebView content.
pub async fn set_bounds(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        // The floating window is placed by the user, not by the page.
        if POPPED_OUT.load(Ordering::SeqCst) {
            return Ok(());
        }
        let child = state.lock().await.player_child_hwnd;
        if let Some(child) = child {
            app.run_on_main_thread(move || unsafe { win::set_bounds(child, x, y, w, h) })?;
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (&app, &state, x, y, w, h);
    Ok(())
}

/// Whether the video floats in its own window (the mini player).
pub fn is_popped_out() -> bool {
    POPPED_OUT.load(Ordering::SeqCst)
}

/// Moves the video out of the main window into a small always-on-top window
/// the user can drag and resize anywhere on the desktop (`popout`), or back
/// into the main window. mpv keeps playing: only its host window changes
/// parent. Called again while floating, it just updates the window title.
pub async fn set_popout(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
    popout: bool,
    title: Option<String>,
) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        let Some(child) = state.lock().await.player_child_hwnd else {
            return Ok(());
        };
        let main: isize = app
            .get_webview_window("main")
            .context("no main window")?
            .hwnd()?
            .0 as isize;
        let title = title.unwrap_or_default();
        if popout {
            if POPPED_OUT.swap(true, Ordering::SeqCst) {
                app.run_on_main_thread(move || unsafe { win::set_title(child, &title) })?;
                return Ok(());
            }
            let saved = crate::sql::get_settings()
                .ok()
                .and_then(|map| map.get(POPOUT_BOUNDS).and_then(|v| parse_bounds(v)));
            app.run_on_main_thread(move || unsafe { win::pop_out(child, main, saved, &title) })?;
            // Dragging the picture moves the floating window.
            set_drag_binding(&state, true).await;
        } else if POPPED_OUT.swap(false, Ordering::SeqCst) {
            set_drag_binding(&state, false).await;
            let (tx, rx) = std::sync::mpsc::channel();
            app.run_on_main_thread(move || {
                let _ = tx.send(unsafe { win::dock(child, main) });
            })?;
            if let Ok((x, y, w, h)) = rx.recv() {
                let map = std::collections::HashMap::from([(
                    POPOUT_BOUNDS.to_string(),
                    Some(format!("{x},{y},{w},{h}")),
                )]);
                if let Err(e) = crate::sql::update_settings(map) {
                    crate::log::warn(format!(
                        "{:?}",
                        e.context("saving the mini player position")
                    ));
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (&app, &state, popout, title);
    Ok(())
}

/// Binds a left press in the video to `streameo-drag` while the video floats,
/// and gives the button back to mpv (unbound) inside the app.
#[cfg(target_os = "windows")]
async fn set_drag_binding(state: &State<'_, Mutex<AppState>>, drag: bool) {
    let Some(tx) = state.lock().await.player_ipc_tx.clone() else {
        return;
    };
    let command = if drag {
        "script-message streameo-drag"
    } else {
        "ignore"
    };
    let _ = tx.send(json!({ "command": ["keybind", "MBTN_LEFT", command] }));
}

/// Starts moving the floating window with the mouse (the button is held in
/// mpv's video window, which belongs to another process).
#[cfg(target_os = "windows")]
fn begin_drag(app: &AppHandle) {
    if !POPPED_OUT.load(Ordering::SeqCst) {
        return;
    }
    let host = PLAYER_HWND.load(Ordering::SeqCst);
    if host == 0 {
        return;
    }
    let _ = app.run_on_main_thread(move || unsafe { win::begin_drag(host) });
}

/// Parses the stored "x,y,w,h" of the floating window.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_bounds(value: &str) -> Option<(i32, i32, i32, i32)> {
    let parts: Vec<i32> = value
        .split(',')
        .map(|p| p.trim().parse().ok())
        .collect::<Option<Vec<i32>>>()?;
    match parts[..] {
        [x, y, w, h] if w > 0 && h > 0 => Some((x, y, w, h)),
        _ => None,
    }
}

/// Tells the frontend what happened in the floating window's frame.
#[cfg(target_os = "windows")]
fn emit_popout(event: &str) {
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit(event, ());
    }
}

/// Shows or hides the native video window (used when entering/leaving the
/// player view so it never floats over the app when the view is not shown).
pub async fn set_visible(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
    visible: bool,
) -> Result<()> {
    PLAYER_SHOWN.store(visible, Ordering::SeqCst);
    #[cfg(target_os = "windows")]
    {
        let child = state.lock().await.player_child_hwnd;
        if let Some(child) = child {
            app.run_on_main_thread(move || unsafe {
                win::show(child, visible);
                // Re-assert input on the mpv child after it becomes visible again
                // (e.g. restored from tray), so the OSC keeps working.
                if visible {
                    win::enable_child_input(child);
                }
            })?;
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (&app, &state, visible);
    Ok(())
}

/// Synchronous show/hide for the window-event / tray handlers, which run on the
/// main thread already and cannot lock the async `AppState` mutex. Showing
/// only brings the video back when the player view is open.
pub fn set_visible_sync(visible: bool) {
    if !may_show(visible) {
        return;
    }
    #[cfg(target_os = "windows")]
    {
        let child = PLAYER_HWND.load(Ordering::SeqCst);
        if child != 0 {
            unsafe { win::show(child, visible) };
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = visible;
}

/// The window goes to the tray: pause what plays (an invisible app should not
/// keep talking). The floating mini player is meant to keep playing.
pub fn pause_for_hide() {
    if !PLAYER_SHOWN.load(Ordering::SeqCst)
        || POPPED_OUT.load(Ordering::SeqCst)
        || PAUSED.load(Ordering::SeqCst)
    {
        return;
    }
    if send_sync(set_prop("pause", json!(true))) {
        PAUSED_BY_HIDE.store(true, Ordering::SeqCst);
    }
}

/// The window is back: resume what `pause_for_hide` paused.
pub fn resume_after_show() {
    if PAUSED_BY_HIDE.swap(false, Ordering::SeqCst) {
        send_sync(set_prop("pause", json!(false)));
    }
}

/// Pause/resume from the tray menu.
pub fn toggle_pause_sync() {
    PAUSED_BY_HIDE.store(false, Ordering::SeqCst);
    if let Some(cmd) = player_command("toggle_pause") {
        send_sync(cmd);
    }
}

fn send_sync(cmd: Value) -> bool {
    SYNC_TX
        .lock()
        .ok()
        .and_then(|tx| tx.as_ref().and_then(|weak| weak.upgrade()))
        .is_some_and(|tx| tx.send(cmd).is_ok())
}

/// Hiding is always fine; showing only while the player view is open.
fn may_show(visible: bool) -> bool {
    !visible || PLAYER_SHOWN.load(Ordering::SeqCst)
}

/// Kills the embedded mpv from the process-exit path, where the async state is
/// never dropped (so `kill_on_drop` does not fire) and locking it is not
/// possible. A surviving mpv would keep a provider connection open and hold on
/// to the IPC pipe.
pub fn kill_sync() {
    let pid = PLAYER_MPV_PID.swap(0, Ordering::SeqCst);
    if pid == 0 {
        return;
    }
    #[cfg(target_os = "windows")]
    unsafe {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_TERMINATE, TerminateProcess,
        };
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !handle.is_null() {
            TerminateProcess(handle, 0);
            CloseHandle(handle);
        }
    }
}

/// Tears down the player: kills mpv and destroys the native window.
pub async fn destroy(app: AppHandle, state: State<'_, Mutex<AppState>>) -> Result<()> {
    if CURRENT_VOD.load(Ordering::SeqCst) != 0 {
        let tx = state.lock().await.player_ipc_tx.clone();
        if let Some(tx) = tx {
            query_progress(&tx);
            // Give mpv a moment to answer before it is killed.
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
    }
    CURRENT_VOD.store(0, Ordering::SeqCst);
    PAUSED.store(false, Ordering::SeqCst);
    PAUSED_BY_HIDE.store(false, Ordering::SeqCst);
    CURRENT_SOURCE.store(-1, Ordering::SeqCst);
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    crate::tray::set_now_playing(&app, None);
    let (child, mpv) = {
        let mut s = state.lock().await;
        s.player_ipc_tx = None; // dropping the sender ends the IPC task
        (s.player_child_hwnd.take(), s.player_mpv.take())
    };
    PLAYER_MPV_PID.store(0, Ordering::SeqCst);
    POPPED_OUT.store(false, Ordering::SeqCst);
    PLAYER_SHOWN.store(false, Ordering::SeqCst);
    if let Some(mut mpv) = mpv {
        let _ = mpv.kill().await;
    }
    #[cfg(target_os = "windows")]
    if let Some(child) = child {
        PLAYER_HWND.store(0, Ordering::SeqCst);
        let _ = app.run_on_main_thread(move || unsafe { win::destroy(child) });
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (&app, child);
    Ok(())
}

/// Builds the JSON IPC commands to play `channel`: per-stream properties first
/// (headers, title, caching, resume), then `loadfile`. Every relevant property
/// is set on every play — including to an empty/default value when the channel
/// lacks it — so nothing leaks from the previously played channel.
fn build_play_commands(
    channel: &Channel,
    source: &Option<Source>,
    headers: Option<ChannelHttpHeaders>,
    settings: &Settings,
    start: Option<f64>,
) -> Result<Vec<Value>> {
    let url = crate::mpv::channel_stream_url(channel)?;
    let h = headers.unwrap_or_default();
    let mut cmds: Vec<Value> = Vec::new();

    // Close the running stream before opening the next one. Providers commonly
    // allow a single connection per subscription, and `loadfile ... replace`
    // on its own opens the new connection while the old one is still up - the
    // provider then refuses it and the player stays black.
    cmds.push(json!({ "command": ["stop"] }));

    cmds.push(set_prop("force-media-title", json!(channel.name)));

    let mut header_fields: Vec<String> = Vec::new();
    if let Some(origin) = h.http_origin {
        header_fields.push(format!("origin: {origin}"));
    }
    if let Some(referrer) = h.referrer {
        header_fields.push(format!("referer: {referrer}"));
    }
    cmds.push(set_prop("http-header-fields", json!(header_fields)));

    let user_agent = h
        .user_agent
        .or_else(|| source.as_ref().and_then(|s| s.stream_user_agent.clone()))
        .map(|ua| ua.trim().to_string())
        .filter(|ua| !ua.is_empty())
        .unwrap_or_else(|| MPV_DEFAULT_USER_AGENT.to_string());
    cmds.push(set_prop("user-agent", json!(user_agent)));

    // TLS verification is left alone, exactly like the classic path: mpv has no
    // "stream-tls-verify" property (setting it only produced "property not
    // found"), and the per-channel opt-out below is the documented way.
    let ytdl_raw = if h.ignore_ssl == Some(true) {
        "no-check-certificates="
    } else {
        ""
    };
    cmds.push(set_prop("ytdl-raw-options", json!(ytdl_raw)));

    let cache = if settings.use_stream_caching == Some(false) {
        "no"
    } else {
        "auto"
    };
    cmds.push(set_prop("cache", json!(cache)));

    let is_live = channel.media_type == crate::media_type::LIVESTREAM;
    cmds.extend(arrow_keybinds(is_live));
    cmds.push(set_prop(
        "loop-playlist",
        json!(if is_live { "inf" } else { "no" }),
    ));

    // Providers serve live streams as HTTP 206 responses with a fixed content
    // length, so mpv takes them for seekable files: FFmpeg then seeks to the end
    // to estimate the duration, which opens a second connection the provider
    // does not grant. The demuxer waits there forever - no error, no end-file,
    // just a black video area - which is why only the first channel of a
    // session used to play. Skipping the probe removes that seek.
    cmds.push(set_prop(
        "demuxer-lavf-probe-info",
        json!(if is_live { "nostreams" } else { "auto" }),
    ));

    // The resume point as an option of this file only: set as a property it
    // would also apply to the episodes queued after it.
    let loadfile = match start {
        Some(start) => json!(["loadfile", url, "replace", -1, format!("start={start}")]),
        None => json!(["loadfile", url, "replace"]),
    };
    cmds.push(json!({
        "command": loadfile,
        "request_id": LOADFILE_REQUEST_ID,
    }));

    // Series: queue the following episodes so playback continues automatically,
    // mirroring the playlist the classic path builds in get_play_args.
    if channel.episode_num.is_some() {
        for ep_url in crate::mpv::episode_urls_after(channel)? {
            cmds.push(json!({ "command": ["loadfile", ep_url, "append"] }));
        }
    }

    Ok(cmds)
}

/// Up/Down switch channels on live TV, like in the app; in a movie, an
/// episode or a recording they keep seeking a minute, as mpv does.
fn arrow_keybinds(is_live: bool) -> [Value; 2] {
    let (up, down) = if is_live {
        (
            "script-message streameo-key prev",
            "script-message streameo-key next",
        )
    } else {
        ("seek 60", "seek -60")
    };
    [
        json!({ "command": ["keybind", "UP", up] }),
        json!({ "command": ["keybind", "DOWN", down] }),
    ]
}

/// What a `paused-for-cache` change means for the status over the video.
/// `buffering` is the last value seen. Unavailable (no file loaded, `None`)
/// says nothing: the end of "connecting" is the first frame
/// (`playback-restart`), not the property turning false while a file opens.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn cache_status(buffering: &mut bool, value: Option<bool>) -> Option<&'static str> {
    match value {
        Some(true) if !*buffering => {
            *buffering = true;
            Some("buffering")
        }
        Some(false) if *buffering => {
            *buffering = false;
            Some("playing")
        }
        None => {
            *buffering = false;
            None
        }
        _ => None,
    }
}

fn set_prop(name: &str, value: Value) -> Value {
    json!({ "command": ["set_property", name, value] })
}

#[cfg(target_os = "windows")]
async fn run_ipc(
    app: AppHandle,
    pipe: String,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<Value>,
) {
    let client = match connect_pipe(&pipe).await {
        Ok(c) => c,
        Err(e) => {
            crate::log::log(format!("mpv IPC connect failed: {e:?}"));
            handle_player_lost(&app).await;
            return;
        }
    };
    crate::log::info(format!("mpv IPC connected on {pipe}"));
    let (reader, mut writer) = tokio::io::split(client);
    // Read mpv's responses/events (also keeps the pipe buffer from blocking
    // writes): turn our fullscreen script-message into a frontend event, and
    // report playback failures - mpv's own output is not captured, so this is
    // the only place a dead link, an HTTP error or a connection refused by the
    // provider can be noticed at all.
    let reader_app = app.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        let mut info = StreamInfo::default();
        let mut buffering = false;
        let mut info_sent = std::time::Instant::now();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match v.get("event").and_then(Value::as_str) {
                Some("client-message") => {
                    let args: Vec<&str> = v
                        .get("args")
                        .and_then(Value::as_array)
                        .map(|a| a.iter().filter_map(Value::as_str).collect())
                        .unwrap_or_default();
                    match args.as_slice() {
                        ["streameo-fullscreen", ..] => {
                            let _ = reader_app.emit("player-toggle-fullscreen", ());
                        }
                        ["streameo-key", action, ..]
                            if APP_KEYS.iter().any(|(_, a)| a == action) =>
                        {
                            let _ = reader_app.emit("player-key", action.to_string());
                        }
                        ["streameo-drag", ..] => begin_drag(&reader_app),
                        _ => {}
                    }
                }
                // Stream info for the player bar; the bitrate at most every 3 s.
                Some("property-change")
                    if v.get("name").and_then(Value::as_str) == Some("pause") =>
                {
                    let paused = v.get("data").and_then(Value::as_bool).unwrap_or(false);
                    PAUSED.store(paused, Ordering::SeqCst);
                }
                Some("property-change")
                    if v.get("name").and_then(Value::as_str) == Some("volume") =>
                {
                    if let Some(volume) = v.get("data").and_then(Value::as_f64) {
                        SESSION_VOLUME.store(volume.round() as i64, Ordering::SeqCst);
                    }
                }
                Some("property-change")
                    if v.get("name").and_then(Value::as_str) == Some("mute") =>
                {
                    if let Some(mute) = v.get("data").and_then(Value::as_bool) {
                        SESSION_MUTE.store(mute as i64, Ordering::SeqCst);
                    }
                }
                Some("property-change")
                    if v.get("name").and_then(Value::as_str) == Some("paused-for-cache") =>
                {
                    let value = v.get("data").and_then(Value::as_bool);
                    if let Some(status) = cache_status(&mut buffering, value) {
                        let _ = reader_app.emit("player-status", status);
                    }
                }
                Some("property-change") => {
                    let name = v.get("name").and_then(Value::as_str).unwrap_or_default();
                    let data = v.get("data").cloned().unwrap_or(Value::Null);
                    let changed = info.apply(name, &data);
                    if changed || info_sent.elapsed() >= std::time::Duration::from_secs(3) {
                        info_sent = std::time::Instant::now();
                        let _ = reader_app.emit("player-stream-info", info.clone());
                    }
                }
                // Connecting to a stream, and the first picture of it: the
                // frontend shows "Connecting…" when that takes a while.
                Some("start-file") => {
                    let _ = reader_app.emit("player-status", "connecting");
                }
                Some("playback-restart") => {
                    let _ = reader_app.emit("player-status", "playing");
                }
                // mpv could not open or keep reading the stream. The other
                // reasons ("eof", "stop", "quit") are ordinary playback ends.
                Some("end-file") if v.get("reason").and_then(Value::as_str) == Some("error") => {
                    let message = v
                        .get("file_error")
                        .and_then(Value::as_str)
                        .unwrap_or("mpv could not play this channel");
                    crate::log::log(format!("player: playback failed: {message}"));
                    let _ = reader_app.emit("player-error", message.to_string());
                }
                // No event field: a reply to one of our commands. Only the
                // loadfile reply is surfaced - a property an mpv build happens
                // to reject must not spam the user with toasts.
                None if v
                    .get("request_id")
                    .and_then(Value::as_u64)
                    .is_some_and(|id| id > PROGRESS_REQUEST_BASE) =>
                {
                    if let (Some(id), Some(data)) = (
                        v.get("request_id").and_then(Value::as_u64),
                        v.get("data").and_then(Value::as_str),
                    ) {
                        save_progress_reply(&reader_app, id, data);
                    }
                }
                None => {
                    if v.get("request_id").and_then(Value::as_u64) == Some(LOADFILE_REQUEST_ID)
                        && let Some(error) = v
                            .get("error")
                            .and_then(Value::as_str)
                            .filter(|e| *e != "success")
                    {
                        crate::log::log(format!("player: loadfile rejected: {error}"));
                        let _ = reader_app.emit("player-error", error.to_string());
                    }
                }
                _ => {}
            }
        }
    });
    let mut lost = false;
    while let Some(cmd) = rx.recv().await {
        let mut bytes = match serde_json::to_vec(&cmd) {
            Ok(b) => b,
            Err(_) => continue,
        };
        bytes.push(b'\n');
        if writer.write_all(&bytes).await.is_err() {
            lost = true;
            break;
        }
        let _ = writer.flush().await;
    }
    // A closed receiver means destroy() dropped the sender: an intentional
    // shutdown, not a lost player.
    if lost {
        handle_player_lost(&app).await;
    }
}

/// The pipe to mpv is gone: tear the player down and tell the frontend, so the
/// next channel click rebuilds it instead of sending commands into the void.
#[cfg(target_os = "windows")]
async fn handle_player_lost(app: &AppHandle) {
    let state = app.state::<Mutex<AppState>>();
    let _ = destroy(app.clone(), state).await;
    let _ = app.emit("player-crashed", ());
}

#[cfg(target_os = "windows")]
async fn connect_pipe(name: &str) -> Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    use tokio::net::windows::named_pipe::ClientOptions;
    // mpv creates the pipe a short moment after it starts; retry with backoff.
    const ERROR_PIPE_BUSY: i32 = 231;
    for _ in 0..60 {
        match ClientOptions::new().open(name) {
            Ok(client) => return Ok(client),
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => {}
            Err(_) => {}
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    anyhow::bail!("timed out waiting for the mpv IPC pipe")
}

#[cfg(target_os = "windows")]
mod win {
    use std::sync::OnceLock;
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        CreateSolidBrush, GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTONULL,
        MONITORINFO, MonitorFromRect, MonitorFromWindow,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        EnableWindow, GetAsyncKeyState, ReleaseCapture, VK_LBUTTON,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    static CLASS_NAME: OnceLock<Vec<u16>> = OnceLock::new();

    /// Registers the host window class once and returns a pointer to its
    /// (statically stored) class name.
    fn ensure_class() -> *const u16 {
        CLASS_NAME
            .get_or_init(|| {
                let name = wide("streameo_mpv_host");
                unsafe {
                    let hinstance = GetModuleHandleW(std::ptr::null());
                    let wc = WNDCLASSEXW {
                        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                        style: 0,
                        lpfnWndProc: Some(host_proc),
                        cbClsExtra: 0,
                        cbWndExtra: 0,
                        hInstance: hinstance,
                        hIcon: std::ptr::null_mut(),
                        hCursor: std::ptr::null_mut(),
                        // Black brush so the window paints black before the
                        // first frame instead of flashing white.
                        hbrBackground: CreateSolidBrush(0 as COLORREF),
                        lpszMenuName: std::ptr::null(),
                        lpszClassName: name.as_ptr(),
                        hIconSm: std::ptr::null_mut(),
                    };
                    RegisterClassExW(&wc);
                }
                name
            })
            .as_ptr()
    }

    /// Styles of the host while it floats: a thin tool-window caption (drag
    /// it to move, the frame to resize, x to close) around mpv's video.
    const POPOUT_STYLE: WINDOW_STYLE =
        WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_CLIPCHILDREN | WS_VISIBLE;
    const POPOUT_EX_STYLE: WINDOW_EX_STYLE = WS_EX_TOOLWINDOW | WS_EX_TOPMOST;
    const CHILD_STYLE: WINDOW_STYLE = WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS;
    /// Default and minimum width of the video in the floating window, in
    /// 96-dpi pixels.
    const POPOUT_WIDTH: i32 = 480;
    const POPOUT_MIN_WIDTH: i32 = 240;

    fn scale(hwnd: HWND, value: i32) -> i32 {
        let dpi = unsafe { GetDpiForWindow(hwnd) };
        let dpi = if dpi == 0 { 96 } else { dpi as i32 };
        value * dpi / 96
    }

    /// Frame size around the client area for the floating styles.
    fn frame_size(hwnd: HWND) -> (i32, i32) {
        let mut r = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        unsafe { AdjustWindowRectEx(&mut r, POPOUT_STYLE, 0, POPOUT_EX_STYLE) };
        let _ = hwnd;
        (r.right - r.left, r.bottom - r.top)
    }

    /// Only the floating window gets the special frame behaviour; inside the
    /// main window the host is a plain child.
    unsafe extern "system" fn host_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if super::POPPED_OUT.load(Ordering::SeqCst) {
            match msg {
                // Destroying the host would take mpv's window with it.
                WM_CLOSE => {
                    super::emit_popout(super::POPOUT_CLOSE_EVENT);
                    return 0;
                }
                WM_NCLBUTTONDBLCLK if wparam as u32 == HTCAPTION => {
                    super::emit_popout(super::POPOUT_DOCK_EVENT);
                    return 0;
                }
                WM_SIZING => {
                    unsafe { keep_aspect(hwnd, wparam as u32, lparam as *mut RECT) };
                    return 1;
                }
                WM_GETMINMAXINFO => {
                    let (fw, fh) = frame_size(hwnd);
                    let min_w = scale(hwnd, POPOUT_MIN_WIDTH);
                    let info = lparam as *mut MINMAXINFO;
                    unsafe {
                        (*info).ptMinTrackSize.x = min_w + fw;
                        (*info).ptMinTrackSize.y = min_w * 9 / 16 + fh;
                    }
                    return 0;
                }
                _ => {}
            }
        }
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    /// Keeps the video area 16:9 while the user drags a frame edge.
    unsafe fn keep_aspect(hwnd: HWND, edge: u32, rect: *mut RECT) {
        let (fw, fh) = frame_size(hwnd);
        let r = unsafe { &mut *rect };
        let width = (r.right - r.left - fw).max(1);
        let height = (r.bottom - r.top - fh).max(1);
        match edge {
            WMSZ_TOP | WMSZ_BOTTOM => r.right = r.left + height * 16 / 9 + fw,
            WMSZ_TOPLEFT | WMSZ_TOPRIGHT => r.top = r.bottom - width * 9 / 16 - fh,
            _ => r.bottom = r.top + width * 9 / 16 + fh,
        }
    }

    fn on_screen(x: i32, y: i32, w: i32, h: i32) -> bool {
        let r = RECT {
            left: x,
            top: y,
            right: x + w,
            bottom: y + h,
        };
        !unsafe { MonitorFromRect(&r, MONITOR_DEFAULTTONULL) }.is_null()
    }

    /// Bottom right of the work area of the main window's monitor.
    unsafe fn default_bounds(host: HWND, main: HWND) -> (i32, i32, i32, i32) {
        let (fw, fh) = frame_size(host);
        let w = scale(main, POPOUT_WIDTH);
        let (w, h) = (w + fw, w * 9 / 16 + fh);
        let margin = scale(main, 24);
        let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        let monitor = unsafe { MonitorFromWindow(main, MONITOR_DEFAULTTONEAREST) };
        if unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 {
            return (margin, margin, w, h);
        }
        let work = info.rcWork;
        (work.right - w - margin, work.bottom - h - margin, w, h)
    }

    pub unsafe fn set_title(host: isize, title: &str) {
        let text = wide(title);
        unsafe { SetWindowTextW(host as HWND, text.as_ptr()) };
    }

    /// Turns the host into a floating top-level window. Not owned by the main
    /// window, so it stays up while the app is minimized.
    pub unsafe fn pop_out(
        host: isize,
        main: isize,
        saved: Option<(i32, i32, i32, i32)>,
        title: &str,
    ) {
        let host = host as HWND;
        let main = main as HWND;
        let (x, y, w, h) = saved
            .filter(|&(x, y, w, h)| on_screen(x, y, w, h))
            .unwrap_or_else(|| unsafe { default_bounds(host, main) });
        unsafe {
            // SetParent(NULL) first, then the popup styles (see SetParent).
            SetParent(host, std::ptr::null_mut());
            SetWindowLongPtrW(host, GWL_STYLE, POPOUT_STYLE as isize);
            SetWindowLongPtrW(host, GWL_EXSTYLE, POPOUT_EX_STYLE as isize);
            set_title(host as isize, title);
            SetWindowPos(
                host,
                HWND_TOPMOST,
                x,
                y,
                w,
                h,
                SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        }
    }

    /// Puts the host back into the main window as a child. Returns the
    /// floating window's last position and size, to be remembered.
    pub unsafe fn dock(host: isize, main: isize) -> (i32, i32, i32, i32) {
        let host = host as HWND;
        let mut r = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        unsafe {
            GetWindowRect(host, &mut r);
            SetWindowPos(
                host,
                HWND_NOTOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
            // The child style first, then SetParent (see SetParent).
            SetWindowLongPtrW(host, GWL_EXSTYLE, 0);
            SetWindowLongPtrW(host, GWL_STYLE, CHILD_STYLE as isize);
            SetParent(host, main as HWND);
            SetWindowPos(
                host,
                HWND_TOP,
                0,
                0,
                1,
                1,
                SWP_FRAMECHANGED | SWP_NOACTIVATE,
            );
        }
        (r.left, r.top, r.right - r.left, r.bottom - r.top)
    }

    pub unsafe fn create_child(parent: isize, x: i32, y: i32, w: i32, h: i32) -> isize {
        let class = ensure_class();
        let title = wide("");
        let hwnd = unsafe {
            let hinstance = GetModuleHandleW(std::ptr::null());
            CreateWindowExW(
                0,
                class,
                title.as_ptr(),
                CHILD_STYLE,
                x,
                y,
                w,
                h,
                parent as HWND,
                std::ptr::null_mut(),
                hinstance,
                std::ptr::null(),
            )
        };
        hwnd as isize
    }

    pub unsafe fn set_bounds(child: isize, x: i32, y: i32, w: i32, h: i32) {
        unsafe { SetWindowPos(child as HWND, HWND_TOP, x, y, w, h, SWP_NOACTIVATE) };
    }

    pub unsafe fn show(child: isize, visible: bool) {
        unsafe { ShowWindow(child as HWND, if visible { SW_SHOW } else { SW_HIDE }) };
    }

    pub unsafe fn destroy(child: isize) {
        unsafe { DestroyWindow(child as HWND) };
    }

    /// Hands a press in mpv's window to the floating host as a caption drag.
    /// Only while the button is still down: a move loop started after a
    /// quick click would follow the mouse until the next click.
    pub unsafe fn begin_drag(host: isize) {
        unsafe {
            if (GetAsyncKeyState(VK_LBUTTON as i32) as u16 & 0x8000) == 0 {
                return;
            }
            ReleaseCapture();
            SendMessageW(host as HWND, WM_NCLBUTTONDOWN, HTCAPTION as WPARAM, 0);
        }
    }

    /// mpv attaches its video output as a child of our host window, created
    /// `WS_DISABLED` (so input flows to the parent). Re-enable it so mpv gets
    /// mouse/keyboard directly and its OSC/right-click work. Returns false while
    /// the child does not exist yet (mpv creates it shortly after launch).
    pub unsafe fn enable_child_input(host: isize) -> bool {
        let child = unsafe { GetWindow(host as HWND, GW_CHILD) };
        if child.is_null() {
            return false;
        }
        unsafe {
            EnableWindow(child, 1 /* TRUE */)
        };
        true
    }
}

#[cfg(test)]
mod test_player {
    use super::*;
    use crate::types::{Channel, ChannelHttpHeaders, Settings};

    fn channel() -> Channel {
        Channel {
            id: Some(1),
            name: "Test".to_string(),
            url: Some("http://example.com/live".to_string()),
            ..Default::default()
        }
    }

    fn commands(headers: Option<ChannelHttpHeaders>) -> Vec<Value> {
        build_play_commands(&channel(), &None, headers, &Settings::default(), None).unwrap()
    }

    fn user_agent_of(cmds: &[Value]) -> String {
        cmds.iter()
            .find(|c| c["command"][0] == "set_property" && c["command"][1] == "user-agent")
            .and_then(|c| c["command"][2].as_str())
            .expect("no user-agent command")
            .to_string()
    }

    #[test]
    fn test_stream_info_changes() {
        let mut info = StreamInfo::default();
        assert!(info.apply("video-params", &json!({"w": 1920, "h": 1080})));
        assert!(!info.apply("video-params", &json!({"w": 1920, "h": 1080})));
        assert!(info.apply("video-format", &json!("h264")));
        // The bitrate is stored but never counts as a change.
        assert!(!info.apply("video-bitrate", &json!(6_200_000.0)));
        assert_eq!(info.bitrate, Some(6_200_000.0));
        assert!(!info.apply("unknown", &json!(1)));
        assert_eq!((info.width, info.height), (Some(1920), Some(1080)));
    }

    #[test]
    fn test_parse_bounds() {
        assert_eq!(parse_bounds("10,-20,640,380"), Some((10, -20, 640, 380)));
        assert_eq!(parse_bounds(" 1, 2, 3, 4 "), Some((1, 2, 3, 4)));
        assert_eq!(parse_bounds("1,2,0,4"), None);
        assert_eq!(parse_bounds("1,2,3"), None);
        assert_eq!(parse_bounds("a,b,c,d"), None);
        assert_eq!(parse_bounds(""), None);
    }

    /// The provider only allows so many connections at once, so the running
    /// stream has to be closed before the next one is opened.
    #[test]
    fn test_stops_before_loading_the_next_stream() {
        let cmds = commands(None);
        let stop = cmds
            .iter()
            .position(|c| c["command"][0] == "stop")
            .expect("no stop command");
        let loadfile = cmds
            .iter()
            .position(|c| c["command"][0] == "loadfile")
            .expect("no loadfile command");
        assert!(stop < loadfile, "stop must be sent before loadfile");
    }

    /// An empty user agent makes many providers answer 403; mpv's own default
    /// is what the classic spawn-per-channel path sends.
    #[test]
    fn test_falls_back_to_default_user_agent() {
        for user_agent in [None, Some(String::new()), Some("   ".to_string())] {
            let headers = ChannelHttpHeaders {
                user_agent,
                ..Default::default()
            };
            assert_eq!(
                user_agent_of(&commands(Some(headers))),
                MPV_DEFAULT_USER_AGENT
            );
        }
    }

    #[test]
    fn test_keeps_the_configured_user_agent() {
        let headers = ChannelHttpHeaders {
            user_agent: Some("VLC/3.0.20".to_string()),
            ..Default::default()
        };
        assert_eq!(user_agent_of(&commands(Some(headers))), "VLC/3.0.20");
    }

    fn prop_of(cmds: &[Value], name: &str) -> Option<Value> {
        cmds.iter()
            .find(|c| c["command"][0] == "set_property" && c["command"][1] == name)
            .map(|c| c["command"][2].clone())
    }

    /// The duration probe seeks to the end of what mpv believes is a file. For
    /// a live stream that second connection is refused and the demuxer hangs,
    /// leaving a black video area with no error at all.
    #[test]
    fn test_live_streams_skip_the_duration_probe() {
        let mut channel = channel();
        channel.media_type = crate::media_type::LIVESTREAM;
        let cmds = build_play_commands(&channel, &None, None, &Settings::default(), None).unwrap();
        assert_eq!(
            prop_of(&cmds, "demuxer-lavf-probe-info"),
            Some(json!("nostreams"))
        );
    }

    /// Movies and episodes are real files: they keep mpv's normal probing.
    #[test]
    fn test_vod_keeps_probing() {
        let mut channel = channel();
        channel.media_type = crate::media_type::MOVIE;
        let cmds = build_play_commands(&channel, &None, None, &Settings::default(), None).unwrap();
        assert_eq!(
            prop_of(&cmds, "demuxer-lavf-probe-info"),
            Some(json!("auto"))
        );
    }

    /// mpv has no such property - setting it only logged "property not found".
    #[test]
    fn test_no_bogus_tls_property() {
        let cmds = commands(None);
        assert_eq!(prop_of(&cmds, "stream-tls-verify"), None);
    }

    /// The resume point goes with the file, not into a property that the
    /// queued episodes would inherit.
    #[test]
    fn test_resume_point_is_a_file_option() {
        let mut channel = channel();
        channel.media_type = crate::media_type::MOVIE;
        let cmds =
            build_play_commands(&channel, &None, None, &Settings::default(), Some(2520.5)).unwrap();
        let loadfile = cmds
            .iter()
            .find(|c| c["command"][0] == "loadfile")
            .expect("no loadfile command");
        assert_eq!(loadfile["command"][3], json!(-1));
        assert_eq!(loadfile["command"][4], json!("start=2520.5"));
        assert_eq!(prop_of(&cmds, "start"), None);
    }

    #[test]
    fn test_parse_progress() {
        assert_eq!(
            parse_progress("1|43.36|120.0"),
            Some((1, 43.36, Some(120.0)))
        );
        assert_eq!(parse_progress("0|600|"), Some((0, 600.0, None)));
        // Idle: no file, no position.
        assert_eq!(parse_progress("-1||"), None);
        assert_eq!(parse_progress(""), None);
    }

    #[test]
    fn test_banner_escapes_and_lays_out() {
        let banner = OsdBanner {
            number: Some("12".to_string()),
            title: "Das Erste {HD} \\o/".to_string(),
            line: Some("20:00–20:15  Tagesschau".to_string()),
            detail: Some("7 min left".to_string()),
            progress: Some(0.6),
            footer: Some("Next  20:15  Tatort".to_string()),
        };
        let ass = banner_ass(&banner);
        assert!(ass.contains("Das Erste \\{HD\\} \\\u{2060}o/"));
        assert!(!ass.contains("{HD}"));
        // Background band plus title, line, two bar parts and the footer.
        assert_eq!(ass.lines().count(), 6);
        assert!(ass.contains("m 0 0 l 300 0 300 5 0 5"));
        let plain = banner_ass(&OsdBanner {
            title: "Film".to_string(),
            ..Default::default()
        });
        assert_eq!(plain.lines().count(), 2);
    }

    #[test]
    fn test_banner_cuts_long_text() {
        let long = "x".repeat(200);
        let text = ass_text(&long, BANNER_TITLE_MAX_CHARS);
        assert_eq!(text.chars().count(), BANNER_TITLE_MAX_CHARS);
        assert!(text.ends_with('…'));
        assert_eq!(ass_text("a\nb", 10), "a b");
        // No space left in front of the ellipsis.
        assert_eq!(ass_text("abc def ghi", 5), "abc…");
        let banner = banner_ass(&OsdBanner {
            title: long.clone(),
            line: Some(long.clone()),
            footer: Some(long),
            ..Default::default()
        });
        let longest = banner.lines().map(|l| l.chars().count()).max().unwrap_or(0);
        assert!(longest < 200, "{longest}");
    }

    #[test]
    fn test_cache_status_reports_changes_only() {
        let mut buffering = false;
        // A file opening: unavailable, then false - not "playing" yet.
        assert_eq!(cache_status(&mut buffering, None), None);
        assert_eq!(cache_status(&mut buffering, Some(false)), None);
        assert_eq!(cache_status(&mut buffering, Some(true)), Some("buffering"));
        assert_eq!(cache_status(&mut buffering, Some(true)), None);
        assert_eq!(cache_status(&mut buffering, Some(false)), Some("playing"));
        // Zapped away while buffering: the old file's end says nothing.
        assert_eq!(cache_status(&mut buffering, Some(true)), Some("buffering"));
        assert_eq!(cache_status(&mut buffering, None), None);
        assert_eq!(cache_status(&mut buffering, Some(false)), None);
    }

    #[test]
    fn test_status_keeps_its_lines() {
        let long = "x".repeat(80);
        let text = format!("Wiedergabe fehlgeschlagen: {long}\nEnter: erneut versuchen\n");
        let lines = status_lines(&text);
        let parts: Vec<&str> = lines.split("\\N").collect();
        assert_eq!(parts.len(), 2);
        assert!(parts[0].ends_with('…'));
        assert_eq!(parts[0].chars().count(), BANNER_LINE_MAX_CHARS);
        assert_eq!(parts[1], "Enter: erneut versuchen");
    }

    #[test]
    fn test_status_overlay() {
        let shown = status_overlay(Some("Verbinde…"));
        assert_eq!(shown["command"]["id"].as_u64(), Some(STATUS_OVERLAY_ID));
        assert!(
            shown["command"]["data"]
                .as_str()
                .unwrap()
                .ends_with("Verbinde…")
        );
        for hidden in [None, Some("  ")] {
            assert_eq!(status_overlay(hidden)["command"]["format"], "none");
        }
    }

    #[test]
    fn test_player_commands() {
        assert_eq!(
            player_command("toggle_pause"),
            Some(json!({ "command": ["cycle", "pause"] }))
        );
        assert_eq!(
            player_command("toggle_mute"),
            Some(json!({ "command": ["cycle", "mute"] }))
        );
        // Nothing else reaches mpv through this command.
        assert_eq!(player_command("quit"), None);
    }

    /// The tray must not bring back the video while the player is closed.
    #[test]
    fn test_video_shown_only_with_open_player() {
        PLAYER_SHOWN.store(false, Ordering::SeqCst);
        assert!(!may_show(true));
        assert!(may_show(false));
        PLAYER_SHOWN.store(true, Ordering::SeqCst);
        assert!(may_show(true));
        PLAYER_SHOWN.store(false, Ordering::SeqCst);
    }

    #[test]
    fn test_keys_inside_the_app() {
        // Quitting mpv or taking screenshots from inside the app is off.
        for key in ["q", "Q", "STOP", "CLOSE_WIN", "s"] {
            assert!(IGNORED_KEYS.contains(&key), "{key}");
        }
        let action = |key: &str| APP_KEYS.iter().find(|(k, _)| *k == key).map(|(_, a)| *a);
        assert_eq!(action("ENTER"), Some("commit"));
        // Up/Down zap on live TV only; a movie keeps seeking with them.
        let up = |live: bool| arrow_keybinds(live)[0]["command"][2].clone();
        assert_eq!(up(true), "script-message streameo-key prev");
        assert_eq!(up(false), "seek 60");
        // No key is both forwarded and ignored.
        assert!(APP_KEYS.iter().all(|(k, _)| !IGNORED_KEYS.contains(k)));
    }

    /// Catch-up is a pseudo channel whose URL carries the login: never saved.
    /// Local files (recordings, downloads) keep theirs under source 0.
    #[test]
    fn test_progress_source() {
        let movie = Channel {
            id: Some(5),
            source_id: Some(3),
            url: Some("http://h/movie/1.mkv".into()),
            media_type: crate::media_type::MOVIE,
            ..Default::default()
        };
        assert_eq!(progress_source(&movie), Some(3));
        let catch_up = Channel {
            id: Some(-1),
            ..movie.clone()
        };
        assert_eq!(progress_source(&catch_up), None);
        let catch_up_without_source = Channel {
            source_id: None,
            ..catch_up
        };
        assert_eq!(progress_source(&catch_up_without_source), None);
        let recording = Channel {
            id: Some(-1),
            source_id: None,
            url: Some("C:/Videos/News-20261003-2015.ts".into()),
            ..movie.clone()
        };
        assert_eq!(progress_source(&recording), Some(LOCAL_FILE_SOURCE));
        let live = Channel {
            media_type: crate::media_type::LIVESTREAM,
            ..movie
        };
        assert_eq!(progress_source(&live), None);
    }

    #[test]
    fn test_player_commands_for_volume_and_seek() {
        assert_eq!(
            player_command("volume_up"),
            Some(json!({ "command": ["add", "volume", 5] }))
        );
        assert_eq!(
            player_command("seek_back"),
            Some(json!({ "command": ["seek", -60] }))
        );
        assert_eq!(player_command("nope"), None);
    }

    /// Only the loadfile reply carries the request id the IPC reader reports on.
    #[test]
    fn test_loadfile_is_tagged_for_error_reporting() {
        let cmds = commands(None);
        let loadfile = cmds
            .iter()
            .find(|c| c["command"][0] == "loadfile")
            .expect("no loadfile command");
        assert_eq!(loadfile["request_id"].as_u64(), Some(LOADFILE_REQUEST_ID));
        assert!(
            cmds.iter()
                .filter(|c| c.get("request_id").is_some())
                .count()
                == 1
        );
    }
}
