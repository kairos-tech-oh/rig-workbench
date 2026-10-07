//! Read-only access to the OpenRig daemon's HTTP API.
//!
//! Requests go through Rust rather than the webview so the daemon does not
//! need to allow the webview's origin.

use std::sync::OnceLock;

const DEFAULT_DAEMON_URL: &str = "http://127.0.0.1:7433";

fn daemon_url() -> String {
    std::env::var("RIG_DAEMON_URL").unwrap_or_else(|_| DEFAULT_DAEMON_URL.to_string())
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("failed to build HTTP client")
    })
}

/// GET a daemon API path such as `/api/rigs` and return its JSON body.
#[tauri::command]
pub async fn daemon_get(path: String) -> Result<serde_json::Value, String> {
    if !path.starts_with("/api/") || path.contains("..") {
        return Err(format!("refusing daemon path '{path}': must start with /api/"));
    }
    let url = format!("{}{}", daemon_url(), path);
    let response = client()
        .get(&url)
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
