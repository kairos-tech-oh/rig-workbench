//! App-wide preferences, stored as one JSON file next to the saved layouts.

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?;
    Ok(dir.join("settings.json"))
}

/// The saved settings, or `null` if none have been saved.
#[tauri::command]
pub async fn settings_load(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = settings_path(&app)?;
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| format!("{} is not valid JSON: {e}", path.display()))
}

/// Save the settings and tell every window, so the main window applies them live.
#[tauri::command]
pub async fn settings_save(app: AppHandle, settings: serde_json::Value) -> Result<(), String> {
    let path = settings_path(&app)?;
    let dir = path.parent().expect("settings path has a parent");
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("could not replace {}: {e}", path.display()))?;
    app.emit("settings-changed", &settings).map_err(|e| e.to_string())
}

/// Open the settings window, or bring it forward if it is already open.
#[tauri::command]
pub async fn settings_open(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        return window.set_focus().map_err(|e| e.to_string());
    }
    WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("index.html".into()))
        .title("Rig Workbench Settings")
        .inner_size(460.0, 560.0)
        .resizable(false)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
