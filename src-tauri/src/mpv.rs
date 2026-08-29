use crate::settings::get_default_record_path;
use crate::types::{AppState, ChannelHttpHeaders, Source};
use crate::utils::{find_macos_bin, get_bin};
use crate::{log, sql};
use crate::{media_type, settings::get_settings, types::Channel};
use anyhow::{Context, Result};
use chrono::Local;

use std::sync::LazyLock;
use std::{env::consts::OS, path::Path, process::Stdio};
use tauri::State;
use tokio::sync::Mutex;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
};
use tokio_util::sync::CancellationToken;

const ARG_SAVE_POSITION_ON_QUIT: &str = "--save-position-on-quit";
const ARG_CACHE: &str = "--cache=";
const ARG_NO: &str = "no";
const ARG_RECORD: &str = "--stream-record=";
const ARG_TITLE: &str = "--title=";
const ARG_MSG_LEVEL: &str = "--msg-level=all=error";
// Uses --script-opts-append (not --script-opts) so it composes with the modern
// player UI options below: --script-opts replaces the whole key=value list,
// while -append only adds one entry to it.
const ARG_YTDLP_PATH: &str = "--script-opts-append=ytdl_hook-ytdl_path=";
const ARG_SCRIPT_OPTS_APPEND: &str = "--script-opts-append=";
const ARG_NORMALIZE_AUDIO: &str = "--af=dynaudnorm=g=5:f=250:r=0.9:p=0.5";
const ARG_OSD_FONT_WINDOWS: &str = "--osd-font=Segoe UI";
const PLAYER_UI_CLASSIC: &str = "classic";
const EXTERNAL_PLAYER_URL_TOKEN: &str = "{url}";
const MODERN_UI_OSC_OPTS: [&str; 8] = [
    "osc-layout=slimbox",
    "osc-seekbarstyle=bar",
    "osc-deadzonesize=0.75",
    "osc-minmousemove=3",
    "osc-hidetimeout=1500",
    "osc-fadeduration=250",
    "osc-timetotal=yes",
    "osc-title=${media-title}",
];
const MODERN_UI_OSD_ARGS: [&str; 3] = ["--osd-bar-w=45", "--osd-bar-h=1.5", "--osd-border-size=1"];
/// Tethys OSC (https://github.com/Zren/mpv-osc-tethys, an osc.lua fork):
/// a full modern on-screen controller with buttons and vector icons in a
/// single self-contained Lua file, embedded here and written to the app data
/// dir at play time so it works with any mpv (bundled or system).
const TETHYS_LUA: &str = include_str!("../player_ui/tethys.lua");
const TETHYS_FILE_NAME: &str = "osc_tethys.lua";
const ARG_OSC_OFF: &str = "--osc=no";
const ARG_SCRIPT: &str = "--script=";
const ARG_VOLUME: &str = "--volume=";
const ARG_HTTP_HEADERS: &str = "--http-header-fields=";
const ARG_USER_AGENT: &str = "--user-agent=";
const ARG_IGNORE_SSL: &str = "--ytdl-raw-options=no-check-certificates=True";
const ARG_PREFETCH_PLAYLIST: &str = "--prefetch-playlist=yes";
const ARG_LOOP_PLAYLIST: &str = "--loop-playlist=inf";
const ARG_HWDEC: &str = "--hwdec=auto";
const ARG_GPU_NEXT: &str = "--vo=gpu-next";
const ARG_GPU_PROFILE_HIGH_QUALITY: &str = "--profile=high-quality";
const ARG_NO_RESUME_PLAYBACK: &str = "--no-resume-playback";
const ARG_SLANG: &str = "--slang=";
const ARG_ALANG: &str = "--alang=";
const ARG_SUB_AUTO_FUZZY: &str = "--sub-auto=fuzzy";
const MPV_BIN_NAME: &str = "mpv";
const YTDLP_BIN_NAME: &str = "yt-dlp";
const HTTP_ORIGIN: &str = "origin:";
const HTTP_REFERRER: &str = "referer:";
static MPV_PATH: LazyLock<String> = LazyLock::new(|| get_bin(MPV_BIN_NAME));
static YTDLP_PATH: LazyLock<String> = LazyLock::new(|| find_macos_bin(YTDLP_BIN_NAME));

pub async fn play(
    channel: Channel,
    record: bool,
    record_path: Option<String>,
    state: State<'_, Mutex<AppState>>,
) -> Result<()> {
    eprintln!(
        "{} playing",
        channel.url.as_ref().context("no channel url")?
    );
    let source = channel
        .source_id
        .and_then(|id| {
            sql::get_source_from_id(id)
                .with_context(|| format!("failed to fetch source with id {}", id))
                .ok()
        })
        .or(None);

    // Recordings always go through mpv: it performs the actual stream capture.
    if !record {
        let settings = get_settings()?;
        let external_player_path = settings
            .external_player_path
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(str::to_string);
        if settings.use_external_player == Some(true) {
            if let Some(player_path) = external_player_path {
                return play_external(
                    &channel,
                    &player_path,
                    settings.external_player_args.as_deref(),
                    &source,
                    &state,
                )
                .await;
            }
        }
    }

    let args = get_play_args(&channel, record, record_path, &source)?;
    eprintln!("with args: {:?}", args);

    if let Some(source) = source.as_ref() {
        _ = crate::utils::handle_max_streams(source, &state)
            .await
            .map_err(|e| log::log(format!("{:?}", e)));
    }

    let mut cmd = Command::new(MPV_PATH.clone())
        .args(args)
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| crate::utils::friendly_spawn_error(MPV_BIN_NAME, e))?;
    let token = CancellationToken::new();
    let channel_id = channel.id.context("no channel id")?;
    if let Some(source_id) = source.as_ref().and_then(|s| s.id) {
        _ = crate::utils::insert_play_token(
            source_id,
            channel_id.to_string(),
            token.clone(),
            &state,
        )
        .await
        .map_err(|e| log::log(format!("{:?}", e)));
    }
    let result: Result<()> = tokio::select! {
        status = cmd.wait() => {
            let status = status?;
            if status.success() {
                Ok(())
            } else {
                let stdout = cmd.stdout.take();
                if stdout.is_none() {
                     Ok(())
                } else {
                    let stdout = stdout.context("no stdout")?;
                    let mut error: String = String::new();
                    let mut lines = BufReader::new(stdout).lines();
                    let mut first = true;
                    while let Some(line) = lines.next_line().await? {
                        error += &line;
                        if !first {
                            error += "\n";
                        } else {
                            first = false;
                        }
                    }
                    if error != "" {
                        Err(anyhow::anyhow!(error))
                    } else {
                        Err(anyhow::anyhow!("Mpv encountered an unknown error"))
                    }
                }
            }
        },
        _ = token.cancelled() => {
            cmd.kill().await?;
            Ok(())
        }
    };

    if let Some(source_id) = source.as_ref().and_then(|s| s.id) {
        _ = crate::utils::remove_from_play_stop(state, &source_id, &channel_id.to_string())
            .await
            .map_err(|e| log::log(format!("{:?}", e)));
    }
    result
}

/// Plays a channel in the user-configured external player instead of mpv.
///
/// The player is spawned detached: the wait/cancellation machinery in the mpv
/// branch exists to read mpv's stdout for error reporting and to kill the mpv
/// process when a play token is cancelled (user stop or max_streams eviction).
/// Neither applies to a third-party player we do not control, so no play token
/// is registered and the child handle is dropped after a successful spawn.
async fn play_external(
    channel: &Channel,
    player_path: &str,
    args_template: Option<&str>,
    source: &Option<Source>,
    state: &State<'_, Mutex<AppState>>,
) -> Result<()> {
    let url = channel.url.clone().context("no url")?;
    let args = get_external_play_args(args_template, &url)?;
    eprintln!("with external player {player_path} and args: {:?}", args);

    if let Some(source) = source.as_ref() {
        _ = crate::utils::handle_max_streams(source, state)
            .await
            .map_err(|e| log::log(format!("{:?}", e)));
    }

    let player_name = Path::new(player_path)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| player_path.to_string());
    std::process::Command::new(player_path)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| crate::utils::friendly_spawn_error(&player_name, e))?;
    Ok(())
}

/// Builds the argument list for the external player. Every occurrence of the
/// literal token `{url}` in the template is replaced with the stream URL; when
/// the template is empty or contains no token, the URL is appended as the last
/// argument.
fn get_external_play_args(args_template: Option<&str>, url: &str) -> Result<Vec<String>> {
    let template = args_template.map(str::trim).unwrap_or("");
    if template.is_empty() {
        return Ok(vec![url.to_string()]);
    }
    let mut args = shell_words::split(template)
        .context("failed to parse the external player arguments; check the quoting")?;
    let mut replaced = false;
    for arg in args.iter_mut() {
        if arg.contains(EXTERNAL_PLAYER_URL_TOKEN) {
            *arg = arg.replace(EXTERNAL_PLAYER_URL_TOKEN, url);
            replaced = true;
        }
    }
    if !replaced {
        args.push(url.to_string());
    }
    Ok(args)
}

pub async fn cancel_play(
    source_id: i64,
    key: String,
    state: State<'_, Mutex<AppState>>,
) -> Result<()> {
    log::log(format!("Cancelling play for channel: {}", key));
    let token = crate::utils::remove_from_play_stop(state, &source_id, &key).await?;
    let token = token.context("no channel found")?;
    token.cancel();
    Ok(())
}

/// Path to the mpv binary (bundled or system), for the embedded player.
pub fn get_mpv_path() -> String {
    MPV_PATH.clone()
}

/// Builds the arguments for the single, persistent mpv process used by the
/// embedded player. Only "global" options belong here (things set once for the
/// lifetime of the process): the embed target (`--wid`), the IPC server, idle
/// mode, decoding/GPU, default languages/volume and the on-screen controller.
///
/// Everything that varies per channel — the URL, per-stream HTTP headers,
/// title, recording, caching and resume behaviour — is applied at play time via
/// JSON IPC (see `player.rs`), NOT here, so switching channels never restarts
/// mpv. This mirrors the per-launch subset of [`get_play_args`].
pub fn get_global_mpv_args(wid: isize, ipc_pipe: &str) -> Result<Vec<String>> {
    let settings = get_settings()?;
    let mut args = Vec::new();
    args.push(format!("--wid={wid}"));
    args.push("--idle=yes".to_string());
    args.push("--force-window=yes".to_string());
    args.push(format!("--input-ipc-server={ipc_pipe}"));
    args.push("--no-terminal".to_string());
    if let Some(path) = mpv_log_path() {
        args.push(format!("--log-file={path}"));
    }
    args.push("--keep-open=no".to_string());
    args.push(ARG_MSG_LEVEL.to_string());
    if settings.enable_hwdec.unwrap_or(true) {
        args.push(ARG_HWDEC.to_string());
    }
    if settings.enable_gpu.unwrap_or(false) {
        args.push(ARG_GPU_NEXT.to_string());
        args.push(ARG_GPU_PROFILE_HIGH_QUALITY.to_string());
    }
    if OS == "macos" && *MPV_PATH != MPV_BIN_NAME {
        args.push(format!("{}{}", ARG_YTDLP_PATH, *YTDLP_PATH));
    }
    if let Some(volume) = settings.volume {
        args.push(format!("{ARG_VOLUME}{volume}"));
    }
    if let Some(slang) = settings
        .preferred_subtitle_language
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        args.push(format!("{ARG_SLANG}{slang}"));
        args.push(ARG_SUB_AUTO_FUZZY.to_string());
    }
    if let Some(alang) = settings
        .preferred_audio_language
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        args.push(format!("{ARG_ALANG}{alang}"));
    }
    let tethys_script = if settings.player_ui.as_deref() == Some(PLAYER_UI_CLASSIC) {
        None
    } else {
        ensure_tethys_script()
            .map_err(|e| log::log(format!("{:?}", e.context("failed to set up player UI"))))
            .ok()
    };
    args.extend(get_player_ui_args(
        settings.player_ui.as_deref(),
        tethys_script.as_deref(),
    ));
    if settings.normalize_volume == Some(true) {
        args.push(ARG_NORMALIZE_AUDIO.to_string());
    }
    if let Some(mpv_params) = settings.mpv_params {
        #[cfg(not(target_os = "windows"))]
        let mut params = shell_words::split(&mpv_params)?;
        #[cfg(target_os = "windows")]
        let mut params = winsplit::split(&mpv_params);
        args.append(&mut params);
    }
    Ok(args)
}

/// Path for mpv's own log file, next to the app log. The embedded player
/// discards mpv's stdout/stderr, so without this a stream that never opens
/// leaves no trace anywhere.
fn mpv_log_path() -> Option<String> {
    let dir = directories::ProjectDirs::from("dev", "kaveyro", "streameoIPTV")?
        .cache_dir()
        .join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("mpv.log").to_string_lossy().to_string())
}

fn get_play_args(
    channel: &Channel,
    record: bool,
    record_path: Option<String>,
    source: &Option<Source>,
) -> Result<Vec<String>> {
    let mut args = Vec::new();
    let settings = get_settings()?;
    let headers = sql::get_channel_headers_by_id(channel.id.context("no channel id?")?)?;
    args.push(channel.url.clone().context("no url")?);
    if channel.episode_num.is_some() {
        for url in sql::find_all_episodes_after(channel)? {
            args.push(url);
        }
        args.push(ARG_NO_RESUME_PLAYBACK.to_string());
    }
    if channel.media_type != media_type::LIVESTREAM {
        args.push(ARG_SAVE_POSITION_ON_QUIT.to_string());
    }
    if settings.use_stream_caching == Some(false) {
        let stream_caching_arg = format!("{ARG_CACHE}{ARG_NO}",);
        args.push(stream_caching_arg);
    }
    if settings.enable_hwdec.unwrap_or(true) {
        args.push(ARG_HWDEC.to_string());
    }
    if settings.enable_gpu.unwrap_or(false) {
        args.push(ARG_GPU_NEXT.to_string());
        args.push(ARG_GPU_PROFILE_HIGH_QUALITY.to_string());
    }
    if record {
        let path = if let Some(p) = record_path {
            p
        } else if let Some(p) = settings.recording_path.map(get_path) {
            p
        } else {
            get_path(get_default_record_path()?)
        };
        args.push(format!("{ARG_RECORD}{path}"));
    }
    if OS == "macos" && *MPV_PATH != MPV_BIN_NAME {
        args.push(format!("{}{}", ARG_YTDLP_PATH, *YTDLP_PATH));
    }
    args.push(format!("{}{}", ARG_TITLE, channel.name));
    args.push(ARG_MSG_LEVEL.to_string());
    if channel.media_type == media_type::LIVESTREAM {
        args.push(ARG_PREFETCH_PLAYLIST.to_string());
        args.push(ARG_LOOP_PLAYLIST.to_string());
    }
    if let Some(volume) = settings.volume {
        args.push(format!("{ARG_VOLUME}{volume}"));
    }
    if let Some(slang) = settings
        .preferred_subtitle_language
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        args.push(format!("{ARG_SLANG}{slang}"));
        args.push(ARG_SUB_AUTO_FUZZY.to_string());
    }
    if let Some(alang) = settings
        .preferred_audio_language
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        args.push(format!("{ARG_ALANG}{alang}"));
    }
    if headers.is_some() || source.is_some() {
        set_headers(headers, &mut args, source);
    }
    let tethys_script = if settings.player_ui.as_deref() == Some(PLAYER_UI_CLASSIC) {
        None
    } else {
        ensure_tethys_script()
            .map_err(|e| log::log(format!("{:?}", e.context("failed to set up player UI"))))
            .ok()
    };
    args.extend(get_player_ui_args(
        settings.player_ui.as_deref(),
        tethys_script.as_deref(),
    ));
    if settings.normalize_volume == Some(true) {
        args.push(ARG_NORMALIZE_AUDIO.to_string());
    }
    if let Some(mpv_params) = settings.mpv_params {
        #[cfg(not(target_os = "windows"))]
        let mut params = shell_words::split(&mpv_params)?;
        #[cfg(target_os = "windows")]
        let mut params = winsplit::split(&mpv_params);
        args.append(&mut params);
    }
    Ok(args)
}

/// Writes the embedded Tethys OSC script into the app data dir (refreshing it
/// when the embedded copy changes) and returns its path.
fn ensure_tethys_script() -> Result<String> {
    let dir = directories::ProjectDirs::from("dev", "kaveyro", "streameoIPTV")
        .context("project dir not found")?
        .data_dir()
        .join("player_ui");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(TETHYS_FILE_NAME);
    if std::fs::read_to_string(&path).ok().as_deref() != Some(TETHYS_LUA) {
        std::fs::write(&path, TETHYS_LUA)?;
    }
    Ok(path.to_string_lossy().to_string())
}

/// Args for the mpv on-screen controller. The modern style (default when the
/// setting is unset) replaces the stock OSC with the bundled Tethys
/// controller; if the script cannot be written to disk it falls back to
/// restyling the stock OSC via script-opts. "classic" leaves mpv untouched.
/// Only `--script-opts-append` is used for OSC options so the entries compose
/// with the ytdl hook option instead of replacing the whole list.
fn get_player_ui_args(player_ui: Option<&str>, tethys_script: Option<&str>) -> Vec<String> {
    if player_ui == Some(PLAYER_UI_CLASSIC) {
        return Vec::new();
    }
    let mut args: Vec<String> = match tethys_script {
        Some(script_path) => vec![
            ARG_OSC_OFF.to_string(),
            format!("{ARG_SCRIPT}{script_path}"),
            // No name/shortcut tooltips when hovering the controller buttons.
            format!("{ARG_SCRIPT_OPTS_APPEND}tethys-showShortcutTooltip=no"),
        ],
        None => MODERN_UI_OSC_OPTS
            .iter()
            .map(|opt| format!("{ARG_SCRIPT_OPTS_APPEND}{opt}"))
            .collect(),
    };
    args.extend(MODERN_UI_OSD_ARGS.iter().map(|s| s.to_string()));
    if OS == "windows" {
        args.push(ARG_OSD_FONT_WINDOWS.to_string());
    }
    args
}

fn set_headers(
    headers: Option<ChannelHttpHeaders>,
    args: &mut Vec<String>,
    source: &Option<Source>,
) {
    let headers = headers.unwrap_or_default();
    let mut headers_vec: Vec<String> = Vec::with_capacity(2);
    if let Some(origin) = headers.http_origin {
        headers_vec.push(format!("{HTTP_ORIGIN}{origin}"));
    }
    if let Some(referrer) = headers.referrer {
        headers_vec.push(format!("{HTTP_REFERRER}{referrer}"));
    }
    if let Some(user_agent) = headers
        .user_agent
        .or_else(|| source.as_ref().and_then(|f| f.stream_user_agent.clone()))
    {
        args.push(format!("{ARG_USER_AGENT}{user_agent}"));
    }
    if let Some(ignore_ssl) = headers.ignore_ssl {
        if ignore_ssl == true {
            args.push(ARG_IGNORE_SSL.to_string());
        }
    }
    if headers_vec.len() > 0 {
        let headers = headers_vec.join(",");
        args.push(format!("{ARG_HTTP_HEADERS}{headers}"));
    }
}

fn get_path(path_str: String) -> String {
    let path = Path::new(&path_str);
    let path = path.join(get_file_name());
    return path.to_string_lossy().to_string();
}

fn get_file_name() -> String {
    let current_time = Local::now();
    let formatted_time = current_time.format("%Y-%m-%d-%H-%M-%S").to_string();
    format!("{formatted_time}.mp4")
}

#[cfg(test)]
mod test_mpv {
    use super::{get_external_play_args, get_player_ui_args};

    #[test]
    fn test_modern_ui_uses_tethys_by_default() {
        for player_ui in [None, Some("modern")] {
            let args = get_player_ui_args(player_ui, Some("X:/data/player_ui/osc_tethys.lua"));
            assert!(args.contains(&"--osc=no".to_string()));
            assert!(args.contains(&"--script=X:/data/player_ui/osc_tethys.lua".to_string()));
            assert!(
                args.contains(&"--script-opts-append=tethys-showShortcutTooltip=no".to_string())
            );
            assert!(args.contains(&"--osd-bar-w=45".to_string()));
            assert!(args.contains(&"--osd-border-size=1".to_string()));
        }
    }

    #[test]
    fn test_modern_ui_falls_back_to_stock_osc_without_script() {
        let args = get_player_ui_args(Some("modern"), None);
        assert!(args.contains(&"--script-opts-append=osc-layout=slimbox".to_string()));
        assert!(args.contains(&"--script-opts-append=osc-timetotal=yes".to_string()));
        assert!(!args.contains(&"--osc=no".to_string()));
        // Every OSC option must go through --script-opts-append so it
        // composes with the ytdl hook entry instead of clobbering it.
        assert!(
            args.iter()
                .filter(|a| a.contains("osc-"))
                .all(|a| a.starts_with("--script-opts-append=")),
        );
    }

    #[test]
    fn test_modern_ui_args_absent_with_classic() {
        assert!(get_player_ui_args(Some("classic"), Some("X:/unused.lua")).is_empty());
    }

    #[test]
    fn test_external_args_url_token_replacement() {
        let args =
            get_external_play_args(Some("--fullscreen {url}"), "http://example.com/1.m3u8")
                .unwrap();
        assert_eq!(
            args,
            vec![
                "--fullscreen".to_string(),
                "http://example.com/1.m3u8".to_string()
            ]
        );
    }

    #[test]
    fn test_external_args_url_appended_when_no_token() {
        let args = get_external_play_args(Some("--fullscreen"), "http://example.com/1.m3u8")
            .unwrap();
        assert_eq!(
            args,
            vec![
                "--fullscreen".to_string(),
                "http://example.com/1.m3u8".to_string()
            ]
        );
    }

    #[test]
    fn test_external_args_empty_template() {
        for template in [None, Some(""), Some("   ")] {
            let args = get_external_play_args(template, "http://example.com/1.m3u8").unwrap();
            assert_eq!(args, vec!["http://example.com/1.m3u8".to_string()]);
        }
    }

    #[test]
    fn test_external_args_quoted_argument_with_token() {
        let args = get_external_play_args(
            Some(r#"--player-args "--title=My Stream" {url}"#),
            "http://example.com/1.m3u8",
        )
        .unwrap();
        assert_eq!(
            args,
            vec![
                "--player-args".to_string(),
                "--title=My Stream".to_string(),
                "http://example.com/1.m3u8".to_string()
            ]
        );
    }
}
