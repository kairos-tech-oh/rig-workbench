mod daemon;
mod daemon_update;
mod layout;
mod pty;
mod rig_cli;
mod rig_spec;
mod settings;
mod updates;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // tauri-plugin-updater turns on reqwest's `rustls-no-provider` feature, and
    // features are shared across the crate graph, so every reqwest client
    // (including the daemon client) panics on creation unless a rustls crypto
    // provider is installed first. `Err` means one is already installed.
    let _ = rustls::crypto::ring::default_provider().install_default();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updates::Pending::default())
        .manage(pty::PtyRegistry::default())
        .manage(daemon::EventsSubscription::default())
        .manage(daemon_update::PendingDaemon::default())
        .invoke_handler(tauri::generate_handler![
            daemon::daemon_get,
            daemon::daemon_write,
            daemon::events_subscribe,
            daemon_update::daemon_update_check,
            daemon_update::daemon_update_install,
            layout::layout_load,
            layout::layout_save,
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            rig_cli::daemon_health,
            rig_cli::daemon_start,
            rig_cli::rig_down,
            rig_cli::rig_up,
            rig_spec::rig_spec_read,
            rig_spec::rig_spec_write,
            settings::settings_load,
            settings::settings_save,
            settings::settings_open,
            updates::update_check,
            updates::update_install,
            updates::app_version,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
