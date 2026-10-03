//! The tray icon (Windows and macOS): show the window, pause the player,
//! quit. Its texts follow the app language (see `native_strings`), its
//! tooltip names the channel that plays.

use std::sync::OnceLock;

use tauri::{
    AppHandle, Wry,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

use crate::native_strings::text;

const TRAY_ID: &str = "main";
const APP_NAME: &str = "streameoIPTV";

struct TrayItems {
    show: MenuItem<Wry>,
    pause: MenuItem<Wry>,
    quit: MenuItem<Wry>,
}

static ITEMS: OnceLock<TrayItems> = OnceLock::new();

pub fn build(app: &mut tauri::App) -> anyhow::Result<()> {
    let show = MenuItem::with_id(app, "show", text("tray_show", &[]), true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", text("tray_pause", &[]), false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", text("tray_quit", &[]), true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &pause, &separator, &quit])?;
    TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip(APP_NAME)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => crate::quit::request(app),
            "show" => crate::show_main_window(app),
            "pause" => crate::player::toggle_pause_sync(),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::show_main_window(tray.app_handle());
            }
        })
        .icon(app.default_window_icon().unwrap().clone())
        .build(app)?;
    let _ = ITEMS.set(TrayItems { show, pause, quit });
    Ok(())
}

/// Re-reads the menu texts after the frontend sent new translations.
pub fn update_texts() {
    if let Some(items) = ITEMS.get() {
        let _ = items.show.set_text(text("tray_show", &[]));
        let _ = items.pause.set_text(text("tray_pause", &[]));
        let _ = items.quit.set_text(text("tray_quit", &[]));
    }
}

/// Names the playing channel in the tooltip; `None` when nothing plays.
pub fn set_now_playing(app: &AppHandle, channel: Option<&str>) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tooltip(channel)));
    }
    if let Some(items) = ITEMS.get() {
        let _ = items.pause.set_enabled(channel.is_some());
    }
}

fn tooltip(channel: Option<&str>) -> String {
    match channel {
        Some(name) if !name.trim().is_empty() => format!("{APP_NAME} – {}", name.trim()),
        _ => APP_NAME.to_string(),
    }
}

#[cfg(test)]
mod test_tray {
    use super::*;

    #[test]
    fn test_tooltip_names_the_channel() {
        assert_eq!(tooltip(Some(" Das Erste ")), "streameoIPTV – Das Erste");
        assert_eq!(tooltip(Some("  ")), "streameoIPTV");
        assert_eq!(tooltip(None), "streameoIPTV");
    }
}
