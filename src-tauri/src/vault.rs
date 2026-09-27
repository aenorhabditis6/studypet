//! The app's secrets — calendar links, the Ed token, the Gradescope login — kept together in
//! one keychain item.
//!
//! macOS asks before an app reads a keychain item it isn't on the list for, and an app without
//! an Apple Developer ID signature counts as a new app after every update. One item means one
//! "Always Allow" per update rather than one per calendar and token; keeping it in memory after
//! the first read means no prompts in between.

use std::collections::BTreeMap;
use std::sync::Mutex;

const SERVICE: &str = "com.studypet.app";
const ITEM: &str = "vault";

/// The secrets, once read this run.
static CACHE: Mutex<Option<BTreeMap<String, String>>> = Mutex::new(None);

fn entry(user: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, user).map_err(|e| e.to_string())
}

fn refused(e: keyring::Error) -> String {
    format!("钥匙串没有让 StudyPet 读取（{e}）。再弹窗时选「始终允许」就好")
}

fn with<T>(f: impl FnOnce(&mut BTreeMap<String, String>) -> Result<T, String>) -> Result<T, String> {
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if cache.is_none() {
        let map = match entry(ITEM)?.get_password() {
            Ok(json) => serde_json::from_str(&json).map_err(|e| format!("钥匙串里的数据读不懂：{e}"))?,
            Err(keyring::Error::NoEntry) => BTreeMap::new(),
            Err(e) => return Err(refused(e)),
        };
        *cache = Some(map);
    }
    f(cache.as_mut().expect("loaded above"))
}

fn save(map: &BTreeMap<String, String>) -> Result<(), String> {
    let json = serde_json::to_string(map).map_err(|e| e.to_string())?;
    entry(ITEM)?.set_password(&json).map_err(refused)
}

pub fn get(key: &str) -> Result<Option<String>, String> {
    with(|map| {
        if let Some(value) = map.get(key) {
            return Ok(Some(value.clone()));
        }
        // Up to 0.2.0 every secret was a keychain item of its own: move it in, once.
        match entry(key)?.get_password() {
            Ok(value) => {
                map.insert(key.to_string(), value.clone());
                save(map)?;
                let _ = entry(key)?.delete_credential();
                Ok(Some(value))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(refused(e)),
        }
    })
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    with(|map| {
        if map.get(key).map(String::as_str) == Some(value) {
            return Ok(());
        }
        map.insert(key.to_string(), value.to_string());
        save(map)
    })
}

pub fn delete(key: &str) -> Result<(), String> {
    with(|map| {
        if map.remove(key).is_some() {
            save(map)?;
        }
        match entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(refused(e)),
        }
    })
}
