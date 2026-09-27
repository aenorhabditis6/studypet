//! Focus mode, idle time, and macOS Shortcuts.
//!
//! "Locking" an app (WeChat by default) means hiding it whenever it comes to the front, so
//! its window just disappears again; that needs no special permission. Silencing *all*
//! notifications needs macOS Focus / Do Not Disturb, which apps can't switch directly — the
//! user makes two Shortcuts ("Set Focus" on / off) and we run them.

use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

struct Blocker {
    apps: Vec<String>,
    paused_until: Option<Instant>,
}

static BLOCKER: Mutex<Blocker> = Mutex::new(Blocker { apps: Vec::new(), paused_until: None });

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppRef {
    bundle_id: String,
    name: String,
}

/// Starts blocking these apps (bundle ids) and hides any that are open right now.
#[tauri::command]
pub async fn focus_block(apps: Vec<String>) {
    platform::hide_all(&apps);
    let mut b = BLOCKER.lock().unwrap();
    b.apps = apps;
    b.paused_until = None;
}

#[tauri::command]
pub async fn focus_unblock() {
    let mut b = BLOCKER.lock().unwrap();
    b.apps.clear();
    b.paused_until = None;
}

/// "Unlock for a few minutes": blocking resumes on its own afterwards.
#[tauri::command]
pub async fn focus_pause(minutes: u64) {
    BLOCKER.lock().unwrap().paused_until = Some(Instant::now() + Duration::from_secs(minutes.min(120) * 60));
}

/// Regular (Dock) apps that are running now, for choosing what focus mode locks.
#[tauri::command]
pub async fn running_apps() -> Vec<AppRef> {
    platform::running_apps()
}

/// Seconds since the last keyboard / mouse input — "is the user at the computer?".
#[tauri::command]
pub async fn idle_seconds() -> f64 {
    platform::idle_seconds()
}

/// Runs a user's shortcut from the Shortcuts app (used to switch Do Not Disturb on / off).
#[tauri::command]
pub async fn run_shortcut(name: String) -> Result<(), String> {
    platform::run_shortcut(name.trim())
}

/// Watches the frontmost app and hides blocked ones; tells the pet so it can explain.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_told: Option<Instant> = None;
        loop {
            std::thread::sleep(Duration::from_millis(600));
            let apps = {
                let b = BLOCKER.lock().unwrap();
                let paused = b.paused_until.is_some_and(|t| Instant::now() < t);
                if b.apps.is_empty() || paused {
                    continue;
                }
                b.apps.clone()
            };
            if let Some(name) = platform::hide_frontmost_if(&apps) {
                if last_told.is_none_or(|t| t.elapsed() > Duration::from_secs(4)) {
                    let _ = app.emit_to("pet", "focus-blocked", name);
                    last_told = Some(Instant::now());
                }
            }
        }
    });
}

#[cfg(target_os = "macos")]
mod platform {
    use super::AppRef;
    use objc2_app_kit::{NSApplicationActivationPolicy, NSRunningApplication, NSWorkspace};
    use objc2_foundation::NSString;

    pub fn hide_frontmost_if(blocked: &[String]) -> Option<String> {
        let front = NSWorkspace::sharedWorkspace().frontmostApplication()?;
        let id = front.bundleIdentifier()?.to_string();
        if !blocked.contains(&id) {
            return None;
        }
        front.hide();
        Some(front.localizedName().map(|n| n.to_string()).unwrap_or(id))
    }

    pub fn hide_all(blocked: &[String]) {
        for id in blocked {
            for app in NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(id)).iter() {
                app.hide();
            }
        }
    }

    pub fn running_apps() -> Vec<AppRef> {
        let me = NSRunningApplication::currentApplication().bundleIdentifier().map(|id| id.to_string());
        let mut apps: Vec<AppRef> = NSWorkspace::sharedWorkspace()
            .runningApplications()
            .iter()
            .filter(|a| a.activationPolicy() == NSApplicationActivationPolicy::Regular)
            .filter_map(|a| {
                Some(AppRef {
                    bundle_id: a.bundleIdentifier()?.to_string(),
                    name: a.localizedName()?.to_string(),
                })
            })
            .filter(|a| Some(&a.bundle_id) != me.as_ref())
            .collect();
        apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        apps.dedup_by(|a, b| a.bundle_id == b.bundle_id);
        apps
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    }

    pub fn idle_seconds() -> f64 {
        // kCGEventSourceStateHIDSystemState = 1, kCGAnyInputEventType = ~0
        unsafe { CGEventSourceSecondsSinceLastEventType(1, u32::MAX) }
    }

    pub fn run_shortcut(name: &str) -> Result<(), String> {
        if name.is_empty() {
            return Err("还没填快捷指令的名字".into());
        }
        let out = std::process::Command::new("/usr/bin/shortcuts")
            .args(["run", name])
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(format!("快捷指令「{name}」没运行成功{}", if why.is_empty() { String::new() } else { format!("：{why}") }))
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::AppRef;

    pub fn hide_frontmost_if(_: &[String]) -> Option<String> {
        None
    }
    pub fn hide_all(_: &[String]) {}
    pub fn running_apps() -> Vec<AppRef> {
        Vec::new()
    }
    pub fn idle_seconds() -> f64 {
        0.0
    }
    pub fn run_shortcut(_: &str) -> Result<(), String> {
        Err("目前只支持 macOS".into())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::platform;

    #[test]
    fn reads_idle_time_and_running_apps() {
        let idle = platform::idle_seconds();
        assert!(idle >= 0.0 && idle.is_finite(), "idle = {idle}");
        let apps = platform::running_apps();
        assert!(apps.iter().any(|a| a.bundle_id == "com.apple.finder"), "Finder is always running");
        println!("idle {idle:.1}s; {} regular apps running", apps.len());
    }

    #[test]
    fn hides_nothing_that_is_not_blocked() {
        assert_eq!(platform::hide_frontmost_if(&["com.example.not-running".into()]), None);
    }
}
