mod daemon;
mod layout;
mod pty;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(pty::PtyRegistry::default())
        .manage(daemon::EventsSubscription::default())
        .invoke_handler(tauri::generate_handler![
            daemon::daemon_get,
            daemon::daemon_write,
            daemon::events_subscribe,
            layout::layout_load,
            layout::layout_save,
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
