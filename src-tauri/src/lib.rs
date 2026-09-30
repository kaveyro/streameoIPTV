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
pub mod diagnostics;
pub mod epg;
pub mod log;
pub mod logo_cache;
pub mod m3u;
pub mod media_type;
pub mod mpv;
pub mod parental;
pub mod player;
pub mod recording_scheduler;
pub mod recordings;
pub mod redact;
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
            get_recording_schedule,
            clear_finished_recordings,
            get_recording_files,
            delete_recording_file,
            get_recording_folder,
            open_recording_folder,
            has_parental_pin,
            verify_parental_pin,
            set_parental_pin,
            set_group_locked,
            get_locked_group_ids,
            check_source,
            player_init,
            player_play,
            player_stop,
            player_osd,
            player_osd_banner,
            player_restart,
            clear_watch_progress,
            player_set_bounds,
            player_set_visible,
            player_set_popout,
            player_destroy,
            get_xmltv_sources,
            set_xmltv_sources,
            refresh_xmltv,
            has_xmltv_data,
            detect_xtream_login,
            resolve_channel_url,
            get_favorite_lists,
            get_channel_by_number,
            create_favorite_list,
            rename_favorite_list,
            delete_favorite_list,
            add_to_favorite_list,
            remove_from_favorite_list,
            get_channel_favorite_lists,
            move_favorite,
            get_epg_alerts,
            add_epg_alert,
            delete_epg_alert,
            get_alternative_streams,
            open_log_folder,
            export_diagnostics,
            convert_source_to_xtream,
            search_xmltv_channels,
            get_epg_mapping,
            set_epg_mapping,
            get_xmltv_status,
            get_epg_coverage,
            search_programmes,
            get_countries,
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
            tauri::async_runtime::spawn_blocking(|| {
                credentials::migrate_passwords_to_keychain();
                // Then take the login out of the stored stream URLs.
                xtream::migrate_url_credentials();
            });
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            if *ENABLE_TRAY_ICON {
                let _ = build_tray_icon(app);
            }
            // Title the window with the version actually running. It used to be
            // a hardcoded string in tauri.conf.json, which silently kept
            // claiming an old version after every release.
            if let Some(window) = app.get_webview_window("main") {
                let _ =
                    window.set_title(&format!("streameoIPTV (v{})", app.package_info().version));
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
                // not float over the desktop while the app is in the tray. The
                // mini player is meant to float: it keeps playing.
                if !player::is_popped_out() {
                    player::set_visible_sync(false);
                }
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
            tauri::RunEvent::Exit => {
                player::kill_sync();
                restream::kill_sync();
            }
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
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                    player::set_visible_sync(true);
                }
            }
        })
        .icon(app.default_window_icon().unwrap().clone())
        .build(app)?;
    Ok(())
}

fn map_err_frontend(e: Error) -> String {
    redact::redact(&format!("{:?}", e))
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
async fn player_init(app: AppHandle, state: State<'_, Mutex<AppState>>) -> Result<(), String> {
    player::init(app, state).await.map_err(map_err_frontend)
}

#[tauri::command]
async fn player_play(
    app: AppHandle,
    channel: Channel,
    state: State<'_, Mutex<AppState>>,
) -> Result<Option<f64>, String> {
    player::play(app, channel, state)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn player_stop(state: State<'_, Mutex<AppState>>) -> Result<(), String> {
    player::stop(state).await.map_err(map_err_frontend)
}

#[tauri::command]
async fn player_osd_banner(
    state: State<'_, Mutex<AppState>>,
    banner: player::OsdBanner,
) -> Result<(), String> {
    player::show_banner(state, banner)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn player_restart(state: State<'_, Mutex<AppState>>) -> Result<(), String> {
    player::restart(state).await.map_err(map_err_frontend)
}

/// "Play from the start" / "mark as unwatched" for a movie or episode.
#[tauri::command]
fn clear_watch_progress(source_id: i64, url: String) -> Result<(), String> {
    sql::clear_watch_progress(source_id, &url).map_err(map_err_frontend)
}

#[tauri::command]
async fn player_osd(state: State<'_, Mutex<AppState>>, message: String) -> Result<(), String> {
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
async fn player_set_popout(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
    popout: bool,
    title: Option<String>,
) -> Result<(), String> {
    player::set_popout(app, state, popout, title)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn player_destroy(app: AppHandle, state: State<'_, Mutex<AppState>>) -> Result<(), String> {
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
    sql::do_tx(|tx| sql::create_or_find_source_by_name(tx, &sql::get_custom_source(name)))
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

#[tauri::command(async)]
fn get_xmltv_sources() -> Result<Vec<String>, String> {
    settings::get_xmltv_sources().map_err(map_err_frontend)
}

#[tauri::command(async)]
fn set_xmltv_sources(urls: Vec<String>) -> Result<(), String> {
    settings::set_xmltv_sources(urls).map_err(map_err_frontend)
}

#[tauri::command(async)]
async fn refresh_xmltv() -> Result<(), String> {
    xmltv::refresh().await.map_err(map_err_frontend)
}

#[tauri::command(async)]
fn has_xmltv_data() -> Result<bool, String> {
    sql::has_xmltv_programmes().map_err(map_err_frontend)
}

#[tauri::command(async)]
fn get_favorite_lists(show_locked: Option<bool>) -> Result<Vec<types::FavoriteList>, String> {
    sql::get_favorite_lists(show_locked.unwrap_or(false)).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn get_channel_by_number(
    source_ids: Vec<i64>,
    number: i64,
    show_locked: bool,
) -> Result<Option<Channel>, String> {
    sql::get_channel_by_number(&source_ids, number, show_locked).map_err(map_err_frontend)
}

/// A list name as the user typed it; empty names are refused.
fn list_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("the list needs a name".to_string());
    }
    Ok(name.chars().take(80).collect())
}

#[tauri::command(async)]
fn create_favorite_list(name: String) -> Result<i64, String> {
    sql::create_favorite_list(&list_name(&name)?).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn rename_favorite_list(id: i64, name: String) -> Result<(), String> {
    sql::rename_favorite_list(id, &list_name(&name)?).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn delete_favorite_list(id: i64) -> Result<(), String> {
    sql::delete_favorite_list(id).map_err(map_err_frontend)
}

fn channel_key(channel: &Channel) -> Result<(i64, String), String> {
    let source_id = channel
        .source_id
        .ok_or_else(|| "channel has no source".to_string())?;
    Ok((source_id, channel.name.clone()))
}

#[tauri::command(async)]
fn add_to_favorite_list(list_id: i64, channel: Channel) -> Result<(), String> {
    let (source_id, name) = channel_key(&channel)?;
    sql::add_to_favorite_list(list_id, source_id, &name).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn remove_from_favorite_list(list_id: i64, channel: Channel) -> Result<(), String> {
    let (source_id, name) = channel_key(&channel)?;
    sql::remove_from_favorite_list(list_id, source_id, &name).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn get_channel_favorite_lists(channel: Channel) -> Result<Vec<i64>, String> {
    let (source_id, name) = channel_key(&channel)?;
    sql::get_channel_favorite_lists(source_id, &name).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn move_favorite(
    list_id: Option<i64>,
    channel_id: i64,
    before_id: Option<i64>,
) -> Result<(), String> {
    sql::move_favorite(list_id, channel_id, before_id).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn get_epg_alerts() -> Result<Vec<types::EpgAlert>, String> {
    sql::get_epg_alerts().map_err(map_err_frontend)
}

#[tauri::command]
async fn add_epg_alert(app: AppHandle, query: String, action: String) -> Result<i64, String> {
    let query = query.trim().to_string();
    if query.chars().count() < 2 {
        return Err("the search needs at least two characters".to_string());
    }
    if action != "remind" && action != "record" {
        return Err("unknown alert action".to_string());
    }
    let id = sql::add_epg_alert(&query, &action, chrono::Utc::now().timestamp())
        .map_err(map_err_frontend)?;
    // Apply it to the programmes already in the guide right away. The alert
    // is saved either way; a failure here is retried by the next run.
    if let Err(e) = epg::process_alerts(&app).await {
        log::log(format!("{:?}", e.context("applying a new guide alert")));
    }
    Ok(id)
}

#[tauri::command(async)]
fn delete_epg_alert(id: i64) -> Result<(), String> {
    sql::delete_epg_alert(id).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn get_alternative_streams(channel: Channel, show_locked: bool) -> Result<Vec<Channel>, String> {
    epg::alternatives(&channel, show_locked).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn open_log_folder() -> Result<(), String> {
    recordings::open_in_file_manager(&log::log_dir().to_string_lossy()).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn export_diagnostics(app: AppHandle, path: String) -> Result<(), String> {
    diagnostics::export(&app.package_info().version.to_string(), &path).map_err(map_err_frontend)
}

/// The playable URL of a channel, for "copy URL" (it carries the login).
#[tauri::command(async)]
fn resolve_channel_url(channel: Channel) -> Result<String, String> {
    xtream::stream_url(&channel).map_err(map_err_frontend)
}

#[tauri::command]
fn detect_xtream_login(url: String) -> Option<types::XtreamLogin> {
    xtream::login_from_m3u_url(&url)
}

#[tauri::command]
async fn convert_source_to_xtream(source_id: i64) -> Result<(), String> {
    xtream::convert_from_m3u(source_id)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command(async)]
fn search_xmltv_channels(query: String) -> Result<Vec<types::XmltvChannelHit>, String> {
    xmltv::search_channels(&query).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn get_epg_mapping(channel: Channel) -> Result<Option<String>, String> {
    let Some(source_id) = channel.source_id else {
        return Ok(None);
    };
    sql::get_epg_mapping(source_id, &channel.name).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn set_epg_mapping(channel: Channel, xmltv_id: Option<String>) -> Result<(), String> {
    let source_id = channel
        .source_id
        .ok_or_else(|| "channel has no source".to_string())?;
    let xmltv_id = xmltv_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    sql::set_epg_mapping(source_id, &channel.name, xmltv_id.as_deref()).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn get_xmltv_status() -> Result<Vec<types::XmltvSourceStatus>, String> {
    xmltv::get_status().map_err(map_err_frontend)
}

#[tauri::command(async)]
fn get_epg_coverage() -> Result<types::EpgCoverage, String> {
    epg::coverage().map_err(map_err_frontend)
}

#[tauri::command(async)]
fn search_programmes(query: String, show_locked: bool) -> Result<Vec<types::ProgrammeHit>, String> {
    epg::search_programmes(&query, show_locked).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn get_countries(
    source_ids: Vec<i64>,
    show_locked: bool,
) -> Result<Vec<types::CountryCount>, String> {
    sql::get_names_for_countries(&source_ids, show_locked)
        .map(|names| xmltv::count_countries(&names))
        .map_err(map_err_frontend)
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

#[tauri::command(async)]
fn get_recording_schedule() -> Result<Vec<ScheduledRecording>, String> {
    sql::get_recording_schedule().map_err(map_err_frontend)
}

#[tauri::command(async)]
fn clear_finished_recordings() -> Result<(), String> {
    sql::clear_finished_recordings().map_err(map_err_frontend)
}

#[tauri::command(async)]
fn get_recording_files() -> Result<Vec<recordings::RecordingFile>, String> {
    recordings::list_files().map_err(map_err_frontend)
}

#[tauri::command(async)]
fn delete_recording_file(path: String) -> Result<(), String> {
    recordings::delete_file(&path).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn get_recording_folder() -> Result<String, String> {
    recordings::folder().map_err(map_err_frontend)
}

#[tauri::command(async)]
fn open_recording_folder() -> Result<(), String> {
    recordings::open_folder().map_err(map_err_frontend)
}

#[tauri::command(async)]
fn has_parental_pin() -> Result<bool, String> {
    parental::has_pin().map_err(map_err_frontend)
}

#[tauri::command]
async fn verify_parental_pin(pin: String) -> Result<bool, String> {
    parental::verify(&pin).await.map_err(map_err_frontend)
}

#[tauri::command]
async fn set_parental_pin(
    current_pin: Option<String>,
    new_pin: Option<String>,
) -> Result<(), String> {
    parental::set_pin(current_pin, new_pin)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn set_group_locked(group_id: i64, locked: bool, pin: String) -> Result<(), String> {
    parental::set_group_locked(group_id, locked, pin)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command(async)]
fn get_locked_group_ids() -> Result<Vec<i64>, String> {
    sql::get_locked_group_ids().map_err(map_err_frontend)
}

/// Checks that a source can be reached and logged into, without importing.
#[tauri::command]
async fn check_source(source: Source) -> Result<(), String> {
    match source.source_type {
        source_type::XTREAM => xtream::check(source).await,
        source_type::M3U_LINK => m3u::check_link(source).await,
        _ => Ok(()),
    }
    .map_err(map_err_frontend)
}
