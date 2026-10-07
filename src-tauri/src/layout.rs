//! Saved canvas layouts, one JSON file per rig.
//!
//! Files live in the app's data directory (`%APPDATA%\dev.kairos.rigworkbench\layouts`
//! on Windows, `~/.local/share/dev.kairos.rigworkbench/layouts` on Linux), which
//! survives restarts and app updates. The webview owns the file's shape; Rust
//! only stores and returns it.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

fn layout_path(app: &AppHandle, rig_name: &str) -> Result<PathBuf, String> {
    let safe: String = rig_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '_' })
        .collect();
    if safe.is_empty() || safe.starts_with('.') {
        return Err(format!("invalid rig name '{rig_name}'"));
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?
        .join("layouts");
    Ok(dir.join(format!("{safe}.json")))
}

/// The saved layout for a rig, or `null` if none has been saved.
#[tauri::command]
pub async fn layout_load(app: AppHandle, rig_name: String) -> Result<Option<serde_json::Value>, String> {
    let path = layout_path(&app, &rig_name)?;
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| format!("{} is not valid JSON: {e}", path.display()))
}

/// Save a rig's layout. Written to a temporary file and renamed into place so a
/// crash mid-write never leaves a truncated layout.
#[tauri::command]
pub async fn layout_save(app: AppHandle, rig_name: String, layout: serde_json::Value) -> Result<(), String> {
    let path = layout_path(&app, &rig_name)?;
    let dir = path.parent().expect("layout path has a parent");
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let text = serde_json::to_string_pretty(&layout).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("could not replace {}: {e}", path.display()))
}
