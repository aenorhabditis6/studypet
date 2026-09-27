//! The pet's right-click menu, built natively. A click comes back to the pet page as a
//! `pet-menu` event carrying the item's name.
//!
//! (A menu built from JavaScript loses its click handlers in this Tauri version: its items
//! are dropped once the menu is built, and dropping an item removes its handler.)

use serde::Deserialize;
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

const PREFIX: &str = "pet:";

/// What the menu should offer right now.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuState {
    /// "pomodoro", "break" or "focus" while one is running.
    session: Option<String>,
    /// Apps are locked (focus mode, or a pomodoro that locks them).
    locked: bool,
    /// In meeting mode, tucked into a screen edge.
    tucked: bool,
    /// Minutes in a pomodoro.
    focus_min: u32,
}

#[derive(Debug, PartialEq)]
enum Entry {
    Item(&'static str, String),
    Separator,
}

fn entries(s: &MenuState) -> Vec<Entry> {
    use Entry::{Item, Separator};
    let mut menu = vec![Item("today", "今天有什么".into()), Item("sync", "现在同步".into()), Separator];
    match s.session.as_deref() {
        None => menu.extend([
            Item("pomo", format!("开始番茄钟（{} 分钟）", s.focus_min)),
            Item("pomo2", format!("开始番茄钟（{} 分钟）", s.focus_min * 2)),
            Item("focus", "开启专注模式（锁住微信）".into()),
        ]),
        Some(kind) => {
            let stop = match kind {
                "focus" => "结束专注模式",
                "break" => "跳过休息",
                _ => "结束番茄钟",
            };
            menu.push(Item("stop", stop.into()));
            if s.locked {
                menu.push(Item("unlock", "解锁 5 分钟".into()));
            }
        }
    }
    menu.extend([Separator, Item("gradescope", "打开 Gradescope".into()), Item("ed", "打开 Ed".into()), Separator]);
    if s.tucked {
        menu.push(Item("untuck", "结束组会模式".into()));
    }
    menu.extend([
        Item("settings", "设置…".into()),
        Separator,
        Item("hide", "先藏起来（菜单栏图标里找我）".into()),
        Item("quit", "退出 StudyPet".into()),
    ]);
    menu
}

#[tauri::command]
pub fn show_pet_menu(window: WebviewWindow, state: MenuState) -> Result<(), String> {
    let app = window.app_handle();
    let items = entries(&state)
        .into_iter()
        .map(|entry| -> tauri::Result<Box<dyn IsMenuItem<_>>> {
            Ok(match entry {
                Entry::Item(id, text) => Box::new(MenuItem::with_id(app, format!("{PREFIX}{id}"), text, true, None::<&str>)?),
                Entry::Separator => Box::new(PredefinedMenuItem::separator(app)?),
            })
        })
        .collect::<tauri::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let refs: Vec<&dyn IsMenuItem<_>> = items.iter().map(|i| i.as_ref()).collect();
    let menu = Menu::with_items(app, &refs).map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

/// Sends clicks on the pet's menu to the pet page.
pub fn forward_clicks<R: Runtime>(app: &AppHandle<R>) {
    app.on_menu_event(|app, event| {
        if let Some(id) = event.id.as_ref().strip_prefix(PREFIX) {
            let _ = app.emit_to("pet", "pet-menu", id);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(state: MenuState) -> Vec<&'static str> {
        entries(&state)
            .into_iter()
            .filter_map(|e| match e {
                Entry::Item(id, _) => Some(id),
                Entry::Separator => None,
            })
            .collect()
    }

    #[test]
    fn offers_what_fits_the_moment() {
        let idle = MenuState { session: None, locked: false, tucked: false, focus_min: 25 };
        assert_eq!(ids(idle), ["today", "sync", "pomo", "pomo2", "focus", "gradescope", "ed", "settings", "hide", "quit"]);
        let focusing = MenuState { session: Some("focus".into()), locked: true, tucked: true, focus_min: 25 };
        let menu = entries(&focusing);
        assert!(menu.contains(&Entry::Item("stop", "结束专注模式".into())));
        assert_eq!(ids(focusing), ["today", "sync", "stop", "unlock", "gradescope", "ed", "untuck", "settings", "hide", "quit"]);
    }
}
