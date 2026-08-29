use std::collections::HashMap;

#[cfg(any(target_os = "macos", target_os = "windows"))]
use anyhow::Context;
use anyhow::Error;

use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;
use types::{
    AppState, Channel, CustomChannel, CustomChannelExtraData, EPG, EPGNotify, Filters, Group,
    IdName, NetworkInfo, ScheduledRecording, Settings, Source,
};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use {
    std::sync::LazyLock,
    tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    },
};

pub mod auto_refresh;
pub mod bulk_action_type;
pub mod credentials;
pub mod epg;
pub mod log;
pub mod logo_cache;
pub mod m3u;
pub mod media_type;
pub mod mpv;
pub mod player;
pub mod recording_scheduler;
pub mod restream;
pub mod settings;
pub mod share;
pub mod sort_type;
pub mod source_type;
pub mod sql;
pub mod types;
pub mod utils;
pub mod view_type;
pub mod xmltv;
pub mod xtream;

#[cfg(any(target_os = "macos", target_os = "windows"))]
static ENABLE_TRAY_ICON: LazyLock<bool> = LazyLock::new(|| {
    settings::get_settings()
        .and_then(|s| s.enable_tray_icon.context("no value"))
        .unwrap_or(true)
});

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let window = app.get_webview_window("main").expect("no main window");
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            player::set_visible_sync(true);
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_m3u8,
            get_m3u8_from_link,
            play,
            get_settings,
            update_settings,
            search,
            bulk_update,
            get_xtream,
            refresh_source,
            get_episodes,
            favorite_channel,
            unfavorite_channel,
            source_name_exists,
            get_sources,
            delete_source,
            refresh_all,
            get_enabled_sources,
            toggle_source,
            delete_database,
            add_custom_channel,
            get_custom_channel_extra_data,
            edit_custom_channel,
            delete_custom_channel,
            add_custom_source,
            share_custom_channel,
            group_auto_complete,
            edit_custom_channel,
            edit_custom_group,
            add_custom_group,
            delete_custom_group,
            group_not_empty,
            group_exists,
            share_custom_group,
            share_custom_source,
            import,
            channel_exists,
            update_source,
            get_epg,
            download,
            add_epg,
            remove_epg,
            get_epg_ids,
            on_start_check_epg,
            start_restream,
            stop_restream,
            watch_self,
            get_network_info,
            share_restream,
            add_last_watched,
            backup_favs,
            restore_favs,
            abort_download,
            clear_history,
            is_container,
            cancel_play,
            hide_channel,
            hide_group,
            remove_from_history,
            get_all_expiries,
            export_favorites_m3u,
            backup_database,
            restore_database,
            schedule_recording,
            cancel_scheduled_recording,
            get_scheduled_recordings,
            player_init,
            player_play,
            player_stop,
            player_osd,
            player_set_bounds,
            player_set_visible,
            player_destroy,
            get_xmltv_sources,
            set_xmltv_sources,
            refresh_xmltv,
            logo_cache::get_cached_logo
        ])
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            app.manage(Mutex::new(AppState {
                ..Default::default()
            }));
            recording_scheduler::start(app.handle().clone());
            auto_refresh::start(app.handle().clone());
            // Move any plaintext source passwords into the OS keychain.
            // Best-effort and off the main thread; on failure passwords
            // simply stay in the database as before.
            tauri::async_runtime::spawn_blocking(credentials::migrate_passwords_to_keychain);
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            if *ENABLE_TRAY_ICON {
                let _ = build_tray_icon(app);
            }
            // Title the window with the version actually running. It used to be
            // a hardcoded string in tauri.conf.json, which silently kept
            // claiming an old version after every release.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title(&format!(
                    "streameoIPTV (v{})",
                    app.package_info().version
                ));
            }
            Ok(())
        })
        .on_window_event(|_window, event| match event {
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if !*ENABLE_TRAY_ICON {
                    return;
                }

                // Hide the native player window too, so the embedded video does
                // not float over the desktop while the app is in the tray.
                player::set_visible_sync(false);
                _window.hide().unwrap();
                api.prevent_close();
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| match event {
            // Managed state is not dropped when the process ends, so the
            // embedded mpv would outlive the app, keep a provider connection
            // open and hold on to its IPC pipe.
            tauri::RunEvent::Exit => player::kill_sync(),
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                if !*ENABLE_TRAY_ICON {
                    return;
                }
                let window = _app.get_webview_window("main").expect("no main window");
                let _ = window.show();
                let _ = window.set_focus();
            }
            _ => {}
        });
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn build_tray_icon(app: &mut tauri::App) -> anyhow::Result<()> {
    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let show_i = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_i, &quit_i])?;
    TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => {
                app.exit(0);
            }
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                    player::set_visible_sync(true);
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                    player::set_visible_sync(true);
                }
            }
            _ => {}
        })
        .icon(app.default_window_icon().unwrap().clone())
        .build(app)?;
    Ok(())
}

fn map_err_frontend(e: Error) -> String {
    return format!("{:?}", e);
}

#[tauri::command(async)]
fn get_m3u8(source: Source) -> Result<(), String> {
    m3u::read_m3u8(source, false).map_err(map_err_frontend)
}

#[tauri::command]
async fn get_m3u8_from_link(source: Source) -> Result<(), String> {
    m3u::get_m3u8_from_link(source, false)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn play(
    channel: Channel,
    record: bool,
    record_path: Option<String>,
    state: State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    mpv::play(channel, record, record_path, state)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn player_init(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    player::init(app, state).await.map_err(map_err_frontend)
}

#[tauri::command]
async fn player_play(
    app: AppHandle,
    channel: Channel,
    state: State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    player::play(app, channel, state)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn player_stop(state: State<'_, Mutex<AppState>>) -> Result<(), String> {
    player::stop(state).await.map_err(map_err_frontend)
}

#[tauri::command]
async fn player_osd(
    state: State<'_, Mutex<AppState>>,
    message: String,
) -> Result<(), String> {
    player::show_message(state, message)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn player_set_bounds(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<(), String> {
    player::set_bounds(app, state, x, y, w, h)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn player_set_visible(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
    visible: bool,
) -> Result<(), String> {
    player::set_visible(app, state, visible)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn player_destroy(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    player::destroy(app, state).await.map_err(map_err_frontend)
}

#[tauri::command(async)]
fn get_settings() -> Result<Settings, String> {
    settings::get_settings().map_err(map_err_frontend)
}

#[tauri::command(async)]
fn update_settings(settings: Settings) -> Result<(), String> {
    settings::update_settings(settings).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn search(filters: Filters) -> Result<Vec<Channel>, String> {
    sql::search(filters).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn bulk_update(filters: Filters, action: u8) -> Result<(), String> {
    sql::bulk_update(filters, action).map_err(map_err_frontend)
}

#[tauri::command]
async fn get_xtream(source: Source) -> Result<(), String> {
    xtream::get_xtream(source, false)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn refresh_source(source: Source) -> Result<(), String> {
    utils::refresh_source(source)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn refresh_all() -> Result<(), String> {
    utils::refresh_all().await.map_err(map_err_frontend)
}

#[tauri::command]
async fn get_episodes(channel: Channel) -> Result<(), String> {
    xtream::get_episodes(channel)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command(async)]
fn favorite_channel(channel_id: i64) -> Result<(), String> {
    sql::favorite_channel(channel_id, true).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn unfavorite_channel(channel_id: i64) -> Result<(), String> {
    sql::favorite_channel(channel_id, false).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn hide_channel(id: i64, hidden: bool) -> Result<(), String> {
    sql::hide_channel(id, hidden).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn hide_group(id: i64, hidden: bool) -> Result<(), String> {
    sql::hide_group(id, hidden).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn remove_from_history(id: i64) -> Result<(), String> {
    sql::remove_last_watched(id).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn source_name_exists(name: String) -> Result<bool, String> {
    sql::source_name_exists(&name).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn get_sources() -> Result<Vec<Source>, String> {
    sql::get_sources().map_err(map_err_frontend)
}

#[tauri::command(async)]
fn get_enabled_sources() -> Result<Vec<Source>, String> {
    sql::get_enabled_sources().map_err(map_err_frontend)
}

#[tauri::command(async)]
fn delete_source(id: i64) -> Result<(), String> {
    sql::delete_source(id).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn toggle_source(value: bool, source_id: i64) -> Result<(), String> {
    sql::set_source_enabled(value, source_id).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn delete_database() -> Result<(), String> {
    utils::create_nuke_request().map_err(map_err_frontend)
}

#[tauri::command(async)]
fn backup_database(path: String) -> Result<(), String> {
    sql::backup_database(path).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn restore_database(path: String) -> Result<(), String> {
    sql::restore_database(path).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn add_custom_channel(channel: CustomChannel) -> Result<(), String> {
    sql::do_tx(|tx| sql::add_custom_channel(tx, channel)).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn edit_custom_channel(channel: CustomChannel) -> Result<(), String> {
    sql::edit_custom_channel(channel).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn delete_custom_channel(id: i64) -> Result<(), String> {
    sql::delete_custom_channel(id).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn get_custom_channel_extra_data(
    id: i64,
    group_id: Option<i64>,
) -> Result<CustomChannelExtraData, String> {
    sql::get_custom_channel_extra_data(id, group_id).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn add_custom_source(name: String) -> Result<(), String> {
    sql::do_tx(|tx| sql::create_or_find_source_by_name(tx, &mut sql::get_custom_source(name)))
        .map_err(map_err_frontend)?;
    Ok(())
}

#[tauri::command(async)]
fn share_custom_channel(channel: Channel, path: String) -> Result<(), String> {
    share::share_custom_channel(channel, path).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn group_auto_complete(query: Option<String>, source_id: i64) -> Result<Vec<IdName>, String> {
    sql::group_auto_complete(query, source_id).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn edit_custom_group(group: Group) -> Result<(), String> {
    sql::edit_custom_group(group).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn add_custom_group(group: Group) -> Result<(), String> {
    sql::do_tx(|tx| {
        sql::add_custom_group(tx, group)?;
        Ok(())
    })
    .map_err(map_err_frontend)
}

#[tauri::command(async)]
fn delete_custom_group(
    id: i64,
    new_id: Option<i64>,
    do_channels_update: bool,
) -> Result<(), String> {
    sql::delete_custom_group(id, new_id, do_channels_update).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn group_not_empty(id: i64) -> Result<bool, String> {
    sql::group_not_empty(id).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn group_exists(name: String, source_id: i64) -> Result<bool, String> {
    sql::group_exists(&name, source_id).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn share_custom_group(group: Channel, path: String) -> Result<(), String> {
    share::share_custom_group(group, path).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn share_custom_source(source: Source, path: String) -> Result<(), String> {
    share::share_custom_source(source, path).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn import(
    path: String,
    source_id: Option<i64>,
    name_override: Option<String>,
) -> Result<(), String> {
    share::import(path, source_id, name_override).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn channel_exists(name: String, url: String, source_id: i64) -> Result<bool, String> {
    sql::channel_exists(&name, &url, source_id).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn update_source(source: Source) -> Result<(), String> {
    sql::update_source(source).map_err(map_err_frontend)
}

#[tauri::command]
async fn get_epg(channel: Channel) -> Result<Vec<EPG>, String> {
    epg::get_epg_combined(channel)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
fn get_xmltv_sources() -> Result<Vec<String>, String> {
    settings::get_xmltv_sources().map_err(map_err_frontend)
}

#[tauri::command]
fn set_xmltv_sources(urls: Vec<String>) -> Result<(), String> {
    settings::set_xmltv_sources(urls).map_err(map_err_frontend)
}

#[tauri::command(async)]
async fn refresh_xmltv() -> Result<(), String> {
    xmltv::refresh().await.map_err(map_err_frontend)
}

#[tauri::command]
async fn download(
    state: State<'_, Mutex<AppState>>,
    app: AppHandle,
    channel: Channel,
    download_id: String,
    path: Option<String>,
) -> Result<(), String> {
    utils::download(state.clone(), app, channel, &download_id, path)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn abort_download(
    state: State<'_, Mutex<AppState>>,
    source_id: i64,
    download_id: String,
) -> Result<(), String> {
    mpv::cancel_play(source_id, download_id, state)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn add_epg(
    state: State<'_, Mutex<AppState>>,
    app: AppHandle,
    epg: EPGNotify,
) -> Result<(), String> {
    epg::add_epg(state, app, epg)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command(async)]
async fn remove_epg(
    state: State<'_, Mutex<AppState>>,
    app: AppHandle,
    epg_id: String,
) -> Result<(), String> {
    epg::remove_epg(state, app, epg_id)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command(async)]
fn get_epg_ids() -> Result<Vec<String>, String> {
    sql::get_epg_ids().map_err(map_err_frontend)
}

#[tauri::command]
async fn on_start_check_epg(
    state: State<'_, Mutex<AppState>>,
    app: AppHandle,
) -> Result<(), String> {
    epg::on_start_check_epg(state, app)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn start_restream(
    port: u16,
    state: State<'_, Mutex<AppState>>,
    app: AppHandle,
    channel: Channel,
) -> Result<(), String> {
    crate::restream::start_restream(port, state, app, channel)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn stop_restream(state: State<'_, Mutex<AppState>>) -> Result<(), String> {
    crate::restream::stop_restream(state)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn watch_self(port: u16, state: State<'_, Mutex<AppState>>) -> Result<(), String> {
    restream::watch_self(port, state)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn get_network_info() -> Result<NetworkInfo, String> {
    restream::get_network_info().await.map_err(map_err_frontend)
}

#[tauri::command(async)]
fn share_restream(address: String, channel: Channel, path: String) -> Result<(), String> {
    restream::share_restream(address, channel, path).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn add_last_watched(id: i64) -> Result<(), String> {
    sql::add_last_watched(id).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn backup_favs(id: i64, path: String) -> Result<(), String> {
    utils::backup_favs(id, path).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn restore_favs(id: i64, path: String) -> Result<(), String> {
    utils::restore_favs(id, path).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn clear_history() -> Result<(), String> {
    sql::clear_history().map_err(map_err_frontend)
}

#[tauri::command(async)]
fn is_container() -> bool {
    utils::is_container()
}

#[tauri::command]
async fn cancel_play(
    source_id: i64,
    channel_id: i64,
    state: State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    mpv::cancel_play(source_id, channel_id.to_string(), state)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn get_all_expiries() -> Result<HashMap<i64, i64>, String> {
    xtream::get_all_expiries().await.map_err(map_err_frontend)
}

#[tauri::command(async)]
fn export_favorites_m3u(path: String) -> Result<(), String> {
    m3u::export_favorites(path).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn schedule_recording(
    channel_id: i64,
    title: Option<String>,
    start_timestamp: i64,
    end_timestamp: i64,
) -> Result<(), String> {
    recording_scheduler::schedule(channel_id, title, start_timestamp, end_timestamp)
        .map_err(map_err_frontend)
}

#[tauri::command(async)]
fn cancel_scheduled_recording(id: i64) -> Result<(), String> {
    recording_scheduler::cancel(id).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn get_scheduled_recordings() -> Result<Vec<ScheduledRecording>, String> {
    sql::get_scheduled_recordings().map_err(map_err_frontend)
}
