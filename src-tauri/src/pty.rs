//! Live terminals for seat blocks.
//!
//! The commands are `async` so Tauri runs them off the main thread: opening
//! and resizing a Windows pseudo-console can block briefly, and the window
//! must stay responsive while it does.
//!
//! Each open block owns a pseudo-terminal running `tmux attach-session` to its
//! seat's tmux session. On Windows the command runs inside WSL (`wsl.exe -e`),
//! because the OpenRig daemon and its tmux server live there. On Linux and
//! macOS tmux is invoked directly.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// Kill the tmux client and release the pseudo-terminal on a background thread.
///
/// On Windows, dropping the master calls ClosePseudoConsole, which blocks until
/// pending output has been read. That output is read by the session's reader
/// thread, whose channel sends need the app's event loop, so tearing down on a
/// thread the event loop waits on can deadlock the window.
fn close_in_background(mut session: PtySession) {
    std::thread::spawn(move || {
        let _ = session.child.kill();
        drop(session);
    });
}

#[derive(Default)]
pub struct PtyRegistry {
    sessions: Mutex<HashMap<String, PtySession>>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PtyEvent {
    /// Terminal output, base64-encoded so multi-byte characters split across
    /// reads survive the trip to the webview intact.
    Data { b64: String },
    Exit,
}

/// tmux session names are passed as arguments, never through a shell, but
/// restrict them anyway to the characters OpenRig produces (`pod-member@rig`).
fn validate_session_name(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '.' | '_' | '-'));
    if ok {
        Ok(())
    } else {
        Err(format!("invalid tmux session name '{name}'"))
    }
}

fn attach_command(session: &str) -> CommandBuilder {
    let target = format!("={session}");
    let mut cmd = if cfg!(windows) {
        let distro = std::env::var("RIG_WSL_DISTRO").unwrap_or_else(|_| "Ubuntu".to_string());
        let mut cmd = CommandBuilder::new("wsl.exe");
        cmd.args(["-d", &distro, "-e", "tmux", "attach-session", "-t", &target]);
        cmd
    } else {
        let mut cmd = CommandBuilder::new("tmux");
        cmd.args(["attach-session", "-t", &target]);
        cmd
    };
    cmd.env_remove("TMUX");
    cmd.env("TERM", "xterm-256color");
    cmd
}

#[tauri::command]
pub async fn pty_open(
    registry: State<'_, PtyRegistry>,
    id: String,
    session: String,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<(), String> {
    validate_session_name(&session)?;
    let mut sessions = registry.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(old) = sessions.remove(&id) {
        close_in_background(old);
    }

    let pair = native_pty_system()
        .openpty(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("failed to open pty: {e}"))?;
    let child = pair
        .slave
        .spawn_command(attach_command(&session))
        .map_err(|e| format!("failed to attach to '{session}': {e}"))?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    if on_event.send(PtyEvent::Data { b64 }).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = on_event.send(PtyEvent::Exit);
    });

    sessions.insert(id, PtySession { master: pair.master, writer, child });
    Ok(())
}

#[tauri::command]
pub async fn pty_write(registry: State<'_, PtyRegistry>, id: String, data: String) -> Result<(), String> {
    let mut sessions = registry.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get_mut(&id).ok_or_else(|| format!("no terminal '{id}'"))?;
    session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pty_resize(registry: State<'_, PtyRegistry>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = registry.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or_else(|| format!("no terminal '{id}'"))?;
    session
        .master
        .resize(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

/// Detach the block's tmux client. The seat's own session keeps running.
#[tauri::command]
pub async fn pty_close(registry: State<'_, PtyRegistry>, id: String) -> Result<(), String> {
    let mut sessions = registry.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = sessions.remove(&id) {
        close_in_background(session);
    }
    Ok(())
}
