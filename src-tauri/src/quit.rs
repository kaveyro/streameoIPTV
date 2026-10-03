//! Quitting while recordings or downloads run: ask first, and stop them
//! cleanly on exit instead of leaving ffmpeg writing on its own.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::{log::log, native_strings::text, recording_scheduler, sql, utils};

/// Recordings starting within this time count as "due soon".
const UPCOMING_SECS: i64 = 6 * 3600;

/// The quit question is open: a second X click or tray "Quit" must not ask
/// again on top of it.
static ASKING: AtomicBool = AtomicBool::new(false);

/// Quits right away when nothing would be lost, otherwise asks first. The
/// database is read off the main thread, which the callers run on.
pub fn request(app: &AppHandle) {
    if ASKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let count = pending_work();
        if count == 0 {
            ASKING.store(false, Ordering::SeqCst);
            app.exit(0);
            return;
        }
        let mut dialog = app
            .dialog()
            .message(text("quit_body", &[("count", &count.to_string())]))
            .title(text("quit_title", &[]))
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                text("quit_confirm", &[]),
                text("quit_cancel", &[]),
            ));
        // Over the window when it is shown (not from the tray).
        if let Some(window) = app
            .get_webview_window("main")
            .filter(|w| w.is_visible().unwrap_or(false))
        {
            dialog = dialog.parent(&window);
        }
        let quit_app = app.clone();
        dialog.show(move |confirmed| {
            ASKING.store(false, Ordering::SeqCst);
            if confirmed {
                quit_app.exit(0);
            }
        });
    });
}

/// Leaves fullscreen before the window state is saved on exit: saved in
/// fullscreen, the next start would open a normal window as big as the
/// screen and the user's own size would be lost.
pub fn leave_fullscreen(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main")
        && window.is_fullscreen().unwrap_or(false)
    {
        let _ = window.set_fullscreen(false);
    }
}

/// Running recordings and downloads plus recordings due soon.
pub fn pending_work() -> usize {
    let now = chrono::Utc::now().timestamp();
    let upcoming = sql::count_upcoming_recordings(now, now + UPCOMING_SECS).unwrap_or_else(|e| {
        log(format!("{:?}", e.context("count upcoming recordings")));
        0
    });
    recording_scheduler::active_count() + utils::active_downloads() + upcoming
}

/// Runs on process exit: the recordings stop with the app.
pub fn on_exit() {
    recording_scheduler::stop_all_for_exit();
}
