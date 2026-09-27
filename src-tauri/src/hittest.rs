//! Click-through for the transparent pet window.
//!
//! The pet window is larger than the pet (it has room for the speech bubble), and its
//! transparent parts must not swallow clicks meant for the apps underneath. While a
//! window ignores cursor events its webview can't see the mouse at all, so a background
//! thread watches the global cursor and enables events only while the cursor is over one
//! of the regions the page reported (the pet, its bubble, its badge). The same loop feeds
//! the cursor position to the page so the pet can look at it.

use serde::Deserialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// A rectangle in the pet window's CSS pixels.
#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl Rect {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x <= self.x + self.w && y >= self.y && y <= self.y + self.h
    }
}

static REGIONS: Mutex<Vec<Rect>> = Mutex::new(Vec::new());

/// How far outside the window (CSS px) the pet keeps following the cursor with its eyes.
const REACH: f64 = 420.0;

#[tauri::command]
pub async fn set_hit_regions(rects: Vec<Rect>) {
    *REGIONS.lock().unwrap() = rects;
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut interactive: Option<bool> = None;
        let mut last_sent: Option<(i32, i32)> = None;
        loop {
            let near = tick(&app, &mut interactive, &mut last_sent);
            std::thread::sleep(Duration::from_millis(if near { 33 } else { 150 }));
        }
    });
}

/// Returns whether the cursor is near the pet (so the caller can poll faster).
fn tick(app: &AppHandle, interactive: &mut Option<bool>, last_sent: &mut Option<(i32, i32)>) -> bool {
    let Some(win) = app.get_webview_window("pet") else {
        return false;
    };
    if !win.is_visible().unwrap_or(false) {
        *interactive = None;
        return false;
    }
    let (Ok(cursor), Ok(pos), Ok(size), Ok(scale)) = (
        app.cursor_position(),
        win.outer_position(),
        win.inner_size(),
        win.scale_factor(),
    ) else {
        return false;
    };
    let x = (cursor.x - pos.x as f64) / scale;
    let y = (cursor.y - pos.y as f64) / scale;

    // Never hold the lock across window calls: those round-trip through the main thread.
    let inside = REGIONS.lock().unwrap().iter().any(|r| r.contains(x, y));
    if *interactive != Some(inside) && win.set_ignore_cursor_events(!inside).is_ok() {
        #[cfg(debug_assertions)]
        println!(
            "[hittest] cursor ({x:.0}, {y:.0}) → {}",
            if inside { "over the pet: take mouse events" } else { "click-through" }
        );
        *interactive = Some(inside);
    }

    let (w, h) = (size.width as f64 / scale, size.height as f64 / scale);
    let near = x > -REACH && y > -REACH && x < w + REACH && y < h + REACH;
    if near {
        let p = (x.round() as i32, y.round() as i32);
        if *last_sent != Some(p) {
            let _ = app.emit_to("pet", "pet-cursor", (x, y));
            *last_sent = Some(p);
        }
    } else if last_sent.take().is_some() {
        let _ = app.emit_to("pet", "pet-cursor-away", ());
    }
    near
}
