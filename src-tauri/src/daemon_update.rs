//! Updating the OpenRig daemon (the kairos-tech-oh fork) named in the app release's latest.json.
//! A tarball is installed only if the app's update key signed it; see docs/RELEASING.md.

use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

use crate::daemon::{client, daemon_url};

const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);
const RESTART_WAIT: Duration = Duration::from_secs(90);
const DEFAULT_PORT: u16 = 7433;

/// The `daemon` block of latest.json.
#[derive(Clone, Debug, Deserialize)]
pub struct DaemonRelease {
    version: String,
    commit: String,
    url: String,
    signature: String,
}

/// The release offered by the last check, so installing installs exactly what was shown.
#[derive(Default)]
pub struct PendingDaemon(Mutex<Option<DaemonRelease>>);

#[derive(Debug, Deserialize)]
struct Health {
    pid: u32,
    semver: Option<String>,
    commit: Option<String>,
    dirty: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatus {
    installed: Option<String>,
    installed_commit: Option<String>,
    available: Option<String>,
    can_update: bool,
    note: String,
}

/// Whether the release may replace the running daemon, and why not when it may not.
fn decide(health: &Health, release: &DaemonRelease) -> (bool, String) {
    let version = health.semver.clone().unwrap_or_default();
    if health.commit.as_deref() == Some(release.commit.as_str()) && health.dirty != Some(true) {
        return (false, "Up to date.".into());
    }
    if health.dirty == Some(true) {
        return (
            false,
            "Built from source with uncommitted changes, so it is left alone.".into(),
        );
    }
    if !version.contains("-kairos.") {
        return (false, "Not a Rig Workbench daemon release (a source build or upstream OpenRig), so it is left alone. See the README to switch.".into());
    }
    match (
        semver::Version::parse(&version),
        semver::Version::parse(&release.version),
    ) {
        (Ok(have), Ok(offered)) if have < offered => (
            true,
            "Installs the release and restarts the daemon; seats keep running.".into(),
        ),
        (Ok(have), Ok(offered)) if have == offered => (
            false,
            "Built from source at the released version, so it is left alone.".into(),
        ),
        (Ok(_), Ok(_)) => (false, "Newer than the release, so it is left alone.".into()),
        _ => (
            false,
            format!("Cannot compare version '{version}' with '{}'.", release.version),
        ),
    }
}

async fn health() -> Result<Health, String> {
    let url = format!("{}/healthz", daemon_url());
    let response = client()
        .get(&url)
        .timeout(FETCH_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("daemon unreachable: {e}"))?;
    response
        .json()
        .await
        .map_err(|e| format!("daemon health was not readable: {e}"))
}

fn updater_config(app: &AppHandle) -> Result<(String, String), String> {
    let updater = app
        .config()
        .plugins
        .0
        .get("updater")
        .ok_or("no updater configuration")?;
    let pubkey = updater["pubkey"].as_str().ok_or("no update public key")?.to_string();
    let endpoint = updater["endpoints"][0]
        .as_str()
        .ok_or("no update endpoint")?
        .to_string();
    Ok((pubkey, endpoint))
}

async fn latest_release(endpoint: &str) -> Result<Option<DaemonRelease>, String> {
    let response = client()
        .get(endpoint)
        .timeout(FETCH_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("could not fetch {endpoint}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("{endpoint} returned {}", response.status()));
    }
    let manifest: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("{endpoint} is not JSON: {e}"))?;
    match manifest.get("daemon") {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(block) => serde_json::from_value(block.clone())
            .map(Some)
            .map_err(|e| format!("bad daemon block in latest.json: {e}")),
    }
}

/// Checks a minisign signature the same way the app updater checks installers.
fn verify(pubkey_b64: &str, signature_b64: &str, data: &[u8]) -> Result<(), String> {
    let decode = |b64: &str| {
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .ok_or_else(|| "not valid base64 text".to_string())
    };
    let key = minisign_verify::PublicKey::decode(&decode(pubkey_b64)?).map_err(|e| format!("bad public key: {e}"))?;
    let signature =
        minisign_verify::Signature::decode(&decode(signature_b64)?).map_err(|e| format!("bad signature: {e}"))?;
    key.verify(data, &signature, true)
        .map_err(|_| "the daemon tarball is not signed by the update key".to_string())
}

/// What the Settings window shows: the running daemon, the released one, and whether to update.
#[tauri::command]
pub async fn daemon_update_check(app: AppHandle, pending: State<'_, PendingDaemon>) -> Result<DaemonStatus, String> {
    let (_, endpoint) = updater_config(&app)?;
    let release = latest_release(&endpoint).await?;
    let health = health().await;
    let (can_update, note) = match (&health, &release) {
        (Err(e), _) => (false, e.clone()),
        (_, None) => (false, "The latest release names no daemon.".into()),
        (Ok(h), Some(r)) if cfg!(target_os = "linux") => decide(h, r),
        (Ok(_), Some(_)) => (
            false,
            "Update the daemon inside WSL; the app updates it on Linux only.".into(),
        ),
    };
    let status = DaemonStatus {
        installed: health.as_ref().ok().and_then(|h| h.semver.clone()),
        installed_commit: health.as_ref().ok().and_then(|h| h.commit.clone()),
        available: release.as_ref().map(|r| r.version.clone()),
        can_update,
        note,
    };
    *pending.0.lock().await = if can_update { release } else { None };
    Ok(status)
}

/// Downloads the offered daemon, checks its signature, installs it where the running daemon lives and restarts it.
#[tauri::command]
pub async fn daemon_update_install(app: AppHandle, pending: State<'_, PendingDaemon>) -> Result<String, String> {
    let Some(release) = pending.0.lock().await.take() else {
        return Err("check for a daemon update first".into());
    };
    let (pubkey, _) = updater_config(&app)?;
    let response = client()
        .get(&release.url)
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("could not download the daemon: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("could not download the daemon: {}", response.status()));
    }
    let tarball = response
        .bytes()
        .await
        .map_err(|e| format!("could not download the daemon: {e}"))?;
    verify(&pubkey, &release.signature, &tarball)?;
    let running = health().await?;
    install_and_restart(&running, &release, &tarball).await?;
    Ok(release.version)
}

#[cfg(not(target_os = "linux"))]
async fn install_and_restart(_: &Health, _: &DaemonRelease, _: &[u8]) -> Result<(), String> {
    Err("the app updates the daemon on Linux only".into())
}

/// The running daemon's own node, install prefix and environment, read from /proc.
#[cfg(target_os = "linux")]
struct Install {
    node: std::path::PathBuf,
    prefix: std::path::PathBuf,
    env: Vec<(String, String)>,
}

#[cfg(target_os = "linux")]
fn locate(pid: u32) -> Result<Install, String> {
    let node =
        std::fs::read_link(format!("/proc/{pid}/exe")).map_err(|e| format!("cannot see the daemon process: {e}"))?;
    let cmdline =
        std::fs::read(format!("/proc/{pid}/cmdline")).map_err(|e| format!("cannot see the daemon process: {e}"))?;
    let marker = "/lib/node_modules/@openrig/cli/";
    let script = String::from_utf8_lossy(&cmdline)
        .split('\0')
        .find_map(|arg| arg.find(marker).map(|i| arg[..i].to_string()))
        .ok_or("the daemon is not running from an npm-installed @openrig/cli")?;
    let environ =
        std::fs::read(format!("/proc/{pid}/environ")).map_err(|e| format!("cannot see the daemon process: {e}"))?;
    let env = String::from_utf8_lossy(&environ)
        .split('\0')
        .filter_map(|kv| kv.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())))
        .collect();
    Ok(Install {
        node,
        prefix: script.into(),
        env,
    })
}

#[cfg(target_os = "linux")]
impl Install {
    // Same environment the daemon was started with, so restarted seats find the same tools.
    fn command(&self, program: &std::path::Path) -> tokio::process::Command {
        let node_dir = self.node.parent().expect("node has a parent directory");
        let path = self
            .env
            .iter()
            .find(|(k, _)| k == "PATH")
            .map(|(_, v)| v.as_str())
            .unwrap_or("");
        let mut cmd = tokio::process::Command::new(program);
        cmd.env_clear()
            .envs(self.env.iter().cloned())
            .env("PATH", format!("{}:{path}", node_dir.display()));
        cmd.stdin(std::process::Stdio::null());
        cmd
    }

    // Output goes to a file, not a pipe: a daemon started here would hold a pipe open forever.
    async fn run(&self, program: &std::path::Path, args: &[&str]) -> Result<(), String> {
        let log = std::env::temp_dir().join(format!("rig-workbench-daemon-{}.log", std::process::id()));
        let file = std::fs::File::create(&log).map_err(|e| e.to_string())?;
        let mut cmd = self.command(program);
        cmd.args(args)
            .process_group(0)
            .stdout(file.try_clone().map_err(|e| e.to_string())?)
            .stderr(file);
        let status = cmd
            .status()
            .await
            .map_err(|e| format!("could not run {}: {e}", program.display()));
        let text = std::fs::read_to_string(&log).unwrap_or_default();
        let _ = std::fs::remove_file(&log);
        if status?.success() {
            return Ok(());
        }
        let tail: Vec<&str> = text.trim().lines().rev().take(6).collect();
        let tail: Vec<&str> = tail.into_iter().rev().collect();
        Err(format!(
            "{} {} failed: {}",
            program.display(),
            args.join(" "),
            tail.join("\n")
        ))
    }
}

#[cfg(target_os = "linux")]
async fn install_and_restart(running: &Health, release: &DaemonRelease, tarball: &[u8]) -> Result<(), String> {
    let install = locate(running.pid)?;
    let had_kernel = crate::daemon::daemon_get("/api/rigs".into())
        .await
        .map(|rigs| {
            rigs.as_array()
                .is_some_and(|all| all.iter().any(|r| r["name"] == "kernel"))
        })
        .unwrap_or(true);

    let port = reqwest::Url::parse(&daemon_url())
        .ok()
        .and_then(|u| u.port())
        .unwrap_or(DEFAULT_PORT)
        .to_string();
    let mut start = vec!["daemon", "start"];
    if port != DEFAULT_PORT.to_string() {
        start.extend(["--port", &port]);
    }
    if !had_kernel {
        start.push("--no-kernel");
    }

    let dir = std::env::temp_dir().join(format!("rig-workbench-daemon-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("openrig-cli-{}.tgz", release.version));
    std::fs::write(&file, tarball).map_err(|e| e.to_string())?;

    // Stopped first: the daemon loads modules lazily, so installing under it could mix versions.
    // Stopping leaves the tmux seats running, and the queue is on disk.
    let rig = install.prefix.join("bin/rig");
    install.run(&rig, &["daemon", "stop"]).await?;
    let npm = install.node.with_file_name("npm");
    let prefix = install.prefix.to_string_lossy().to_string();
    let installed = install
        .run(&npm, &["install", "-g", "--prefix", &prefix, &file.to_string_lossy()])
        .await;
    let _ = std::fs::remove_dir_all(&dir);
    if let Err(e) = installed {
        let restarted = install.run(&rig, &start).await;
        return Err(match restarted {
            Ok(()) => format!("{e}; the previous daemon was started again"),
            Err(again) => format!("{e}; restarting the previous daemon also failed: {again}"),
        });
    }
    install.run(&rig, &start).await?;

    let deadline = tokio::time::Instant::now() + RESTART_WAIT;
    while tokio::time::Instant::now() < deadline {
        if let Ok(h) = health().await {
            if h.commit.as_deref() == Some(release.commit.as_str()) {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    Err(format!(
        "installed {} but the daemon did not come back on it; run `rig daemon start`",
        release.version
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn health(semver: &str, commit: &str, dirty: bool) -> Health {
        Health {
            pid: 1,
            semver: Some(semver.into()),
            commit: Some(commit.into()),
            dirty: Some(dirty),
        }
    }

    fn release() -> DaemonRelease {
        DaemonRelease {
            version: "0.6.8-kairos.2".into(),
            commit: "bbb".into(),
            url: String::new(),
            signature: String::new(),
        }
    }

    #[test]
    fn replaces_only_an_older_clean_fork_release() {
        assert!(decide(&health("0.6.8-kairos.1", "aaa", false), &release()).0);
        assert!(
            !decide(&health("0.6.8-kairos.2", "bbb", false), &release()).0,
            "same commit"
        );
        assert!(
            !decide(&health("0.6.8-kairos.2", "ccc", false), &release()).0,
            "source build at that version"
        );
        assert!(!decide(&health("0.6.8-kairos.1", "aaa", true), &release()).0, "dirty");
        assert!(!decide(&health("0.6.9-kairos.1", "ddd", false), &release()).0, "newer");
        assert!(
            !decide(&health("0.6.7", "2606a2ac", false), &release()).0,
            "upstream or unsuffixed source build"
        );
    }

    // Signed with a throwaway key made for this test, not the release key.
    const TEST_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDY0MEUzREFCODg5MjMyNzkKUldSNU1wS0lxejBPWkZmRHRVZ2ZoaUtuUzZjNUp3b1puSVhyNEFlZSs0WFJ6a2MycXFoclR3clAK";
    const TEST_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSNU1wS0lxejBPWkVPWWQyL1FWcE5rVVBkVklBVVF4Z21YMjhTellRMDVhMkdvb0ZXRUgwRDMxMCs0TVRubUxpdG1RYkdGeVRubVV5N1l0UkVMRmZjcTJVYmZya0d3TFFNPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkxNDg2MTY3CWZpbGU6Zml4dHVyZS5iaW4KT3hGQVNwV0xGc0lpbDJNalYvNW1ibVY1SENKUm1wUC95ZS91ZmFZUmUxL1dwbjhjZDNjTDRhSVNLYUljRWt5cjNXWlhVZFlodzNzMmlYNXdyRk1aRGc9PQo=";

    #[test]
    fn installs_only_what_the_key_signed() {
        let signed = b"openrig daemon tarball stand-in\n";
        assert!(verify(TEST_PUBKEY, TEST_SIGNATURE, signed).is_ok());
        assert!(verify(
            TEST_PUBKEY,
            TEST_SIGNATURE,
            b"openrig daemon tarball stand-in, altered\n"
        )
        .is_err());
        assert!(verify(TEST_PUBKEY, "bm90IGEgc2lnbmF0dXJl", signed).is_err());
    }
}
