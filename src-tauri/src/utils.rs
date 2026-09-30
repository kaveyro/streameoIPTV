use crate::types::{AppState, Channel, ChannelPreserve};
use crate::{
    log::log,
    m3u,
    settings::{get_default_record_path, get_settings},
    source_type, sql,
    types::Source,
    xtream,
};
use anyhow::{Context, Result, anyhow, bail};
use chrono::{DateTime, Local, Utc};
use directories::ProjectDirs;
use regex::Regex;
use reqwest::{
    Client,
    header::{HeaderMap, HeaderValue},
};
use serde::Serialize;
use std::{
    env::{consts::OS, current_exe},
    fs::File,
    path::{Path, PathBuf},
    sync::LazyLock,
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use which::which;

const MACOS_POTENTIAL_PATHS: [&str; 3] = [
    "/opt/local/bin",    // MacPorts
    "/opt/homebrew/bin", // Homebrew on AARCH64 Mac
    "/usr/local/bin",    // Homebrew on AMD64 Mac
];

const DEFAULT_USER_AGENT: &str = "Streameo IPTV";

/// Maximum time allowed to establish a TCP connection.
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Maximum total time allowed for a regular API request (connect + response body).
const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Shared reqwest client builder for API-style requests (small, bounded responses).
/// Applies both a connect timeout and an overall request timeout.
pub fn api_client_builder() -> reqwest::ClientBuilder {
    Client::builder()
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
        .timeout(HTTP_REQUEST_TIMEOUT)
}

/// Shared reqwest client builder for downloads and other potentially long-running
/// transfers. Only applies a connect timeout so large/slow downloads are not aborted
/// by a total-request timeout.
pub fn download_client_builder() -> reqwest::ClientBuilder {
    Client::builder().connect_timeout(HTTP_CONNECT_TIMEOUT)
}

static ILLEGAL_CHARS_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"[<>:"/\\|?*\x00-\x1F]"#).unwrap());

pub async fn refresh_source(source: Source) -> Result<()> {
    let id = source.id;
    match source.source_type {
        source_type::M3U => {
            tokio::task::spawn_blocking(move || m3u::read_m3u8(source, true)).await??
        }
        source_type::M3U_LINK => m3u::get_m3u8_from_link(source, true).await?,
        source_type::XTREAM => xtream::get_xtream(source, true).await?,
        source_type::CUSTOM => {}
        _ => return Err(anyhow!("invalid source_type")),
    }
    if let Some(id) = id {
        sql::update_source_last_updated(id)?;
    }
    // A refresh rewrites the whole source: shrink the WAL it left behind.
    tokio::task::spawn_blocking(sql::checkpoint_wal).await?;
    Ok(())
}

/// Refreshes every enabled source. One broken provider no longer stops the
/// others: all of them are tried, and the failures are reported together.
pub async fn refresh_all() -> Result<()> {
    let mut failed: Vec<String> = Vec::new();
    for source in sql::get_enabled_sources()? {
        if source.source_type == source_type::CUSTOM {
            continue;
        }
        let name = source.name.clone();
        if let Err(e) = refresh_source(source).await {
            log(format!(
                "{:?}",
                e.context(format!("refresh failed for source {name}"))
            ));
            failed.push(name);
        }
    }
    if !failed.is_empty() {
        return Err(anyhow!("Refreshing failed for: {}", failed.join(", ")));
    }
    Ok(())
}

pub fn get_local_time(timestamp: i64) -> Result<DateTime<Local>> {
    let datetime = DateTime::<Utc>::from_timestamp(timestamp, 0).context("no time")?;
    Ok(DateTime::<Local>::from(datetime))
}

pub async fn download(
    state: State<'_, Mutex<AppState>>,
    app: AppHandle,
    channel: Channel,
    download_id: &str,
    path: Option<String>,
) -> Result<()> {
    let source_id = channel.source_id.context("no source id provided")?;
    let source = sql::get_source_from_id(source_id)
        .with_context(|| format!("failed to fetch source with id {}", source_id))?;

    _ = handle_max_streams(&source, &state)
        .await
        .map_err(|e| log(format!("{:?}", e)));

    let token = CancellationToken::new();
    _ = insert_play_token(source_id, download_id.to_string(), token.clone(), &state)
        .await
        .map_err(|e| log(format!("{:?}", e)));

    let headers = sql::get_channel_headers_by_id(channel.id.context("no channel id?")?)?;
    let mut client = download_client_builder();
    let mut headers_map = HeaderMap::new();
    if let Some(headers) = headers.as_ref() {
        if let Some(origin) = headers.http_origin.as_ref() {
            headers_map.insert("Origin", HeaderValue::from_str(origin)?);
        }
        if let Some(referrer) = headers.referrer.as_ref() {
            headers_map.insert("Referer", HeaderValue::from_str(referrer)?);
        }
        if let Some(ignore_ssl) = headers.ignore_ssl
            && ignore_ssl
        {
            client = client.danger_accept_invalid_certs(true);
        }
    }
    let user_agent = headers
        .and_then(|f| f.user_agent)
        .or(source.stream_user_agent)
        .unwrap_or_else(|| DEFAULT_USER_AGENT.to_string());
    let client = client
        .user_agent(user_agent)
        .default_headers(headers_map)
        .build()?;
    let url = crate::mpv::channel_stream_url(&channel)?;
    let name = channel.name.clone();
    let result = download_to_file(&client, &url, name, path, &token, &app, download_id).await;

    // Always release the stream slot, also when the request itself failed —
    // a stale token would keep counting against the source's max_streams.
    _ = remove_from_play_stop(state, &source_id, download_id)
        .await
        .map_err(|e| log(format!("{:?}", e)));
    result
}

async fn download_to_file(
    client: &reqwest::Client,
    url: &str,
    name: String,
    path: Option<String>,
    token: &CancellationToken,
    app: &AppHandle,
    download_id: &str,
) -> Result<()> {
    let mut response = client.get(url).send().await?;
    // Checked before the file exists, so an HTTP error leaves no empty file.
    if !response.status().is_success() {
        let error = response.status();
        bail!("Failed to download movie: HTTP {error}")
    }
    let total_size = response.content_length().unwrap_or(0);
    let mut downloaded = 0;
    let path = match path {
        Some(p) => p,
        None => get_download_path(get_filename(name, url))?,
    };
    let mut file = tokio::fs::File::create(&path).await?;
    let mut send_threshold: f64 = 0.1;

    let mut result: Result<()> = loop {
        tokio::select! {
          chunk = response.chunk() => {
               match chunk {
                   Ok(Some(chunk)) => {
                       if let Err(e) = file.write_all(&chunk).await {
                           break Err(e.into());
                       }
                       downloaded += chunk.len() as u64;
                       if total_size > 0 {
                           let progress: f64 = (downloaded as f64 / total_size as f64) * 100.0;
                           let progress = (progress * 10.0).trunc() / 10.0;
                           if progress > send_threshold {
                               let _ = app.emit(&format!("progress-{}", download_id), progress);
                               send_threshold = progress + 0.1_f64;
                           }
                       }
                   }
                   Ok(None) => break Ok(()),
                   Err(e) => break Err(e.into()),
               }
          }
          _ = token.cancelled() => {
               break Err(anyhow!("download aborted"));
          }
        }
    };

    if result.is_ok() {
        // Surface a failing final write instead of reporting success early.
        result = file.flush().await.map_err(Into::into);
    }
    drop(file);
    if let Err(e) = result {
        // A partial file looks like a finished movie in the folder; remove it
        // whatever the reason (abort, network error, full disk).
        let _ = tokio::fs::remove_file(&path).await;
        return Err(e);
    }
    Ok(())
}

pub async fn remove_from_play_stop(
    state: State<'_, Mutex<AppState>>,
    source_id: &i64,
    key: &str,
) -> Result<Option<CancellationToken>> {
    let mut state = state.lock().await;
    let map = state
        .play_stop
        .get_mut(source_id)
        .context("no indexMap for sourceId")?;
    Ok(map.shift_remove(key))
}

pub async fn handle_max_streams(source: &Source, state: &State<'_, Mutex<AppState>>) -> Result<()> {
    let max_streams = source.max_streams.unwrap_or(1);
    let mut guard = state.lock().await;
    let channels = guard
        .play_stop
        .get_mut(source.id.as_ref().context("no id")?);
    if channels.is_none() {
        return Ok(());
    }
    let channels = channels.context("no channels")?;
    if channels.len() < max_streams.into() {
        return Ok(());
    }
    let (_, token) = channels
        .shift_remove_index(0)
        .context("failed to remove channel from indexMap")?;
    token.cancel();
    Ok(())
}

pub async fn insert_play_token(
    source_id: i64,
    key: String,
    token: CancellationToken,
    state: &State<'_, Mutex<AppState>>,
) -> Result<()> {
    let mut guard = state.lock().await;
    guard
        .play_stop
        .entry(source_id)
        .or_default()
        .insert(key, token);
    Ok(())
}

fn get_filename(channel_name: String, url: &str) -> String {
    let extension = get_extension(url);
    let mut channel_name = sanitize(channel_name)
        .trim()
        .trim_end_matches('.')
        .to_string();
    if channel_name.is_empty() {
        channel_name = "download".to_string();
    }
    format!("{channel_name}.{extension}")
}

/// Extension of the URL's last path segment, ignoring query and fragment.
/// Anything that does not look like a real extension (`php`, a path, a token)
/// falls back to mp4, so the name can never contain `?`, `/` or `..`.
fn get_extension(url: &str) -> String {
    let path = url::Url::parse(url)
        .map(|u| u.path().to_string())
        .unwrap_or_else(|_| url.split(['?', '#']).next().unwrap_or("").to_string());
    let segment = path.rsplit('/').next().unwrap_or("");
    segment
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .filter(|ext| {
            (1..=5).contains(&ext.len())
                && ext.chars().all(|c| c.is_ascii_alphanumeric())
                && ext != "php"
        })
        .unwrap_or_else(|| "mp4".to_string())
}

pub fn sanitize(str: String) -> String {
    ILLEGAL_CHARS_REGEX.replace_all(&str, "").to_string()
}

fn get_download_path(file_name: String) -> Result<String> {
    let settings = get_settings()?;
    let path = match settings.recording_path {
        Some(path) => path,
        None => get_default_record_path()?,
    };
    let mut path = Path::new(&path).to_path_buf();
    path.push(file_name);
    Ok(path.to_string_lossy().to_string())
}
pub fn get_bin(bin: &str) -> String {
    if OS == "linux" || which(bin).is_ok() {
        return bin.to_string();
    } else if OS == "macos" {
        return find_macos_bin(bin);
    }
    get_bin_from_deps(bin)
}

/// Turns the raw io error from spawning an external binary into a message a
/// user can act on ("mpv was not found..." instead of "os error 2").
pub fn friendly_spawn_error(bin: &str, e: std::io::Error) -> anyhow::Error {
    if e.kind() == std::io::ErrorKind::NotFound {
        anyhow::anyhow!(
            "{bin} was not found on this system. Install {bin} and make sure it is on your PATH (or reinstall the app, which bundles it), then restart streameo."
        )
    } else {
        anyhow::Error::new(e).context(format!("Failed to start {bin}"))
    }
}

fn get_bin_from_deps(bin: &str) -> String {
    let mut path = current_exe().unwrap();
    path.pop();
    path.push("deps");
    path.push(bin);
    path.to_string_lossy().to_string()
}

pub fn find_macos_bin(bin: &str) -> String {
    MACOS_POTENTIAL_PATHS
        .iter()
        .map(|path| {
            let mut path = Path::new(path).to_path_buf();
            path.push(bin);
            path
        })
        .find(|path| path.exists())
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| {
            log(format!("Could not find {} on MacOS host", bin));
            bin.to_string()
        })
}

pub fn serialize_to_file<T: Serialize>(obj: T, path: String) -> Result<()> {
    let data = serde_json::to_string(&obj)?;
    std::fs::write(path, data)?;
    Ok(())
}

pub fn backup_favs(source_id: i64, path: String) -> Result<()> {
    sql::do_tx(|tx| {
        let preserve = sql::get_preserve(tx, source_id)?;
        serialize_to_file(preserve, path)?;
        Ok(())
    })?;
    Ok(())
}

pub fn restore_favs(source_id: i64, path: String) -> Result<()> {
    let data = std::fs::read_to_string(path)?;
    let preserve: Vec<ChannelPreserve> = serde_json::from_str(&data)?;
    sql::do_tx(|tx| {
        sql::restore_preserve(tx, source_id, preserve, crate::parental::has_pin()?)?;
        Ok(())
    })?;
    Ok(())
}

pub fn is_container() -> bool {
    std::env::var("container").is_ok()
}

pub fn create_nuke_request() -> Result<()> {
    let path = get_nuke_path()?;
    // On a fresh install the cache dir may not exist yet.
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    File::create(path)?;
    std::process::exit(0);
}

fn get_nuke_path() -> Result<PathBuf> {
    let path =
        ProjectDirs::from("dev", "kaveyro", "streameoIPTV").context("project dir not found")?;
    let path = path.cache_dir();
    let path = path.join("nuke.txt");
    Ok(path)
}

pub fn check_nuke() -> Result<()> {
    let path = get_nuke_path()?;
    if !path.exists() {
        return Ok(());
    }
    std::fs::remove_file(path)?;
    let path =
        ProjectDirs::from("dev", "kaveyro", "streameoIPTV").context("project dir not found")?;
    let path = path.data_dir();
    let path = path.join(sql::DB_NAME);
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

pub fn get_user_agent_from_source(source: &Source) -> Result<String> {
    let user_agent: &str = source
        .user_agent
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(DEFAULT_USER_AGENT);
    Ok(user_agent.to_string())
}

#[cfg(test)]
mod test_utils {
    use super::sanitize;

    #[test]
    fn test_sanitize() {
        assert_eq!(
            "SuperShow Who will win the million".to_string(),
            sanitize("SuperShow: Who will win the million?".to_string())
        );
    }
}

/// ffmpeg input options for a channel: HTTP headers, TLS and reconnects. They
/// must come before `-i`, or ffmpeg applies them to the output.
///
/// `-headers` is a single string option — every repetition replaces the
/// previous value — so all headers go into one CRLF-separated value, and the
/// user agent uses its dedicated option. The source's stream user agent is the
/// fallback, as in mpv.
pub fn ffmpeg_input_args(
    headers: Option<crate::types::ChannelHttpHeaders>,
    source: Option<&Source>,
    url: &str,
) -> Vec<String> {
    let headers = headers.unwrap_or_default();
    let mut args = Vec::new();
    let mut header_lines = String::new();
    if let Some(referrer) = headers.referrer.filter(|v| !v.trim().is_empty()) {
        header_lines.push_str(&format!("Referer: {referrer}\r\n"));
    }
    if let Some(origin) = headers.http_origin.filter(|v| !v.trim().is_empty()) {
        header_lines.push_str(&format!("Origin: {origin}\r\n"));
    }
    if !header_lines.is_empty() {
        args.push("-headers".to_string());
        args.push(header_lines);
    }
    if let Some(user_agent) = headers
        .user_agent
        .or_else(|| source.and_then(|s| s.stream_user_agent.clone()))
        .filter(|v| !v.trim().is_empty())
    {
        args.push("-user_agent".to_string());
        args.push(user_agent);
    }
    if headers.ignore_ssl == Some(true) {
        args.push("-tls_verify".to_string());
        args.push("0".to_string());
    }
    if url.starts_with("http://") || url.starts_with("https://") {
        for flag in [
            "-reconnect",
            "-reconnect_at_eof",
            "-reconnect_streamed",
            "-reconnect_on_network_error",
        ] {
            args.push(flag.to_string());
            args.push("1".to_string());
        }
    }
    args
}

#[cfg(test)]
mod test_ffmpeg_input_args {
    use super::ffmpeg_input_args;
    use crate::types::ChannelHttpHeaders;

    #[test]
    fn test_all_headers_go_into_one_option() {
        let headers = ChannelHttpHeaders {
            referrer: Some("http://ref".to_string()),
            http_origin: Some("http://origin".to_string()),
            user_agent: Some("UA".to_string()),
            ..Default::default()
        };
        let args = ffmpeg_input_args(Some(headers), None, "http://h/s.ts");
        assert_eq!(args.iter().filter(|a| *a == "-headers").count(), 1);
        let pos = args.iter().position(|a| a == "-headers").unwrap();
        assert_eq!(
            args[pos + 1],
            "Referer: http://ref\r\nOrigin: http://origin\r\n"
        );
        let pos = args.iter().position(|a| a == "-user_agent").unwrap();
        assert_eq!(args[pos + 1], "UA");
    }

    #[test]
    fn test_reconnect_only_for_http() {
        assert!(ffmpeg_input_args(None, None, "http://h/s.ts").contains(&"-reconnect".to_string()));
        assert!(!ffmpeg_input_args(None, None, "rtmp://h/s").contains(&"-reconnect".to_string()));
    }
}

#[cfg(test)]
mod test_download_filename {
    use super::{get_extension, get_filename};

    #[test]
    fn test_extension_ignores_the_query() {
        assert_eq!(
            get_extension("http://h/movie/u/p/1.mkv?token=abc.def"),
            "mkv"
        );
    }

    #[test]
    fn test_extensionless_url_falls_back_to_mp4() {
        assert_eq!(get_extension("http://cdn.example.com/vod/abc"), "mp4");
        assert_eq!(get_extension("http://h/a.x/../../.."), "mp4");
        assert_eq!(get_extension("http://h/get.php?id=1"), "mp4");
    }

    #[test]
    fn test_filename_has_no_path_characters() {
        let name = get_filename("A/B: C?".to_string(), "http://h/x.mp4?t=1");
        assert_eq!(name, "AB C.mp4");
    }
}
