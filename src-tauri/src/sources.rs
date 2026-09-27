//! Calendar subscriptions (.ics). A feed URL works like a password — anyone holding a
//! Canvas feed link can read that student's calendar — so URLs live in the keychain (see
//! `vault`) and only Rust ever reads them back. The page keeps the non-secret metadata.

use std::time::Duration;

use crate::vault;

const MAX_FEED_BYTES: usize = 20 * 1024 * 1024;

fn key(id: &str) -> String {
    format!("source:{id}")
}

/// Accepts https:// and webcal:// feeds (plain http only for local testing).
fn normalize_url(url: &str) -> Result<String, String> {
    let url = url.trim();
    let url = match url.strip_prefix("webcal://") {
        Some(rest) => format!("https://{rest}"),
        None => url.to_string(),
    };
    let parsed = reqwest::Url::parse(&url).map_err(|_| "这看起来不是一个完整的链接".to_string())?;
    let local = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1"));
    match parsed.scheme() {
        "https" => Ok(url),
        "http" if local => Ok(url),
        _ => Err("链接需要以 https:// 或 webcal:// 开头".into()),
    }
}

/// Why a feed couldn't be read, naming the site but never the link: it's secret, and the
/// message is shown in Settings. Network trouble starts with "暂时连不上" (the page retries soon).
fn fetch_error(url: &str, e: reqwest::Error) -> String {
    let host = reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| "日历服务器".into());
    if e.is_timeout() || e.is_connect() || e.is_request() {
        format!("暂时连不上 {host}（可能没联网），稍后会自动重试")
    } else {
        format!("读取 {host} 的日历出错了：{}", e.without_url())
    }
}

async fn fetch_ics(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .user_agent(concat!("StudyPet/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(|e| fetch_error(url, e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("服务器返回了 {status}，链接可能失效了"));
    }
    if resp.content_length().is_some_and(|n| n as usize > MAX_FEED_BYTES) {
        return Err("日历文件太大了".into());
    }
    let text = resp.text().await.map_err(|e| fetch_error(url, e))?;
    if !text.contains("BEGIN:VCALENDAR") {
        return Err("这个链接返回的不是日历（.ics）内容".into());
    }
    Ok(text)
}

#[tauri::command]
pub async fn source_save(id: String, url: String) -> Result<(), String> {
    let url = normalize_url(&url)?;
    vault::set(&key(&id), &url)
}

#[tauri::command]
pub async fn source_delete(id: String) -> Result<(), String> {
    vault::delete(&key(&id))
}

#[tauri::command]
pub async fn source_fetch(id: String) -> Result<String, String> {
    let url = vault::get(&key(&id))?.ok_or("钥匙串里找不到这个日历链接，删掉重新加一次吧")?;
    fetch_ics(&url).await
}

/// Which of these saved calendars (if any) already has this link, so the same one isn't added
/// twice. The links are compared here, the only place allowed to read them.
#[tauri::command]
pub async fn source_find(url: String, ids: Vec<String>) -> Result<Option<String>, String> {
    let url = normalize_url(&url)?;
    Ok(ids.into_iter().find(|id| vault::get(&key(id)).is_ok_and(|saved| saved.as_deref() == Some(url.as_str()))))
}

/// Used by onboarding to test a link before saving it.
#[tauri::command]
pub async fn ics_fetch_url(url: String) -> Result<String, String> {
    fetch_ics(&normalize_url(&url)?).await
}

#[cfg(test)]
mod tests {
    use super::normalize_url;

    #[test]
    fn accepts_calendar_links() {
        let canvas = "https://school.instructure.com/feeds/calendars/user_abc.ics";
        assert_eq!(normalize_url(&format!("  {canvas}\n")).unwrap(), canvas);
        assert_eq!(
            normalize_url("webcal://p01-caldav.icloud.com/published/2/abc").unwrap(),
            "https://p01-caldav.icloud.com/published/2/abc"
        );
        assert!(normalize_url("http://127.0.0.1:8765/canvas.ics").is_ok());
    }

    #[test]
    fn rejects_insecure_or_odd_links() {
        assert!(normalize_url("http://school.instructure.com/feeds/x.ics").is_err());
        assert!(normalize_url("http://localhost.evil.com/x.ics").is_err(), "not actually local");
        assert!(normalize_url("school.instructure.com/feeds/x.ics").is_err());
        assert!(normalize_url("ftp://example.com/x.ics").is_err());
        assert!(normalize_url("file:///etc/passwd").is_err());
        assert!(normalize_url("").is_err());
    }
}
