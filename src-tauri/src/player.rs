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
use serde_json::{Value, json};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};
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

/// Process id of the embedded mpv, for the synchronous exit path. 0 means "no
/// player process".
static PLAYER_MPV_PID: AtomicU32 = AtomicU32::new(0);

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
        let _ = ipc_tx.send(json!({
            "command": ["keybind", "f", "script-message streameo-fullscreen"]
        }));

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
        s.player_ipc_tx = Some(ipc_tx);
        Ok(())
    }
}

/// Switches the embedded player to `channel` without restarting mpv.
pub async fn play(
    app: AppHandle,
    channel: Channel,
    state: State<'_, Mutex<AppState>>,
) -> Result<()> {
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
    for cmd in build_play_commands(&channel, &source, headers, &settings)? {
        let _ = tx.send(cmd);
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
        let _ = tx.send(json!({ "command": ["show-text", message, 6000] }));
    }
    Ok(())
}

/// Unloads the current file but keeps mpv alive and idle.
pub async fn stop(state: State<'_, Mutex<AppState>>) -> Result<()> {
    if let Some(tx) = state.lock().await.player_ipc_tx.clone() {
        let _ = tx.send(json!({ "command": ["stop"] }));
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
        let child = state.lock().await.player_child_hwnd;
        if let Some(child) = child {
            app.run_on_main_thread(move || unsafe { win::set_bounds(child, x, y, w, h) })?;
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (&app, &state, x, y, w, h);
    Ok(())
}

/// Shows or hides the native video window (used when entering/leaving the
/// player view so it never floats over the app when the view is not shown).
pub async fn set_visible(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
    visible: bool,
) -> Result<()> {
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
/// main thread already and cannot lock the async `AppState` mutex.
pub fn set_visible_sync(visible: bool) {
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
    let (child, mpv) = {
        let mut s = state.lock().await;
        s.player_ipc_tx = None; // dropping the sender ends the IPC task
        (s.player_child_hwnd.take(), s.player_mpv.take())
    };
    PLAYER_MPV_PID.store(0, Ordering::SeqCst);
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
) -> Result<Vec<Value>> {
    let url = channel.url.clone().context("no url")?;
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

    // Match the classic path: never verify TLS (mpv's default), and only pass
    // the ytdl no-check option when the channel explicitly asks to ignore SSL.
    cmds.push(set_prop("stream-tls-verify", json!("no")));
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
    cmds.push(set_prop("save-position-on-quit", json!(!is_live)));
    cmds.push(set_prop("loop-playlist", json!(if is_live { "inf" } else { "no" })));

    cmds.push(json!({
        "command": ["loadfile", url, "replace"],
        "request_id": LOADFILE_REQUEST_ID,
    }));

    // Series: queue the following episodes so playback continues automatically,
    // mirroring the playlist the classic path builds in get_play_args.
    if channel.episode_num.is_some() {
        for ep_url in crate::sql::find_all_episodes_after(channel)? {
            cmds.push(json!({ "command": ["loadfile", ep_url, "append"] }));
        }
    }

    Ok(cmds)
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
    crate::log::log(format!("mpv IPC connected on {pipe}"));
    let (reader, mut writer) = tokio::io::split(client);
    // Read mpv's responses/events (also keeps the pipe buffer from blocking
    // writes): turn our fullscreen script-message into a frontend event, and
    // report playback failures - mpv's own output is not captured, so this is
    // the only place a dead link, an HTTP error or a connection refused by the
    // provider can be noticed at all.
    let reader_app = app.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match v.get("event").and_then(Value::as_str) {
                Some("client-message") => {
                    if v.get("args")
                        .and_then(Value::as_array)
                        .and_then(|a| a.first())
                        .and_then(Value::as_str)
                        == Some("streameo-fullscreen")
                    {
                        let _ = reader_app.emit("player-toggle-fullscreen", ());
                    }
                }
                // mpv could not open or keep reading the stream. The other
                // reasons ("eof", "stop", "quit") are ordinary playback ends.
                Some("end-file") => {
                    if v.get("reason").and_then(Value::as_str) == Some("error") {
                        let message = v
                            .get("file_error")
                            .and_then(Value::as_str)
                            .unwrap_or("mpv could not play this channel");
                        crate::log::log(format!("player: playback failed: {message}"));
                        let _ = reader_app.emit("player-error", message.to_string());
                    }
                }
                // No event field: a reply to one of our commands. Only the
                // loadfile reply is surfaced - a property an mpv build happens
                // to reject must not spam the user with toasts.
                None => {
                    if v.get("request_id").and_then(Value::as_u64) == Some(LOADFILE_REQUEST_ID) {
                        if let Some(error) = v
                            .get("error")
                            .and_then(Value::as_str)
                            .filter(|e| *e != "success")
                        {
                            crate::log::log(format!("player: loadfile rejected: {error}"));
                            let _ = reader_app.emit("player-error", error.to_string());
                        }
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
async fn connect_pipe(
    name: &str,
) -> Result<tokio::net::windows::named_pipe::NamedPipeClient> {
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
    use windows_sys::Win32::Foundation::{COLORREF, HWND};
    use windows_sys::Win32::Graphics::Gdi::CreateSolidBrush;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::EnableWindow;
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
                        lpfnWndProc: Some(DefWindowProcW),
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

    pub unsafe fn create_child(parent: isize, x: i32, y: i32, w: i32, h: i32) -> isize {
        let class = ensure_class();
        let title = wide("");
        let hwnd = unsafe {
            let hinstance = GetModuleHandleW(std::ptr::null());
            CreateWindowExW(
                0,
                class,
                title.as_ptr(),
                WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
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

    /// mpv attaches its video output as a child of our host window, created
    /// `WS_DISABLED` (so input flows to the parent). Re-enable it so mpv gets
    /// mouse/keyboard directly and its OSC/right-click work. Returns false while
    /// the child does not exist yet (mpv creates it shortly after launch).
    pub unsafe fn enable_child_input(host: isize) -> bool {
        let child = unsafe { GetWindow(host as HWND, GW_CHILD) };
        if child.is_null() {
            return false;
        }
        unsafe { EnableWindow(child, 1 /* TRUE */) };
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
        build_play_commands(&channel(), &None, headers, &Settings::default()).unwrap()
    }

    fn user_agent_of(cmds: &[Value]) -> String {
        cmds.iter()
            .find(|c| c["command"][0] == "set_property" && c["command"][1] == "user-agent")
            .and_then(|c| c["command"][2].as_str())
            .expect("no user-agent command")
            .to_string()
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
            assert_eq!(user_agent_of(&commands(Some(headers))), MPV_DEFAULT_USER_AGENT);
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
