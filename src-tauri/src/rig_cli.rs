//! Running the `rig` CLI for the few lifecycle actions the daemon's HTTP API
//! can't do for us: starting the daemon itself, and bringing a rig up or down.
//!
//! `rig` runs where the daemon lives: inside WSL on Windows, directly on
//! Linux. It is usually installed under nvm, whose PATH comes from `.bashrc`
//! after its interactive-only guard, so it runs in an interactive bash
//! (`bash -ic`). Arguments reach `rig` as positional parameters, never
//! spliced into the script. Its output goes to a temporary file rather than
//! our pipe: a daemon started by `rig daemon start` inherits its output, and
//! holding our pipe open would keep us waiting forever.
//!
//! Only the fixed commands below are exposed to the webview.

use std::time::Duration;

use serde::Serialize;

use crate::daemon::{client, daemon_url};

const SCRIPT: &str = r#"log=$(mktemp) || exit 1
rig "$@" >"$log" 2>&1 </dev/null
rc=$?
cat "$log"
rm -f "$log"
exit $rc"#;

const DAEMON_START_TIMEOUT: Duration = Duration::from_secs(240);
const RIG_UP_TIMEOUT: Duration = Duration::from_secs(600);
const RIG_DOWN_TIMEOUT: Duration = Duration::from_secs(180);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(3);
const DEFAULT_PORT: u16 = 7433;
/// Lines of output kept in an error, enough to show what went wrong.
const ERROR_TAIL_LINES: usize = 12;

fn command(args: &[&str]) -> tokio::process::Command {
    let mut cmd = if cfg!(windows) {
        let distro = std::env::var("RIG_WSL_DISTRO").unwrap_or_else(|_| "Ubuntu".to_string());
        let mut cmd = tokio::process::Command::new("wsl.exe");
        cmd.args(["-d", &distro, "-e", "bash", "-ic", SCRIPT, "rig-workbench"]);
        cmd
    } else {
        let mut cmd = tokio::process::Command::new("bash");
        cmd.args(["-ic", SCRIPT, "rig-workbench"]);
        cmd
    };
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // No console window flashing up for wsl.exe.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// What an interactive bash without a terminal says every time, rather than `rig`.
fn is_shell_noise(line: &str) -> bool {
    let line = line.trim();
    line == "exit"
        || line.contains("cannot set terminal process group")
        || line.contains("no job control in this shell")
        || line.contains("screen size is bogus")
}

/// The last lines of what `rig` (and, failing that, the shell) said.
fn tail(stdout: &str, stderr: &str) -> String {
    let stderr: Vec<&str> = stderr
        .lines()
        .filter(|l| !is_shell_noise(l) && !l.trim().is_empty())
        .collect();
    let lines: Vec<&str> = stdout
        .lines()
        .filter(|l| !is_shell_noise(l) && !l.trim().is_empty())
        .chain(stderr)
        .collect();
    let start = lines.len().saturating_sub(ERROR_TAIL_LINES);
    lines[start..].join("\n")
}

/// Run `rig <args>` and return its output, or an error with the end of it.
async fn run(args: &[&str], timeout: Duration) -> Result<String, String> {
    let shown = format!("rig {}", args.join(" "));
    let output = tokio::time::timeout(timeout, command(args).output())
        .await
        .map_err(|_| format!("`{shown}` did not finish within {}s", timeout.as_secs()))?
        .map_err(|e| format!("could not run `{shown}`: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if output.status.success() {
        return Ok(stdout.trim().to_string());
    }
    let said = tail(&stdout, &stderr);
    let code = output.status.code().map_or("a signal".to_string(), |c| c.to_string());
    if code == "127" && said.contains("rig: command not found") {
        return Err("`rig` was not found. Install OpenRig (npm install -g @openrig/cli) where the daemon runs.".into());
    }
    Err(if said.is_empty() {
        format!("`{shown}` failed (exit {code})")
    } else {
        format!("`{shown}` failed (exit {code}):\n{said}")
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonHealth {
    running: bool,
    version: Option<String>,
    pid: Option<u64>,
    url: String,
}

/// Whether the daemon answers, and which one it is.
#[tauri::command]
pub async fn daemon_health() -> DaemonHealth {
    let url = daemon_url();
    let answer = client()
        .get(format!("{url}/healthz"))
        .timeout(HEALTH_TIMEOUT)
        .send()
        .await
        .ok()
        .filter(|r| r.status().is_success());
    let body: Option<serde_json::Value> = match answer {
        Some(response) => response.json().await.ok(),
        None => None,
    };
    DaemonHealth {
        running: body.is_some(),
        version: body.as_ref().and_then(|b| b["semver"].as_str().map(String::from)),
        pid: body.as_ref().and_then(|b| b["pid"].as_u64()),
        url,
    }
}

fn configured_port() -> Option<String> {
    let port = reqwest::Url::parse(&daemon_url()).ok()?.port()?;
    (port != DEFAULT_PORT).then(|| port.to_string())
}

/// `rig daemon start`, with the kernel (operator and advisor) only when asked for.
#[tauri::command]
pub async fn daemon_start(with_kernel: bool) -> Result<String, String> {
    let port = configured_port();
    let mut args = vec!["daemon", "start"];
    if let Some(port) = port.as_deref() {
        args.extend(["--port", port]);
    }
    if !with_kernel {
        args.push("--no-kernel");
    }
    run(&args, DAEMON_START_TIMEOUT).await
}

/// Rig names come from the daemon's own list; still, only plain names reach the CLI.
fn check_rig_name(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && !name.starts_with('-')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if ok {
        Ok(())
    } else {
        Err(format!("invalid rig name '{name}'"))
    }
}

/// The JSON object a `--json` command printed, wherever it is in the output.
fn json_result(output: &str) -> Option<serde_json::Value> {
    let start = output.find('{')?;
    serde_json::from_str(output[start..].trim()).ok()
}

/// Run a `--json` rig command. Its JSON answer is returned even when the exit
/// code says otherwise: `rig up` exits nonzero for a partial restore, which
/// the caller reports seat by seat rather than as a failure.
async fn run_json(args: &[&str], timeout: Duration) -> Result<serde_json::Value, String> {
    let shown = format!("rig {}", args.join(" "));
    let output = tokio::time::timeout(timeout, command(args).output())
        .await
        .map_err(|_| format!("`{shown}` did not finish within {}s", timeout.as_secs()))?
        .map_err(|e| format!("could not run `{shown}`: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if let Some(answer) = json_result(&stdout) {
        return Ok(answer);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let said = tail(&stdout, &stderr);
    Err(if said.is_empty() {
        format!("`{shown}` failed")
    } else {
        format!("`{shown}` failed:\n{said}")
    })
}

/// Bring a stopped rig back: `rig up <name> --existing` restores it from its
/// latest snapshot, resuming each seat's conversation where the harness allows.
/// Returns OpenRig's result, including each seat's outcome.
#[tauri::command]
pub async fn rig_up(name: String) -> Result<serde_json::Value, String> {
    check_rig_name(&name)?;
    run_json(&["up", &name, "--existing", "--json"], RIG_UP_TIMEOUT).await
}

/// Stop every seat of a rig: `rig down <name>`. OpenRig snapshots it first, and
/// the rig record is kept so `rig_up` can bring it back. The daemon keeps running.
#[tauri::command]
pub async fn rig_down(name: String) -> Result<serde_json::Value, String> {
    check_rig_name(&name)?;
    run_json(&["down", &name, "--json"], RIG_DOWN_TIMEOUT).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_rig_names() {
        assert!(check_rig_name("workbench").is_ok());
        assert!(check_rig_name("rig-wb_test.2").is_ok());
        assert!(check_rig_name("").is_err());
        assert!(check_rig_name("--delete").is_err());
        assert!(check_rig_name("a b").is_err());
        assert!(check_rig_name("a;rm").is_err());
    }

    #[test]
    fn error_tail_drops_shell_noise() {
        let stderr = "bash: cannot set terminal process group (-1): Inappropriate ioctl for device\nbash: no job control in this shell\nyour 131072x1 screen size is bogus. expect trouble\nexit\n";
        assert_eq!(tail("one\n\ntwo\nexit\n", stderr), "one\ntwo");
        let long: String = (0..20).map(|i| format!("line {i}\n")).collect();
        assert!(tail(&long, "").starts_with("line 8"));
    }

    #[test]
    fn finds_the_json_answer_after_shell_noise() {
        let out = "bash: no job control in this shell\n{\"status\":\"restored\",\"nodes\":[]}\n";
        assert_eq!(json_result(out).unwrap()["status"], "restored");
        assert!(json_result("Daemon not running").is_none());
    }
}
