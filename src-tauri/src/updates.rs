//! Keeping the app current. Releases on GitHub carry a `latest.json` and a
//! signature for each installer, made with the update key only the maintainer
//! holds. The updater checks that signature against the public key built into
//! this binary, so an installer that key did not sign is never run.

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

/// The update found by the last check, held so installing it installs exactly
/// what was offered rather than whatever a second check finds.
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current: String,
    /// The release notes, from the changelog.
    notes: String,
    date: String,
}

fn check_failed(e: impl std::fmt::Display) -> String {
    format!("could not check for updates: {e}")
}

/// A newer release, or `null` when this is the latest.
#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, Pending>) -> Result<Option<UpdateInfo>, String> {
    let found = app
        .updater()
        .map_err(check_failed)?
        .check()
        .await
        .map_err(check_failed)?;
    let info = found.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone().unwrap_or_default(),
        date: u.date.map(|d| d.to_string()).unwrap_or_default(),
    });
    *pending.0.lock().await = found;
    Ok(info)
}

/// Downloads the update that was offered, checks its signature, installs it
/// and restarts. On Windows the installer closes the app itself. Open
/// terminals only detach: the seats keep running in tmux.
#[tauri::command]
pub async fn update_install(app: AppHandle, pending: State<'_, Pending>) -> Result<(), String> {
    let Some(update) = pending.0.lock().await.take() else {
        return Err("check for an update first".into());
    };
    let version = update.version.clone();
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("could not install {version}: {e}"))?;
    app.restart();
}

/// This build's own version.
#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}
