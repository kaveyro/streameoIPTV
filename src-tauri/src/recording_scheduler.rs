//! Lightweight PVR: records scheduled EPG programs in the background.
//!
//! A tokio task (started from the app setup hook) wakes up every 30 seconds,
//! starts an ffmpeg `-c copy` capture for every due recording and reaps
//! finished ones. Child process handles are kept in a module-level map so an
//! active recording can be cancelled from a tauri command.

use std::{
    collections::HashMap,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{LazyLock, Mutex},
    time::Duration,
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use anyhow::{Context, Result, anyhow};
use chrono::Local;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::{
    log::log,
    settings::{get_default_record_path, get_settings},
    sql,
    types::{Channel, ScheduledRecording},
    utils::{get_bin, sanitize},
};

pub const STATUS_PENDING: u8 = 0;
pub const STATUS_RECORDING: u8 = 1;
pub const STATUS_DONE: u8 = 2;
pub const STATUS_FAILED: u8 = 3;

const FFMPEG_BIN_NAME: &str = "ffmpeg";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const POLL_INTERVAL: Duration = Duration::from_secs(30);
/// If ffmpeg exits on its own more than this many seconds before the scheduled
/// end, the recording is considered failed instead of done (stream died,
/// wrong URL, ...). Within the tolerance it is just `-t` finishing early.
const EARLY_EXIT_TOLERANCE_SECS: i64 = 60;

struct ActiveRecording {
    child: Child,
    end_timestamp: i64,
}

/// Child handles of currently running ffmpeg captures, keyed by
/// scheduled_recordings.id. std Mutex is fine: it is only held for short,
/// non-async critical sections.
static ACTIVE: LazyLock<Mutex<HashMap<i64, ActiveRecording>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Starts the background scheduler loop. Called once from the tauri setup hook.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Startup recovery: fail stale rows, keep partially-missed pending
        // rows so the first tick records whatever time remains.
        if let Err(e) = sql::recover_scheduled_recordings(now()) {
            log(format!("{:?}", e.context("recording scheduler recovery")));
        }
        loop {
            if let Err(e) = tick(&app) {
                log(format!("{:?}", e.context("recording scheduler tick")));
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Validates and persists a new scheduled recording (status pending).
pub fn schedule(
    channel_id: i64,
    title: Option<String>,
    start_timestamp: i64,
    end_timestamp: i64,
) -> Result<()> {
    if end_timestamp <= start_timestamp {
        return Err(anyhow!("Recording end must be after its start"));
    }
    // A start in the past is fine (partial recording), an end in the past is not.
    if end_timestamp <= now() {
        return Err(anyhow!("Cannot schedule a recording that already ended"));
    }
    sql::add_scheduled_recording(&ScheduledRecording {
        id: None,
        channel_id,
        title,
        start_timestamp,
        end_timestamp,
        status: STATUS_PENDING,
        channel_name: None,
    })?;
    Ok(())
}

/// Cancels a scheduled recording: kills ffmpeg if it is currently running,
/// then deletes the row. Any partial file recorded so far is kept.
pub fn cancel(id: i64) -> Result<()> {
    if let Some(mut active) = lock_active()?.remove(&id) {
        let _ = active.child.kill();
        let _ = active.child.wait();
    }
    sql::delete_scheduled_recording(id)
}

fn lock_active() -> Result<std::sync::MutexGuard<'static, HashMap<i64, ActiveRecording>>> {
    ACTIVE
        .lock()
        .map_err(|_| anyhow!("active recordings mutex poisoned"))
}

/// One scheduler iteration: reap finished captures, then start due ones.
fn tick(app: &AppHandle) -> Result<()> {
    let current = now();
    reap_finished(current)?;
    for recording in sql::get_due_recordings(current)? {
        let id = recording.id.context("scheduled recording without id")?;
        if lock_active()?.contains_key(&id) {
            continue;
        }
        match start_recording(&recording, current) {
            Ok(child) => {
                lock_active()?.insert(
                    id,
                    ActiveRecording {
                        child,
                        end_timestamp: recording.end_timestamp,
                    },
                );
                sql::set_scheduled_recording_status(id, STATUS_RECORDING)?;
                notify_started(app, &recording);
            }
            Err(e) => {
                log(format!(
                    "{:?}",
                    e.context(format!("failed to start scheduled recording {id}"))
                ));
                sql::set_scheduled_recording_status(id, STATUS_FAILED)?;
            }
        }
    }
    Ok(())
}

/// Checks every active ffmpeg process: kill it once its end time passed, and
/// mark rows done/failed for processes that exited.
fn reap_finished(current: i64) -> Result<()> {
    let mut finished: Vec<(i64, u8)> = Vec::new();
    {
        let mut active = lock_active()?;
        for (id, recording) in active.iter_mut() {
            match recording.child.try_wait() {
                // ffmpeg exited by itself: `-t` ran out (done) or the stream
                // died well before the scheduled end (failed).
                Ok(Some(_)) => {
                    let status = if current < recording.end_timestamp - EARLY_EXIT_TOLERANCE_SECS {
                        STATUS_FAILED
                    } else {
                        STATUS_DONE
                    };
                    finished.push((*id, status));
                }
                // Still running: stop it once the end time has passed
                // (belt and braces on top of ffmpeg's own -t limit).
                Ok(None) => {
                    if current >= recording.end_timestamp {
                        let _ = recording.child.kill();
                        let _ = recording.child.wait();
                        finished.push((*id, STATUS_DONE));
                    }
                }
                Err(e) => {
                    log(format!("failed to poll recording {id}: {e:?}"));
                    finished.push((*id, STATUS_FAILED));
                }
            }
        }
        for (id, _) in &finished {
            active.remove(id);
        }
    }
    for (id, status) in finished {
        // The row may have been deleted by a concurrent cancel; ignore errors.
        let _ =
            sql::set_scheduled_recording_status(id, status).map_err(|e| log(format!("{:?}", e)));
    }
    Ok(())
}

/// Spawns ffmpeg for one due recording:
/// `ffmpeg -y [header args] -i <url> -t <remaining secs> -c copy <output>.ts`
fn start_recording(recording: &ScheduledRecording, current: i64) -> Result<Child> {
    let channel = sql::get_channel_by_id(recording.channel_id)?;
    let url = crate::mpv::channel_stream_url(&channel)?;
    let remaining_secs = recording.end_timestamp - current;
    let output = get_output_path(recording, &channel)?;
    let mut command = Command::new(get_bin(FFMPEG_BIN_NAME));
    command.arg("-y");
    let source = channel
        .source_id
        .and_then(|id| sql::get_source_from_id(id).ok());
    let headers = sql::get_channel_headers_by_id(recording.channel_id)?;
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
        .arg("-t")
        .arg(remaining_secs.to_string())
        .arg("-c")
        .arg("copy")
        .arg(output)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| crate::utils::friendly_spawn_error(FFMPEG_BIN_NAME, e))?;
    Ok(child)
}

/// `<recording_path>/<sanitized title or channel name>-<yyyyMMdd-HHmm>.ts`,
/// falling back to the same default directory the manual record feature uses.
fn get_output_path(recording: &ScheduledRecording, channel: &Channel) -> Result<String> {
    let settings = get_settings()?;
    let dir = match settings.recording_path {
        Some(path) => path,
        None => get_default_record_path()?,
    };
    let name = recording
        .title
        .clone()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| channel.name.clone());
    let name = sanitize(name);
    let timestamp = Local::now().format("%Y%m%d-%H%M");
    let mut path = PathBuf::from(dir);
    path.push(format!("{name}-{timestamp}.ts"));
    Ok(path.to_string_lossy().to_string())
}

fn notify_started(app: &AppHandle, recording: &ScheduledRecording) {
    let title = recording.title.as_deref().unwrap_or("Scheduled program");
    let _ = app
        .notification()
        .builder()
        .title(format!("Recording started: {title}"))
        .show()
        .map_err(|e| log(format!("failed to show recording notification: {e:?}")));
}
