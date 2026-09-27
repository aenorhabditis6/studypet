mod focus;
mod hittest;
mod pet;
mod services;
mod sources;
mod vault;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WindowEvent,
};

/// Shows the panel window and (optionally) asks it to switch to a view:
/// "today" | "settings" | "onboarding".
pub(crate) fn open_panel(app: &AppHandle, view: Option<&str>) {
    if let Some(w) = app.get_webview_window("panel") {
        show_in_dock(app);
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        if let Some(v) = view {
            let _ = app.emit_to("panel", "panel-navigate", v);
        }
    }
}

/// While a regular window (panel, Gradescope, Ed) is open, show in the Dock and ⌘-Tab so it
/// can be found again — e.g. after switching to Finder to pick a PDF to submit.
pub(crate) fn show_in_dock(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Back to living only on the desktop once no regular window is left (`closing` is going away).
fn hide_from_dock_if_idle(app: &AppHandle, closing: &str) {
    #[cfg(target_os = "macos")]
    {
        let open = app
            .webview_windows()
            .into_iter()
            .any(|(label, w)| label != "pet" && label != closing && w.is_visible().unwrap_or(false));
        if !open {
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, closing);
}

fn toggle_pet(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("pet") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else if pet::has_pet(app) {
            let _ = w.show();
        } else {
            open_panel(app, Some("onboarding"));
        }
    }
}

#[tauri::command]
fn show_panel(app: AppHandle, view: Option<String>) {
    open_panel(&app, view.as_deref());
}

#[tauri::command]
fn set_pet_visible(app: AppHandle, visible: bool) {
    if let Some(w) = app.get_webview_window("pet") {
        let _ = if visible { w.show() } else { w.hide() };
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Lets the webviews write to the terminal running `tauri dev`, and to
/// `~/Library/Logs/com.studypet.app/studypet.log` so problems can be diagnosed later.
#[tauri::command]
fn log_line(app: AppHandle, window: tauri::Window, msg: String) {
    use std::io::Write;
    let line = format!("[{}] {}", window.label(), msg);
    println!("{line}");
    let Ok(dir) = app.path().app_log_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("studypet.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > 512 * 1024) {
        let _ = std::fs::remove_file(&path);
    }
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{secs} {line}");
    }
}

#[tauri::command]
fn hide_panel(app: AppHandle) {
    if let Some(w) = app.get_webview_window("panel") {
        let _ = w.hide();
    }
    hide_from_dock_if_idle(&app, "panel");
}

/// Debug builds only: an .ics URL to run the end-to-end self test against.
#[tauri::command]
fn selftest_ics_url() -> Option<String> {
    if cfg!(debug_assertions) {
        std::env::var("STUDYPET_SELFTEST_ICS").ok()
    } else {
        None
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            show_panel,
            set_pet_visible,
            quit_app,
            log_line,
            selftest_ics_url,
            hittest::set_hit_regions,
            pet::get_pet,
            pet::get_pet_image,
            pet::import_pet,
            pet::use_default_pet,
            pet::rename_pet,
            pet::set_pet_mode,
            pet::list_codex_pets,
            sources::source_save,
            sources::source_delete,
            sources::source_fetch,
            sources::source_find,
            services::gradescope_forget,
            sources::ics_fetch_url,
            services::open_service,
            services::gradescope_fetch,
            services::ed_connect,
            services::ed_disconnect,
            services::ed_user,
            services::ed_threads,
            hide_panel,
            focus::focus_block,
            focus::focus_unblock,
            focus::focus_pause,
            focus::running_apps,
            focus::idle_seconds,
            focus::run_shortcut,
        ])
        .setup(|app| {
            // A desktop pet lives in the tray, not the Dock.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let open_i = MenuItem::with_id(app, "open", "今天有什么", true, None::<&str>)?;
            let toggle_i = MenuItem::with_id(app, "toggle", "显示 / 隐藏宠物", true, None::<&str>)?;
            let settings_i = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "退出 StudyPet", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&open_i, &toggle_i, &settings_i, &sep, &quit_i])?;
            TrayIconBuilder::with_id("main")
                .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .tooltip("StudyPet")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => open_panel(app, Some("today")),
                    "settings" => open_panel(app, Some("settings")),
                    "toggle" => toggle_pet(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            hittest::start(app.handle().clone());
            focus::start(app.handle().clone());

            // First run: no pet yet, so start with onboarding in the panel.
            if !pet::has_pet(app.handle()) {
                open_panel(app.handle(), Some("onboarding"));
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Closing the panel only hides it; quitting goes through the tray / pet menu.
            WindowEvent::CloseRequested { api, .. } if window.label() == "panel" => {
                api.prevent_close();
                let _ = window.hide();
                hide_from_dock_if_idle(window.app_handle(), "panel");
            }
            WindowEvent::Destroyed if window.label().starts_with("web-") => {
                hide_from_dock_if_idle(window.app_handle(), window.label());
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
