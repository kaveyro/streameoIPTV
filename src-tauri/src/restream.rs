use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{LazyLock, Mutex as StdMutex},
    time::Duration,
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use anyhow::{Context, Result};
use tauri::{AppHandle, Emitter, State};
use tokio::{
    fs,
    sync::{
        Mutex,
        oneshot::{self, Sender},
    },
};

use crate::{
    mpv,
    settings::get_settings,
    sql,
    types::{AppState, Channel, CustomChannel, NetworkInfo},
    utils::{api_client_builder, get_bin, serialize_to_file},
};

const WAN_IP_API: &str = "https://api.ipify.org";
const FFMPEG_BIN_NAME: &str = "ffmpeg";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// The running restream ffmpeg. Owned here rather than by the task that runs
/// the restream, so the app's exit path can kill it: a std `Child` is not
/// killed on drop, and a leftover ffmpeg keeps pulling the provider stream
/// (and occupies the subscription's only connection) forever.
static FFMPEG: StdMutex<Option<Child>> = StdMutex::new(None);

/// Random path segment every restream URL has to carry. The server listens on
/// all interfaces, so without it anyone on the network (or the internet, with
/// a forwarded port) could watch through the user's subscription.
static TOKEN: LazyLock<String> = LazyLock::new(|| {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("the OS random source is unavailable");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
});

fn stream_path() -> String {
    format!("{}/stream.m3u8", *TOKEN)
}

fn start_ffmpeg_listening(channel: Channel, restream_dir: PathBuf) -> Result<Child> {
    let url = mpv::channel_stream_url(&channel)?;
    let headers = sql::get_channel_headers_by_id(channel.id.context("no channel id")?)?;
    let source = channel
        .source_id
        .and_then(|id| sql::get_source_from_id(id).ok());
    let playlist_dir = get_playlist_dir(restream_dir);
    let mut command = Command::new(get_bin(FFMPEG_BIN_NAME));
    command.args(crate::utils::ffmpeg_input_args(
        headers,
        source.as_ref(),
        &url,
    ));
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let child = command
        .arg("-i")
        .arg(url)
        .arg("-c")
        .arg("copy")
        .arg("-f")
        .arg("hls")
        .arg("-hls_time")
        .arg("5")
        .arg("-hls_list_size")
        .arg("6")
        .arg("-hls_flags")
        .arg("delete_segments")
        .arg(playlist_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| crate::utils::friendly_spawn_error(FFMPEG_BIN_NAME, e))?;
    Ok(child)
}

/// Binds the web server before anything else is started, so a busy port is a
/// plain error instead of a panic that leaves ffmpeg running.
fn start_web_server(
    restream_dir: PathBuf,
    port: u16,
) -> Result<(Sender<bool>, tokio::task::JoinHandle<()>)> {
    use warp::Filter;
    let file_server = warp::path(TOKEN.as_str()).and(warp::fs::dir(restream_dir));
    let (tx, rx) = oneshot::channel::<bool>();
    let (_, server) = warp::serve(file_server)
        .try_bind_with_graceful_shutdown(([0, 0, 0, 0], port), async {
            rx.await.ok();
        })
        .with_context(|| format!("Port {port} is already in use, pick another restream port"))?;
    let handle = tokio::spawn(server);
    Ok((tx, handle))
}

pub async fn start_restream(
    port: u16,
    state: State<'_, Mutex<AppState>>,
    app: AppHandle,
    channel: Channel,
) -> Result<()> {
    if FFMPEG.lock().map(|f| f.is_some()).unwrap_or(false) {
        anyhow::bail!("A restream is already running");
    }
    let stop = state.lock().await.restream_stop_signal.clone();
    stop.store(false, std::sync::atomic::Ordering::Relaxed);
    let restream_dir = get_restream_folder()?;
    delete_old_segments(&restream_dir).await?;
    let (web_server_tx, web_server_handle) = start_web_server(restream_dir.clone(), port)?;
    let child = match start_ffmpeg_listening(channel, restream_dir) {
        Ok(child) => child,
        Err(e) => {
            let _ = web_server_tx.send(true);
            let _ = web_server_handle.await;
            return Err(e);
        }
    };
    if let Ok(mut slot) = FFMPEG.lock() {
        *slot = Some(child);
    }
    let _ = app.emit("restream_started", true);
    while !stop.load(std::sync::atomic::Ordering::Relaxed)
        && ffmpeg_running()
        && !web_server_handle.is_finished()
    {
        tokio::time::sleep(Duration::from_millis(500)).await
    }
    kill_sync();
    let _ = web_server_tx.send(true);
    let _ = web_server_handle.await;
    Ok(())
}

fn ffmpeg_running() -> bool {
    match FFMPEG.lock() {
        Ok(mut slot) => match slot.as_mut() {
            Some(child) => child.try_wait().map(|s| s.is_none()).unwrap_or(true),
            None => false,
        },
        Err(_) => false,
    }
}

/// Kills the restream ffmpeg, if any. Synchronous so the app exit path can
/// call it.
pub fn kill_sync() {
    if let Ok(mut slot) = FFMPEG.lock()
        && let Some(mut child) = slot.take()
    {
        let _ = child.kill();
        let _ = child.wait();
    }
}

pub async fn stop_restream(state: State<'_, Mutex<AppState>>) -> Result<()> {
    let state = state.lock().await;
    state
        .restream_stop_signal
        .store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

fn get_playlist_dir(mut folder: PathBuf) -> String {
    folder.push("stream.m3u8");
    folder.to_string_lossy().to_string()
}

fn get_restream_folder() -> Result<PathBuf> {
    let mut path = directories::ProjectDirs::from("dev", "kaveyro", "streameoIPTV")
        .context("can't find project folder")?
        .cache_dir()
        .to_owned();
    path.push("restream");
    if !path.exists() {
        std::fs::create_dir_all(&path).unwrap();
    }
    Ok(path)
}

async fn delete_old_segments(dir: &Path) -> Result<()> {
    fs::remove_dir_all(dir).await?;
    fs::create_dir_all(dir).await?;
    Ok(())
}

pub async fn watch_self(port: u16, state: State<'_, Mutex<AppState>>) -> Result<()> {
    let channel = Channel {
        number: None,
        watch_position: None,
        watch_duration: None,
        watch_finished: None,
        url: Some(format!("http://127.0.0.1:{port}/{}", stream_path())),
        name: "Local livestream".to_string(),
        favorite: false,
        group: None,
        group_id: None,
        id: Some(-1),
        image: None,
        media_type: crate::media_type::LIVESTREAM,
        series_id: None,
        source_id: None,
        stream_id: None,
        tv_archive: None,
        season_id: None,
        episode_num: None,
        hidden: Some(false),
        epg_channel_id: None,
    };
    mpv::play(channel, false, None, state).await
}

pub fn share_restream(address: String, channel: Channel, path: String) -> Result<()> {
    let channel = CustomChannel {
        headers: sql::get_channel_headers_by_id(channel.id.context("No id on channel?")?)?,
        data: Channel {
            number: None,
            watch_position: None,
            watch_duration: None,
            watch_finished: None,
            id: Some(-1),
            name: format!("RST | {}", channel.name).to_string(),
            url: Some(address),
            group: None,
            image: channel.image,
            media_type: crate::media_type::LIVESTREAM,
            source_id: None,
            series_id: None,
            group_id: None,
            favorite: false,
            stream_id: None,
            tv_archive: None,
            season_id: None,
            episode_num: None,
            hidden: Some(false),
            epg_channel_id: None,
        },
    };
    serialize_to_file(channel, path)
}

pub async fn get_network_info() -> Result<NetworkInfo> {
    let port = get_settings()?.restream_port.unwrap_or(3000);
    Ok(NetworkInfo {
        port,
        local_ips: get_ips(port)?,
        wan_ip: get_wan_ip(port).await,
    })
}

fn get_ips(port: u16) -> Result<Vec<String>> {
    Ok(if_addrs::get_if_addrs()?
        .iter()
        .filter(|i| i.ip().is_ipv4() && !i.ip().is_loopback())
        .map(|i| format!("http://{}:{port}/{}", i.ip(), stream_path()))
        .collect())
}

/// The public address, or an empty string when it cannot be determined
/// (offline, the lookup service is down) — the LAN addresses still work then.
async fn get_wan_ip(port: u16) -> String {
    let lookup = async {
        let ip = api_client_builder()
            .build()?
            .get(WAN_IP_API)
            .send()
            .await?
            .error_for_status()?
            .text()
            .await?;
        anyhow::Ok(ip.trim().to_string())
    };
    match lookup.await {
        Ok(ip) if !ip.is_empty() => format!("http://{ip}:{port}/{}", stream_path()),
        Ok(_) => String::new(),
        Err(e) => {
            crate::log::log(format!(
                "{:?}",
                e.context("failed to look up the public IP")
            ));
            String::new()
        }
    }
}
