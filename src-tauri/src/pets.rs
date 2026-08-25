//! Codex-format pet overlay.
//!
//! Reads packages from `${CODEX_HOME:-~/.codex}/pets/<name>/` (the same layout
//! the Codex app uses), keeps overlay prefs in `~/.ztidalcode/pets.json`, and
//! owns the always-on-top companion window. The window is in-process — it is
//! not a second project window — so it is labelled `pet` and listed in the
//! default capability. See `branding` / ADR-0001: this module is fork-owned
//! and upstream will never touch it.

use crate::config::app_home;
use crate::fs_atomic;
use crate::multi_instance;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, Position, WebviewUrl, WebviewWindowBuilder,
};

pub const WINDOW_LABEL: &str = "pet";
const PREFS_EVENT: &str = "pet-prefs";
const SHEET_MAX_BYTES: u64 = 8 * 1024 * 1024;
const WINDOW_WIDTH: f64 = 216.0;
const WINDOW_HEIGHT: f64 = 280.0;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexPet {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub sprite_version: u32,
    /// Absolute path of the spritesheet on disk.
    pub spritesheet_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PetPrefs {
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_pet_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<i32>,
}

fn default_enabled() -> bool {
    false
}

impl Default for PetPrefs {
    fn default() -> Self {
        Self {
            enabled: false,
            selected_pet_id: None,
            x: None,
            y: None,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetPrefsPatch {
    pub enabled: Option<bool>,
    pub selected_pet_id: Option<String>,
    pub x: Option<i32>,
    pub y: Option<i32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetManifest {
    id: Option<String>,
    display_name: Option<String>,
    description: Option<String>,
    spritesheet_path: Option<String>,
    sprite_version_number: Option<u32>,
}

pub fn pets_home() -> PathBuf {
    if let Ok(home) = std::env::var("CODEX_HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home).join("pets");
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
        .join("pets")
}

fn prefs_path() -> PathBuf {
    app_home().join("pets.json")
}

/// Bundled defaults live under `src-tauri/resources/pets` and ship next to the
/// binary. Existing folders in `~/.codex/pets` are left alone.
pub fn copy_missing_pets(src: &Path, dest: &Path) -> u32 {
    let Ok(entries) = fs::read_dir(src) else {
        return 0;
    };
    let mut copied = 0;
    for entry in entries.flatten() {
        let from = entry.path();
        if !from.is_dir() {
            continue;
        }
        let Some(name) = from.file_name() else {
            continue;
        };
        let to = dest.join(name);
        if to.exists() {
            continue;
        }
        if copy_pet_dir(&from, &to).is_ok() {
            copied += 1;
        }
    }
    copied
}

fn copy_pet_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_file() {
            fs::copy(&path, to.join(entry.file_name()))?;
        }
    }
    Ok(())
}

pub fn seed_bundled_pets(app: &AppHandle) {
    let Ok(resource) = app.path().resource_dir() else {
        return;
    };
    let candidates = [
        resource.join("resources").join("pets"),
        resource.join("pets"),
    ];
    let Some(src) = candidates.iter().find(|p| p.is_dir()) else {
        return;
    };
    let dest = pets_home();
    let n = copy_missing_pets(src, &dest);
    if n > 0 {
        tracing::info!("seeded {n} bundled Codex pets into {}", dest.display());
    }
}

fn strip_bom(raw: &str) -> &str {
    raw.strip_prefix('\u{feff}').unwrap_or(raw)
}

/// True when `relative` is a single file name inside `dir` (no `..`, no abs).
fn resolve_sheet(dir: &Path, relative: &str) -> Option<PathBuf> {
    let relative = relative.trim();
    if relative.is_empty() {
        return None;
    }
    let path = Path::new(relative);
    if path.components().any(|c| {
        matches!(
            c,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir
        )
    }) {
        return None;
    }
    let joined = dir.join(path);
    joined.is_file().then_some(joined)
}

pub fn scan_pets_dir(dir: &Path) -> Vec<CodexPet> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };
    let mut pets = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(pet) = read_pet_package(&path) else {
            continue;
        };
        pets.push(pet);
    }
    pets.sort_by(|a, b| {
        a.display_name
            .to_lowercase()
            .cmp(&b.display_name.to_lowercase())
    });
    pets
}

fn read_pet_package(dir: &Path) -> Option<CodexPet> {
    let manifest_path = dir.join("pet.json");
    let raw = fs::read_to_string(&manifest_path).ok()?;
    let parsed: PetManifest = serde_json::from_str(strip_bom(&raw)).ok()?;
    let folder = dir.file_name()?.to_string_lossy().to_string();
    let id = parsed
        .id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or(folder);
    let sheet_rel = parsed
        .spritesheet_path
        .unwrap_or_else(|| "spritesheet.webp".into());
    let sheet = resolve_sheet(dir, &sheet_rel)?;
    let display_name = parsed
        .display_name
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| id.clone());
    Some(CodexPet {
        id,
        display_name,
        description: parsed.description.unwrap_or_default(),
        sprite_version: parsed.sprite_version_number.unwrap_or(1),
        spritesheet_path: sheet.display().to_string(),
    })
}

fn load_prefs_file(path: &Path) -> PetPrefs {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(strip_bom(&raw)).unwrap_or_default(),
        Err(_) => PetPrefs::default(),
    }
}

fn save_prefs_file(path: &Path, prefs: &PetPrefs) -> Result<(), String> {
    fs_atomic::write_json_atomic(path, prefs)
}

fn with_prefs_lock<T>(write: impl FnOnce(&mut PetPrefs) -> Result<T, String>) -> Result<T, String> {
    let path = prefs_path();
    let _lock = multi_instance::lock_sidecar(&path)?;
    let mut prefs = load_prefs_file(&path);
    let result = write(&mut prefs)?;
    save_prefs_file(&path, &prefs)?;
    Ok(result)
}

fn sheet_data_url(path: &Path) -> Result<String, String> {
    let size = fs::metadata(path)
        .map_err(|e| format!("stat {}: {e}", path.display()))?
        .len();
    if size == 0 || size > SHEET_MAX_BYTES {
        return Err(format!(
            "{} is not a usable spritesheet ({size} bytes)",
            path.display()
        ));
    }
    let bytes = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("webp")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        _ => "image/webp",
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

fn default_position(app: &AppHandle) -> Option<PhysicalPosition<i32>> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let origin = monitor.position();
    let size = monitor.size();
    let win_w = (WINDOW_WIDTH * scale).round() as i32;
    let win_h = (WINDOW_HEIGHT * scale).round() as i32;
    let margin = (24.0 * scale).round() as i32;
    Some(PhysicalPosition {
        x: origin.x + size.width as i32 - win_w - margin,
        y: origin.y + size.height as i32 - win_h - margin,
    })
}

fn hide_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.hide();
    }
}

/// OS close (Alt+F4, the overlay × if it still reaches the window) must not
/// destroy the webview. Tearing it down while it has in-flight IPC hangs the
/// main window on Windows.
fn attach_lifetime(app: &AppHandle, window: &tauri::WebviewWindow) {
    let handle = app.clone();
    window.on_window_event(move |event| {
        let tauri::WindowEvent::CloseRequested { api, .. } = event else {
            return;
        };
        api.prevent_close();
        let prefs = with_prefs_lock(|prefs| {
            prefs.enabled = false;
            Ok(prefs.clone())
        });
        hide_window(&handle);
        if let Ok(prefs) = prefs {
            let _ = handle.emit(PREFS_EVENT, &prefs);
        }
    });
}

fn create_window(app: &AppHandle, prefs: &PetPrefs) -> Result<(), String> {
    if app.get_webview_window(WINDOW_LABEL).is_some() {
        if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
            let _ = window.show();
            let _ = window.set_always_on_top(true);
        }
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(
        app,
        WINDOW_LABEL,
        WebviewUrl::App("index.html?overlay=pet".into()),
    )
    .title("ZtidalCode Pet")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .shadow(false)
    .focused(false)
    .disable_drag_drop_handler()
    .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
    .visible(true)
    .initialization_script("document.documentElement.classList.add('pet-overlay');")
    .build()
    .map_err(|e| format!("create pet overlay: {e}"))?;

    let pos = match (prefs.x, prefs.y) {
        (Some(x), Some(y)) => Some(PhysicalPosition { x, y }),
        _ => default_position(app),
    };
    if let Some(pos) = pos {
        let _ = window.set_position(Position::Physical(pos));
    }
    attach_lifetime(app, &window);
    Ok(())
}

/// Show or hide the overlay to match current prefs + installed pets.
///
/// The webview is kept alive for the process lifetime. Destroying it to "turn
/// the pet off" is what froze clicks in the main window.
pub fn sync_window(app: &AppHandle) -> Result<(), String> {
    seed_bundled_pets(app);
    let prefs = load_prefs_file(&prefs_path());
    let pets = scan_pets_dir(&pets_home());
    if !prefs.enabled || pets.is_empty() {
        hide_window(app);
        return Ok(());
    }
    create_window(app, &prefs)
}

#[tauri::command]
pub fn list_codex_pets(app: AppHandle) -> Vec<CodexPet> {
    seed_bundled_pets(&app);
    scan_pets_dir(&pets_home())
}

#[tauri::command]
pub async fn read_pet_spritesheet(id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pets = scan_pets_dir(&pets_home());
        let pet = pets
            .iter()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("no Codex pet named {id:?}"))?;
        sheet_data_url(Path::new(&pet.spritesheet_path))
    })
    .await
    .map_err(|e| format!("read pet spritesheet: {e}"))?
}

#[tauri::command]
pub fn get_pet_prefs() -> PetPrefs {
    load_prefs_file(&prefs_path())
}

#[tauri::command]
pub fn set_pet_prefs(app: AppHandle, patch: PetPrefsPatch) -> Result<PetPrefs, String> {
    let prefs = with_prefs_lock(|prefs| {
        if let Some(enabled) = patch.enabled {
            prefs.enabled = enabled;
        }
        if let Some(id) = patch.selected_pet_id {
            prefs.selected_pet_id = if id.is_empty() { None } else { Some(id) };
        }
        if let Some(x) = patch.x {
            prefs.x = Some(x);
        }
        if let Some(y) = patch.y {
            prefs.y = Some(y);
        }
        Ok(prefs.clone())
    })?;
    if let Err(error) = sync_window(&app) {
        tracing::warn!("pet overlay sync: {error}");
    }
    let _ = app.emit(PREFS_EVENT, &prefs);
    Ok(prefs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    fn temp_dir(name: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("ztidalcode_pets_{name}_{}_{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp pets dir");
        dir
    }

    fn write_pkg(root: &Path, folder: &str, json: &str, sheet: &str) {
        let dir = root.join(folder);
        fs::create_dir_all(&dir).expect("pkg dir");
        fs::write(dir.join("pet.json"), json).expect("manifest");
        fs::write(dir.join(sheet), b"not-an-image-but-present").expect("sheet");
    }

    #[test]
    fn scans_codex_packages_and_skips_broken_ones() {
        let root = temp_dir("scan");
        write_pkg(
            &root,
            "sadako",
            r#"{ "id": "sadako", "displayName": "贞子", "spritesheetPath": "spritesheet.webp", "spriteVersionNumber": 2 }"#,
            "spritesheet.webp",
        );
        write_pkg(
            &root,
            "daodun",
            "\u{feff}{ \"id\": \"daodun\", \"displayName\": \"刀盾狗\", \"spritesheetPath\": \"spritesheet-r2.webp\", \"spriteVersionNumber\": 2 }",
            "spritesheet-r2.webp",
        );
        // Missing sheet.
        fs::create_dir_all(root.join("empty")).unwrap();
        fs::write(
            root.join("empty/pet.json"),
            r#"{ "id": "empty", "displayName": "Empty", "spritesheetPath": "spritesheet.webp" }"#,
        )
        .unwrap();
        // Path escape is refused.
        fs::create_dir_all(root.join("evil")).unwrap();
        fs::write(
            root.join("evil/pet.json"),
            r#"{ "id": "evil", "displayName": "Evil", "spritesheetPath": "../sadako/spritesheet.webp" }"#,
        )
        .unwrap();

        let pets = scan_pets_dir(&root);
        let ids: Vec<_> = pets.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["daodun", "sadako"]);
        assert_eq!(pets[0].display_name, "刀盾狗");
        assert_eq!(pets[0].sprite_version, 2);
        assert!(pets[0].spritesheet_path.ends_with("spritesheet-r2.webp"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn folder_name_fills_in_a_missing_id() {
        let root = temp_dir("folder-id");
        write_pkg(
            &root,
            "niulai",
            r#"{ "displayName": "牛来", "spritesheetPath": "spritesheet.webp" }"#,
            "spritesheet.webp",
        );
        let pets = scan_pets_dir(&root);
        assert_eq!(pets[0].id, "niulai");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn copies_bundled_pets_only_when_the_folder_is_missing() {
        let src = temp_dir("seed-src");
        let dest = temp_dir("seed-dest");
        write_pkg(
            &src,
            "daodun",
            r#"{ "id": "daodun", "spritesheetPath": "spritesheet-r2.webp" }"#,
            "spritesheet-r2.webp",
        );
        write_pkg(
            &src,
            "niulai",
            r#"{ "id": "niulai", "spritesheetPath": "spritesheet.webp" }"#,
            "spritesheet.webp",
        );
        fs::create_dir_all(dest.join("niulai")).unwrap();
        fs::write(dest.join("niulai/pet.json"), "keep-me").unwrap();

        assert_eq!(copy_missing_pets(&src, &dest), 1);
        assert!(dest.join("daodun/pet.json").is_file());
        assert_eq!(
            fs::read_to_string(dest.join("niulai/pet.json")).unwrap(),
            "keep-me"
        );
        assert_eq!(copy_missing_pets(&src, &dest), 0);
        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dest);
    }

    #[test]
    fn resolve_sheet_rejects_absolute_and_parent_paths() {
        let root = temp_dir("resolve");
        fs::write(root.join("ok.webp"), b"x").unwrap();
        assert!(resolve_sheet(&root, "ok.webp").is_some());
        assert!(resolve_sheet(&root, "../ok.webp").is_none());
        assert!(resolve_sheet(&root, "/tmp/ok.webp").is_none());
        let _ = fs::remove_dir_all(&root);
    }
}
