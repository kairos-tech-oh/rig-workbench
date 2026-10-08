//! Access to the OpenRig daemon's HTTP API.
//!
//! Requests go through Rust rather than the webview so the daemon does not
//! need to allow the webview's origin.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

const DEFAULT_DAEMON_URL: &str = "http://127.0.0.1:7433";
const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Adding or relaunching a seat waits for the agent to start.
const WRITE_TIMEOUT: Duration = Duration::from_secs(240);
const EVENTS_RETRY_DELAY: Duration = Duration::from_secs(3);

pub(crate) fn daemon_url() -> String {
    std::env::var("RIG_DAEMON_URL").unwrap_or_else(|_| DEFAULT_DAEMON_URL.to_string())
}

/// One shared client with no overall timeout (the event stream stays open);
/// each request sets its own.
pub(crate) fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().build().expect("failed to build HTTP client"))
}

fn check_api_path(path: &str) -> Result<(), String> {
    if !path.starts_with("/api/") || path.contains("..") {
        return Err(format!("refusing daemon path '{path}': must start with /api/"));
    }
    Ok(())
}

/// GET a daemon API path such as `/api/rigs` and return its JSON body.
#[tauri::command]
pub async fn daemon_get(path: String) -> Result<serde_json::Value, String> {
    check_api_path(&path)?;
    let url = format!("{}{}", daemon_url(), path);
    let response = client()
        .get(&url)
        .timeout(READ_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("daemon unreachable at {url}: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("daemon returned {status} for {path}: {body}"));
    }
    response
        .json()
        .await
        .map_err(|e| format!("daemon returned invalid JSON for {path}: {e}"))
}

/// The only writes the GUI makes. `*` matches one path segment.
const WRITE_ALLOWLIST: &[(&str, &str)] = &[
    ("POST", "/api/rigs/*/pods/*/members"), // add a seat to a pod
    ("DELETE", "/api/rigs/*/nodes/*"),      // remove a seat
    ("POST", "/api/rigs/*/edges"),          // connect two seats
    ("DELETE", "/api/rigs/*/edges/*"),      // disconnect two seats
    ("POST", "/api/seat/set-model/*"),
    ("POST", "/api/seat/launch/*"),
];

fn matches_pattern(pattern: &str, path: &str) -> bool {
    let pattern: Vec<&str> = pattern.split('/').collect();
    let path: Vec<&str> = path.split('/').collect();
    pattern.len() == path.len()
        && pattern
            .iter()
            .zip(&path)
            .all(|(p, s)| if *p == "*" { !s.is_empty() } else { p == s })
}

fn check_write(method: &str, path: &str) -> Result<reqwest::Method, String> {
    check_api_path(path)?;
    let allowed = WRITE_ALLOWLIST
        .iter()
        .any(|(m, pattern)| *m == method && matches_pattern(pattern, path));
    if !allowed {
        return Err(format!(
            "refusing {method} {path}: not an operation Rig Workbench performs"
        ));
    }
    Ok(if method == "DELETE" {
        reqwest::Method::DELETE
    } else {
        reqwest::Method::POST
    })
}

#[derive(Serialize)]
pub struct WriteResult {
    ok: bool,
    status: u16,
    /// The daemon's JSON response, or its raw text when it isn't JSON.
    body: serde_json::Value,
}

/// Make an allowlisted write. Non-2xx responses are returned, not raised, so
/// the UI can show the daemon's own explanation (for example a 409 refusal).
#[tauri::command]
pub async fn daemon_write(
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<WriteResult, String> {
    let http_method = check_write(&method, &path)?;
    let url = format!("{}{}", daemon_url(), path);
    let mut request = client().request(http_method, &url).timeout(WRITE_TIMEOUT);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("daemon unreachable at {url}: {e}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let body = serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text));
    Ok(WriteResult {
        ok: status.is_success(),
        status: status.as_u16(),
        body,
    })
}

#[derive(Default)]
pub struct EventsSubscription {
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

/// Stream the daemon's global event feed (`/api/events`) to the webview, one
/// JSON string per event. Replaces any previous subscription. Reconnects on
/// failure, resuming after the last event seen.
#[tauri::command]
pub fn events_subscribe(subscription: State<'_, EventsSubscription>, on_event: Channel<String>) -> Result<(), String> {
    let task = tauri::async_runtime::spawn(async move {
        let mut last_id: u64 = 0;
        loop {
            if let Err(e) = stream_events(&on_event, &mut last_id).await {
                eprintln!("[events] {e}; retrying in {}s", EVENTS_RETRY_DELAY.as_secs());
            }
            tokio::time::sleep(EVENTS_RETRY_DELAY).await;
        }
    });
    let mut current = subscription.task.lock().map_err(|e| e.to_string())?;
    if let Some(previous) = current.replace(task) {
        previous.abort();
    }
    Ok(())
}

/// Read one SSE connection until it ends. `data:` lines are forwarded;
/// `id:` lines advance `last_id` so a reconnect does not replay history.
async fn stream_events(on_event: &Channel<String>, last_id: &mut u64) -> Result<(), String> {
    let url = format!("{}/api/events", daemon_url());
    let response = client()
        .get(&url)
        .header("Last-Event-ID", last_id.to_string())
        .header("Accept", "text/event-stream")
        .send()
        .await
        .map_err(|e| format!("event stream unreachable at {url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("event stream returned {}", response.status()));
    }

    let mut stream = response.bytes_stream();
    let mut pending = Vec::<u8>::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("event stream interrupted: {e}"))?;
        pending.extend_from_slice(&chunk);
        while let Some(newline) = pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = pending.drain(..=newline).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\r', '\n']);
            if let Some(data) = line.strip_prefix("data:") {
                if on_event.send(data.trim_start().to_string()).is_err() {
                    return Ok(());
                }
            } else if let Some(id) = line.strip_prefix("id:") {
                if let Ok(id) = id.trim().parse() {
                    *last_id = id;
                }
            }
        }
    }
    Err("event stream closed".to_string())
}

#[cfg(test)]
mod tests {
    use super::check_write;

    #[test]
    fn allows_only_the_gui_writes() {
        assert!(check_write("POST", "/api/rigs/R1/pods/eng/members").is_ok());
        assert!(check_write("DELETE", "/api/rigs/R1/nodes/eng.gym").is_ok());
        assert!(check_write("POST", "/api/rigs/R1/edges").is_ok());
        assert!(check_write("DELETE", "/api/rigs/R1/edges/E1").is_ok());
        assert!(check_write("POST", "/api/seat/set-model/eng-gym%40workbench").is_ok());

        assert!(check_write("DELETE", "/api/rigs/R1").is_err());
        assert!(check_write("POST", "/api/rigs/R1/up").is_err());
        assert!(check_write("DELETE", "/api/rigs/R1/edges").is_err());
        assert!(check_write("POST", "/api/rigs//edges").is_err());
        assert!(check_write("POST", "/api/transport/send").is_err());
    }
}
