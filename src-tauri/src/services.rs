//! Gradescope and Ed.
//!
//! Both open in built-in windows so submitting or reading a thread is one click from the pet.
//!
//! Gradescope has no student API. The user logs in once inside our Gradescope window (school
//! SSO works there); the session lives in the app's WebKit cookie store, and Rust reuses it
//! to read the user's own dashboard and course pages. Pages go to the frontend as HTML to
//! parse; the cookies never leave Rust.
//!
//! Ed has a (beta) API with personal tokens (edstem.org/us/settings/api-tokens). The token
//! lives in the keychain, like calendar links.

use std::time::Duration;

use serde::Serialize;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

const GRADESCOPE: &str = "https://www.gradescope.com";
const ED_API: &str = "https://us.edstem.org/api";
const ED_KEYCHAIN_USER: &str = "ed-token";
const USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) StudyPet/0.1";
const MAX_PAGE_BYTES: usize = 8 * 1024 * 1024;

struct Service {
    key: &'static str,
    title: &'static str,
    home: &'static str,
    hosts: &'static [&'static str],
}

fn service(name: &str) -> Result<Service, String> {
    match name {
        "gradescope" => Ok(Service {
            key: "gradescope",
            title: "Gradescope",
            home: "https://www.gradescope.com/",
            hosts: &["www.gradescope.com", "gradescope.com"],
        }),
        "ed" => Ok(Service {
            key: "ed",
            title: "Ed",
            home: "https://edstem.org/us/dashboard",
            hosts: &["edstem.org", "us.edstem.org"],
        }),
        _ => Err(format!("unknown service: {name}")),
    }
}

/// Only https links to the service itself may be opened in its window.
fn target_url(svc: &Service, url: Option<&str>) -> Result<Url, String> {
    let Some(url) = url else {
        return Ok(Url::parse(svc.home).expect("valid home URL"));
    };
    let parsed = Url::parse(url).map_err(|_| "链接格式不对".to_string())?;
    let host_ok = parsed.host_str().is_some_and(|h| svc.hosts.contains(&h));
    if parsed.scheme() == "https" && host_ok {
        Ok(parsed)
    } else {
        Err(format!("这个链接不是 {} 的", svc.title))
    }
}

/// Opens (or focuses) the built-in window for a service, optionally at a specific page.
#[tauri::command]
pub async fn open_service(app: AppHandle, name: String, url: Option<String>) -> Result<(), String> {
    let svc = service(&name)?;
    let target = target_url(&svc, url.as_deref())?;
    let label = format!("web-{}", svc.key);
    if let Some(w) = app.get_webview_window(&label) {
        w.navigate(target).map_err(|e| e.to_string())?;
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    } else {
        let key = svc.key;
        let opener = app.clone();
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(target))
            .title(format!("{} · StudyPet", svc.title))
            .inner_size(1120.0, 820.0)
            .min_inner_size(640.0, 480.0)
            .center()
            // Let the page receive dropped files (drag a PDF onto Gradescope's upload box).
            .disable_drag_drop_handler()
            // "Open in new tab" links go to the default browser.
            .on_new_window(move |url, _| {
                let _ = opener.opener().open_url(url.as_str(), None::<&str>);
                NewWindowResponse::Deny
            })
            // Lets the pet notice a fresh login or a new submission and re-sync.
            .on_page_load(move |window, payload| {
                if payload.event() == PageLoadEvent::Finished {
                    let _ = window.app_handle().emit("service-page", (key, payload.url().as_str()));
                }
            })
            .build()
            .map_err(|e| e.to_string())?;
    }
    crate::show_in_dock(&app);
    Ok(())
}

#[derive(Serialize)]
pub struct Page {
    url: String,
    status: u16,
    html: String,
}

/// GETs a Gradescope page with the session from the built-in window.
#[tauri::command]
pub async fn gradescope_fetch(app: AppHandle, path: String) -> Result<Page, String> {
    if !path.starts_with('/') || path.starts_with("//") || path.contains("..") || path.contains('\\') {
        return Err("bad path".into());
    }
    let url = Url::parse(&format!("{GRADESCOPE}{path}")).map_err(|e| e.to_string())?;
    let cookie = session_cookie(&app, &url)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(url).header(reqwest::header::ACCEPT, "text/html");
    if !cookie.is_empty() {
        req = req.header(reqwest::header::COOKIE, cookie);
    }
    let resp = req.send().await.map_err(|e| format!("连不上 Gradescope：{e}"))?;
    let final_url = resp.url().to_string();
    let status = resp.status().as_u16();
    let html = resp.text().await.map_err(|e| e.to_string())?;
    if html.len() > MAX_PAGE_BYTES {
        return Err("Gradescope 页面太大了".into());
    }
    Ok(Page { url: final_url, status, html })
}

/// Cookies for www.gradescope.com from the app's (shared) WebKit cookie store.
fn session_cookie(app: &AppHandle, url: &Url) -> Result<String, String> {
    let webview = app
        .get_webview_window("web-gradescope")
        .or_else(|| app.get_webview_window("pet"))
        .or_else(|| app.get_webview_window("panel"))
        .ok_or("no webview")?;
    let cookies = webview.cookies_for_url(url.clone()).map_err(|e| e.to_string())?;
    Ok(cookies
        .iter()
        .map(|c| format!("{}={}", c.name(), c.value()))
        .collect::<Vec<_>>()
        .join("; "))
}

/// Tests an Ed API token and stores it. Returns the `/user` response (name + courses).
#[tauri::command]
pub async fn ed_connect(token: String) -> Result<String, String> {
    let token = token.trim();
    if token.is_empty() || token.len() > 400 || token.chars().any(char::is_whitespace) {
        return Err("这看起来不像 Ed 的 API token".into());
    }
    let body = ed_get(token, "/user").await?;
    crate::sources::keychain_entry(ED_KEYCHAIN_USER)?
        .set_password(token)
        .map_err(|e| e.to_string())?;
    Ok(body)
}

#[tauri::command]
pub async fn ed_disconnect() -> Result<(), String> {
    match crate::sources::keychain_entry(ED_KEYCHAIN_USER)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn ed_user() -> Result<String, String> {
    ed_get(&ed_token()?, "/user").await
}

/// Newest threads of one course (announcements, questions, posts).
#[tauri::command]
pub async fn ed_threads(course_id: u64, limit: u32) -> Result<String, String> {
    let path = format!("/courses/{course_id}/threads?limit={}&sort=new", limit.clamp(1, 100));
    ed_get(&ed_token()?, &path).await
}

fn ed_token() -> Result<String, String> {
    crate::sources::keychain_entry(ED_KEYCHAIN_USER)?
        .get_password()
        .map_err(|_| "还没有连接 Ed".to_string())
}

async fn ed_get(token: &str, path: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(format!("{ED_API}{path}"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("连不上 Ed：{e}"))?;
    match resp.status().as_u16() {
        200..=299 => resp.text().await.map_err(|e| e.to_string()),
        401 | 403 => Err("Ed 不认这个 token（可能输错了或者过期了）".into()),
        s => Err(format!("Ed 返回了 {s}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_windows_only_open_their_own_site() {
        let gs = service("gradescope").unwrap();
        assert!(target_url(&gs, Some("https://www.gradescope.com/courses/1")).is_ok());
        assert!(target_url(&gs, None).is_ok());
        assert!(target_url(&gs, Some("http://www.gradescope.com/")).is_err());
        assert!(target_url(&gs, Some("https://www.gradescope.com.evil.com/")).is_err());
        assert!(target_url(&gs, Some("https://edstem.org/us/dashboard")).is_err());
        let ed = service("ed").unwrap();
        assert!(target_url(&ed, Some("https://edstem.org/us/courses/1/discussion/2")).is_ok());
        assert!(target_url(&ed, Some("https://example.com/")).is_err());
        assert!(service("canvas").is_err());
    }
}
