//! Calendar subscriptions (.ics). A feed URL works like a password — anyone holding a
//! Canvas feed link can read that student's calendar — so URLs live in the OS keychain
//! and only this module ever reads them back. The page keeps the non-secret metadata.

use std::time::Duration;

const KEYCHAIN_SERVICE: &str = "com.studypet.app";
const MAX_FEED_BYTES: usize = 20 * 1024 * 1024;

/// A keychain item of this app (service `com.studypet.app`).
pub(crate) fn keychain_entry(user: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, user).map_err(|e| e.to_string())
}

fn entry(id: &str) -> Result<keyring::Entry, String> {
    keychain_entry(&format!("source:{id}"))
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

async fn fetch_ics(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .user_agent("StudyPet/0.1")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("连不上这个链接：{e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("服务器返回了 {status}，链接可能失效了"));
    }
    if resp.content_length().is_some_and(|n| n as usize > MAX_FEED_BYTES) {
        return Err("日历文件太大了".into());
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !text.contains("BEGIN:VCALENDAR") {
        return Err("这个链接返回的不是日历（.ics）内容".into());
    }
    Ok(text)
}

#[tauri::command]
pub async fn source_save(id: String, url: String) -> Result<(), String> {
    let url = normalize_url(&url)?;
    entry(&id)?.set_password(&url).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn source_delete(id: String) -> Result<(), String> {
    match entry(&id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn source_fetch(id: String) -> Result<String, String> {
    let url = entry(&id)?
        .get_password()
        .map_err(|e| format!("钥匙串里找不到这个日历链接：{e}"))?;
    fetch_ics(&url).await
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
