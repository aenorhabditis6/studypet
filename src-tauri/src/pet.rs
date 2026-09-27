//! The pet's look comes from the user: a Codex pet (pet.json + spritesheet atlas), a single
//! image, or the bundled default (Cloudbun). The active pet is copied into
//! `<app data>/pet/` so it keeps working if the original files move.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

const DEFAULT_SHEET: &[u8] = include_bytes!("../resources/pets/cloudbun/spritesheet.webp");
const DEFAULT_MANIFEST: &str = include_str!("../resources/pets/cloudbun/pet.json");
const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;
const IMAGE_EXTS: &[&str] = &["png", "webp", "gif", "jpg", "jpeg"];

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PetInfo {
    /// "codex-atlas": a Codex pet spritesheet (8 columns of 192x208 cells);
    /// "image": a single picture that the app animates itself.
    pub kind: String,
    pub name: String,
    pub description: Option<String>,
    pub image_file: String,
    pub mime: String,
    pub sprite_version: Option<u64>,
    /// "default" | "codex" | "upload"
    pub origin: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPetRef {
    pub id: String,
    pub name: String,
    pub path: String,
}

fn pet_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("pet"))
        .map_err(|e| e.to_string())
}

pub fn has_pet(app: &AppHandle) -> bool {
    pet_dir(app)
        .map(|d| d.join("manifest.json").is_file())
        .unwrap_or(false)
}

fn read_manifest(app: &AppHandle) -> Option<PetInfo> {
    let text = fs::read_to_string(pet_dir(app).ok()?.join("manifest.json")).ok()?;
    serde_json::from_str(&text).ok()
}

#[tauri::command]
pub fn get_pet(app: AppHandle) -> Option<PetInfo> {
    read_manifest(&app)
}

#[tauri::command]
pub fn get_pet_image(app: AppHandle) -> Result<tauri::ipc::Response, String> {
    let info = read_manifest(&app).ok_or("还没有设置宠物")?;
    let bytes = fs::read(pet_dir(&app)?.join(&info.image_file)).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Imports a Codex pet folder, a `pet.json`, or a single image file.
#[tauri::command]
pub fn import_pet(app: AppHandle, path: String, origin: Option<String>) -> Result<PetInfo, String> {
    let origin = origin.unwrap_or_else(|| "upload".into());
    let (info, image) = read_pet(Path::new(&path), &origin)?;
    let info = install(&pet_dir(&app)?, info, &image)?;
    let _ = app.emit("pet-changed", &info);
    Ok(info)
}

#[tauri::command]
pub fn use_default_pet(app: AppHandle) -> Result<PetInfo, String> {
    let json: Value = serde_json::from_str(DEFAULT_MANIFEST).map_err(|e| e.to_string())?;
    let info = PetInfo {
        kind: "codex-atlas".into(),
        name: str_field(&json, "displayName").unwrap_or_else(|| "Cloudbun".into()),
        description: str_field(&json, "description"),
        image_file: "sprite.webp".into(),
        mime: "image/webp".into(),
        sprite_version: json.get("spriteVersionNumber").and_then(Value::as_u64),
        origin: "default".into(),
    };
    let info = install(&pet_dir(&app)?, info, DEFAULT_SHEET)?;
    let _ = app.emit("pet-changed", &info);
    Ok(info)
}

/// Reads a Codex pet folder, a `pet.json`, or a single image file.
fn read_pet(path: &Path, origin: &str) -> Result<(PetInfo, Vec<u8>), String> {
    if path.is_dir() {
        let manifest = find_codex_manifest(path)
            .ok_or("这个文件夹里没有找到 pet.json（Codex 宠物格式）。也可以直接选一张图片。")?;
        read_codex(&manifest, origin)
    } else if path.file_name().is_some_and(|n| n == "pet.json") {
        read_codex(path, origin)
    } else if image_ext(path).is_some() {
        read_single_image(path)
    } else {
        Err("支持 Codex 宠物文件夹、pet.json，或者 PNG / WebP / GIF / JPG 图片".into())
    }
}

/// Pets installed for the Codex app (`~/.codex/pets/<id>/pet.json`), offered during onboarding.
#[tauri::command]
pub fn list_codex_pets(app: AppHandle) -> Vec<CodexPetRef> {
    let root = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| app.path().home_dir().ok().map(|h| h.join(".codex")));
    let Some(Ok(entries)) = root.map(|r| fs::read_dir(r.join("pets"))) else {
        return Vec::new();
    };
    let mut pets: Vec<CodexPetRef> = entries
        .flatten()
        .filter_map(|e| {
            let dir = e.path();
            let text = fs::read_to_string(dir.join("pet.json")).ok()?;
            let json: Value = serde_json::from_str(&text).ok()?;
            let id = e.file_name().to_string_lossy().into_owned();
            Some(CodexPetRef {
                name: str_field(&json, "displayName").unwrap_or_else(|| id.clone()),
                id,
                path: dir.to_string_lossy().into_owned(),
            })
        })
        .collect();
    pets.sort_by(|a, b| a.name.cmp(&b.name));
    pets
}

/// `dir/pet.json`, or one level down (so dropping a whole pet repo also works).
fn find_codex_manifest(dir: &Path) -> Option<PathBuf> {
    let direct = dir.join("pet.json");
    if direct.is_file() {
        return Some(direct);
    }
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path().join("pet.json"))
        .find(|p| p.is_file())
}

fn read_codex(manifest: &Path, origin: &str) -> Result<(PetInfo, Vec<u8>), String> {
    let text = fs::read_to_string(manifest).map_err(|e| format!("读不了 pet.json：{e}"))?;
    let json: Value = serde_json::from_str(&text).map_err(|e| format!("pet.json 格式不对：{e}"))?;
    let base = manifest.parent().unwrap_or(Path::new("."));
    let sheet_rel = str_field(&json, "spritesheetPath").unwrap_or_else(|| "spritesheet.webp".into());
    let sheet = base.join(&sheet_rel);
    let ext = image_ext(&sheet).ok_or(format!("精灵图 {sheet_rel} 不是支持的图片格式"))?;
    if !sheet.is_file() {
        return Err(format!("pet.json 旁边找不到精灵图 {sheet_rel}"));
    }
    let bytes = read_image(&sheet)?;
    let fallback_name = base
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "我的宠物".into());
    let info = PetInfo {
        kind: "codex-atlas".into(),
        name: str_field(&json, "displayName")
            .or_else(|| str_field(&json, "id"))
            .unwrap_or(fallback_name),
        description: str_field(&json, "description"),
        image_file: format!("sprite.{ext}"),
        mime: mime_for(&ext).into(),
        sprite_version: json.get("spriteVersionNumber").and_then(Value::as_u64),
        origin: origin.into(),
    };
    Ok((info, bytes))
}

fn read_single_image(path: &Path) -> Result<(PetInfo, Vec<u8>), String> {
    let ext = image_ext(path).ok_or("不支持的图片格式")?;
    let bytes = read_image(path)?;
    let info = PetInfo {
        kind: "image".into(),
        name: path
            .file_stem()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "我的宠物".into()),
        description: None,
        image_file: format!("image.{ext}"),
        mime: mime_for(&ext).into(),
        sprite_version: None,
        origin: "upload".into(),
    };
    Ok((info, bytes))
}

/// Writes the new pet next to the old one and swaps directories, so a failed import
/// never leaves the app without a pet.
fn install(dir: &Path, info: PetInfo, image: &[u8]) -> Result<PetInfo, String> {
    let staging = dir.with_file_name("pet.new");
    let io = |e: std::io::Error| e.to_string();
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(io)?;
    }
    fs::create_dir_all(&staging).map_err(io)?;
    fs::write(staging.join(&info.image_file), image).map_err(io)?;
    let manifest = serde_json::to_vec_pretty(&info).map_err(|e| e.to_string())?;
    fs::write(staging.join("manifest.json"), manifest).map_err(io)?;
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(io)?;
    }
    fs::rename(&staging, dir).map_err(io)?;
    Ok(info)
}

fn read_image(path: &Path) -> Result<Vec<u8>, String> {
    let len = fs::metadata(path).map_err(|e| e.to_string())?.len();
    if len > MAX_IMAGE_BYTES {
        return Err("图片太大了（超过 25MB）".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if !looks_like_image(&bytes) {
        return Err("这个文件打不开，看起来不是 PNG / WebP / GIF / JPG 图片".into());
    }
    Ok(bytes)
}

/// Checks the file signature, so a renamed file is caught at import time.
fn looks_like_image(b: &[u8]) -> bool {
    b.starts_with(b"\x89PNG\r\n\x1a\n")
        || b.starts_with(b"\xff\xd8\xff")
        || b.starts_with(b"GIF87a")
        || b.starts_with(b"GIF89a")
        || (b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP")
}

fn image_ext(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    IMAGE_EXTS.contains(&ext.as_str()).then_some(ext)
}

fn mime_for(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/jpeg",
    }
}

fn str_field(json: &Value, key: &str) -> Option<String> {
    json.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLOUDBUN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/resources/pets/cloudbun");

    /// A fresh scratch directory under the system temp dir.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("studypet-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_a_codex_pet_folder() {
        let (info, image) = read_pet(Path::new(CLOUDBUN), "upload").unwrap();
        assert_eq!(info.kind, "codex-atlas");
        assert_eq!(info.name, "Cloudbun");
        assert_eq!(info.sprite_version, Some(2));
        assert_eq!(info.image_file, "sprite.webp");
        assert_eq!(info.mime, "image/webp");
        assert_eq!(image.len(), DEFAULT_SHEET.len());
    }

    #[test]
    fn reads_pet_json_directly_and_repo_roots() {
        let (info, _) = read_pet(&Path::new(CLOUDBUN).join("pet.json"), "codex").unwrap();
        assert_eq!(info.origin, "codex");

        // A cloned pet repo: <root>/cloudbun/pet.json one level down.
        let root = scratch("repo");
        let nested = root.join("cloudbun");
        fs::create_dir_all(&nested).unwrap();
        for f in ["pet.json", "spritesheet.webp"] {
            fs::copy(Path::new(CLOUDBUN).join(f), nested.join(f)).unwrap();
        }
        fs::write(root.join("README.md"), "# pet").unwrap();
        assert_eq!(read_pet(&root, "upload").unwrap().0.name, "Cloudbun");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_a_single_image() {
        let dir = scratch("image");
        let png = dir.join("My Cat.PNG");
        fs::write(&png, b"\x89PNG\r\n\x1a\n not really").unwrap();
        let (info, image) = read_pet(&png, "upload").unwrap();
        assert_eq!(info.kind, "image");
        assert_eq!(info.name, "My Cat");
        assert_eq!(info.image_file, "image.png");
        assert_eq!(info.mime, "image/png");
        assert!(!image.is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn explains_what_went_wrong() {
        let dir = scratch("bad");
        assert!(read_pet(&dir, "upload").unwrap_err().contains("pet.json"));
        let txt = dir.join("notes.txt");
        fs::write(&txt, "hi").unwrap();
        assert!(read_pet(&txt, "upload").unwrap_err().contains("支持"));
        let renamed = dir.join("photo.png");
        fs::write(&renamed, "actually text").unwrap();
        assert!(read_pet(&renamed, "upload").unwrap_err().contains("不是"));
        fs::write(dir.join("pet.json"), r#"{"displayName":"Ghost","spritesheetPath":"missing.webp"}"#).unwrap();
        assert!(read_pet(&dir, "upload").unwrap_err().contains("missing.webp"));
        fs::write(dir.join("pet.json"), "{ not json").unwrap();
        assert!(read_pet(&dir, "upload").unwrap_err().contains("格式不对"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn install_replaces_the_previous_pet() {
        let data = scratch("install");
        let dir = data.join("pet");
        let (codex, sheet) = read_pet(Path::new(CLOUDBUN), "default").unwrap();
        install(&dir, codex, &sheet).unwrap();
        assert!(dir.join("sprite.webp").is_file());

        let png = data.join("cat.png");
        fs::write(&png, b"\x89PNG\r\n\x1a\npixels").unwrap();
        let (img, bytes) = read_pet(&png, "upload").unwrap();
        install(&dir, img, &bytes).unwrap();
        let manifest: PetInfo =
            serde_json::from_str(&fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest.kind, "image");
        assert!(dir.join("image.png").is_file());
        assert!(!dir.join("sprite.webp").exists(), "old pet files are gone");
        assert!(!data.join("pet.new").exists(), "staging dir cleaned up");
        fs::remove_dir_all(data).unwrap();
    }
}
