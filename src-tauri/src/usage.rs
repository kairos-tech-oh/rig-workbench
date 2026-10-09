//! How much of each logged-in AI subscription's rate limits is used, for the
//! usage overlay. The same sources netwatch's collectors read, without its
//! server:
//!
//! - Claude: the Claude Code login's OAuth token, sent to Anthropic's usage
//!   endpoint. The login is the one the seats use (inside WSL on Windows);
//!   a Windows-side login is shown too, but only when it is another account.
//! - Codex: `codex app-server`'s `account/rateLimits/read`, where the seats run,
//!   when Codex is installed there.
//!
//! The token is read from the credentials file into a local, sent only in the
//! Authorization header, and never returned, logged, written or refreshed.
//! What leaves this module is labels, percentages, reset times and the plan.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

use crate::daemon::client;

const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const CODEX_TIMEOUT: Duration = Duration::from_secs(12);
/// A fresh probe at most this often per account; a refresh someone asked for, at most every FORCED.
const PROBE_MIN_INTERVAL: Duration = Duration::from_secs(60);
const PROBE_MIN_INTERVAL_FORCED: Duration = Duration::from_secs(15);
/// History kept on disk, and returned for the graph.
const HISTORY_KEEP_SECS: u64 = 7 * 24 * 3600;
const HISTORY_RETURN_SECS: u64 = 24 * 3600;
/// Samples closer together than this are not all kept.
const HISTORY_MIN_GAP_SECS: u64 = 240;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    label: String,
    /// 0 to 1.
    percent: f64,
    /// ISO 8601, or empty when unknown.
    resets_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    /// Stable id for the graph: claude, claude-windows, codex.
    id: String,
    provider: String,
    label: String,
    plan: String,
    limits: Vec<Limit>,
    /// Why there are no (fresh) numbers, in words; empty when all is well.
    note: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Sample {
    /// Unix seconds.
    t: u64,
    account: String,
    label: String,
    percent: f64,
}

#[derive(Serialize)]
pub struct Usage {
    accounts: Vec<Account>,
    history: Vec<Sample>,
}

#[derive(Default)]
pub struct UsageState {
    /// Last result per account and when it was fetched, so opening the overlay
    /// repeatedly never turns into a request each time.
    cache: Mutex<HashMap<String, (Instant, Account)>>,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

// ---- Claude -------------------------------------------------------------------

/// A Claude Code login: its config folder, and the file naming its account.
struct ClaudeLogin {
    id: &'static str,
    label: &'static str,
    config_dir: PathBuf,
    account_file: PathBuf,
}

/// The login the seats use: inside WSL on Windows, the user's own elsewhere.
async fn seat_login() -> Option<ClaudeLogin> {
    if cfg!(windows) {
        let home = wsl_home().await?;
        return Some(ClaudeLogin {
            id: "claude",
            label: "Claude",
            config_dir: crate::rig_spec::native_path(&format!("{home}/.claude")),
            account_file: crate::rig_spec::native_path(&format!("{home}/.claude.json")),
        });
    }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let config_dir = std::env::var_os("CLAUDE_CONFIG_DIR").map_or_else(|| home.join(".claude"), PathBuf::from);
    Some(ClaudeLogin {
        id: "claude",
        label: "Claude",
        account_file: home.join(".claude.json"),
        config_dir,
    })
}

/// Claude Code's own Windows login, if this is Windows.
fn windows_login() -> Option<ClaudeLogin> {
    if !cfg!(windows) {
        return None;
    }
    let home = PathBuf::from(std::env::var_os("USERPROFILE")?);
    let config_dir = std::env::var_os("CLAUDE_CONFIG_DIR").map_or_else(|| home.join(".claude"), PathBuf::from);
    Some(ClaudeLogin {
        id: "claude-windows",
        label: "Claude (Windows login)",
        account_file: home.join(".claude.json"),
        config_dir,
    })
}

/// The Linux home directory inside WSL, asked once.
async fn wsl_home() -> Option<String> {
    static HOME: tokio::sync::OnceCell<Option<String>> = tokio::sync::OnceCell::const_new();
    HOME.get_or_init(|| async {
        let distro = std::env::var("RIG_WSL_DISTRO").unwrap_or_else(|_| "Ubuntu".to_string());
        let mut cmd = tokio::process::Command::new("wsl.exe");
        cmd.args(["-d", &distro, "-e", "sh", "-c", "printf %s \"$HOME\""]);
        no_window(&mut cmd);
        let out = tokio::time::timeout(Duration::from_secs(10), cmd.output())
            .await
            .ok()?
            .ok()?;
        let home = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (out.status.success() && home.starts_with('/')).then_some(home)
    })
    .await
    .clone()
}

fn no_window(_cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        _cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// The account behind a login, to tell two logins apart. Never shown.
fn account_uuid(file: &Path) -> Option<String> {
    let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()?;
    json["oauthAccount"]["accountUuid"].as_str().map(String::from)
}

/// "Max 20x", "Pro"…, from the login's rate-limit tier or subscription type.
fn plan_label(tier: &str, subscription: &str) -> String {
    let lower = tier.to_ascii_lowercase();
    if let Some(i) = lower.find("max_") {
        let rest: String = lower[i + 4..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect();
        if rest.ends_with('x') && rest[..rest.len() - 1].chars().all(|c| c.is_ascii_digit()) && rest.len() > 1 {
            return format!("Max {rest}");
        }
    }
    let mut chars = subscription.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// Anthropic has reported both fractions (0.37) and percentages (37.0); a payload
/// with any value of 1 or more is in percent, so 1.0 there means 1%.
fn normalize(value: &serde_json::Value, percent_scale: bool) -> Option<f64> {
    let n = match value {
        serde_json::Value::Number(n) => n.as_f64()?,
        serde_json::Value::String(s) => s.trim().trim_end_matches('%').parse().ok()?,
        _ => return None,
    };
    if n.is_nan() || n < 0.0 {
        return None;
    }
    Some(if percent_scale || n > 1.0 {
        (n / 100.0).min(1.0)
    } else {
        n.min(1.0)
    })
}

fn reset_at(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => {
            let Some(mut ts) = n.as_f64() else { return String::new() };
            if ts > 1e12 {
                ts /= 1000.0;
            }
            iso_from_unix(ts as i64)
        }
        _ => String::new(),
    }
}

/// Unix seconds to an ISO 8601 UTC timestamp.
fn iso_from_unix(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// The windows in a usage payload: session (5-hour), weekly, and any limit
/// scoped to one model, which only the `limits` list carries.
fn claude_limits(payload: &serde_json::Value) -> Vec<Limit> {
    let bucket = |key: &str| payload.get(key).filter(|b| b.is_object());
    let weekly = bucket("seven_day_oauth_apps").or_else(|| bucket("seven_day"));
    let session = bucket("five_hour");
    let entries = payload["limits"].as_array().cloned().unwrap_or_default();

    let mut raw: Vec<&serde_json::Value> = Vec::new();
    raw.extend(session.map(|b| &b["utilization"]));
    raw.extend(weekly.map(|b| &b["utilization"]));
    raw.extend(entries.iter().map(|e| &e["percent"]));
    let percent_scale = raw.iter().any(|v| normalize(v, true).is_some_and(|p| p * 100.0 >= 1.0));

    let mut limits = Vec::new();
    for (label, b) in [("Session (5-hour)", session), ("Weekly (7-day)", weekly)] {
        if let Some(b) = b {
            if let Some(percent) = normalize(&b["utilization"], percent_scale) {
                limits.push(Limit {
                    label: label.into(),
                    percent,
                    resets_at: reset_at(&b["resets_at"]),
                });
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    for entry in &entries {
        let model = &entry["scope"]["model"];
        let name = model["display_name"]
            .as_str()
            .or_else(|| model["id"].as_str())
            .unwrap_or("")
            .trim();
        let kind = entry["kind"].as_str().unwrap_or("").trim().to_string();
        if name.is_empty() || !seen.insert((name.to_string(), kind.clone())) {
            continue;
        }
        let Some(percent) = normalize(&entry["percent"], percent_scale) else {
            continue;
        };
        let k = kind.to_ascii_lowercase();
        let window = if k.contains("month") {
            " Monthly"
        } else if k.contains("week") || k.contains("day") {
            " Weekly"
        } else if k.contains("hour") || k.contains("session") {
            " Session"
        } else {
            ""
        };
        limits.push(Limit {
            label: format!("{name}{window}"),
            percent,
            resets_at: reset_at(&entry["resets_at"]),
        });
    }
    limits
}

async fn claude_account(login: &ClaudeLogin) -> Option<Account> {
    let text = std::fs::read_to_string(login.config_dir.join(".credentials.json")).ok()?;
    let creds: serde_json::Value = serde_json::from_str(&text).ok()?;
    let oauth = &creds["claudeAiOauth"];
    let token = oauth["accessToken"].as_str().unwrap_or("");
    let mut account = Account {
        id: login.id.into(),
        provider: "claude".into(),
        label: login.label.into(),
        plan: plan_label(
            oauth["rateLimitTier"].as_str().unwrap_or(""),
            oauth["subscriptionType"].as_str().unwrap_or(""),
        ),
        limits: Vec::new(),
        note: String::new(),
    };
    if token.is_empty() {
        account.note = "Not signed in. Run `claude auth login`.".into();
        return Some(account);
    }
    let expires_ms = oauth["expiresAt"].as_u64().unwrap_or(0);
    if expires_ms > 0 && expires_ms <= now_secs() * 1000 {
        account.note = "Claude Code's saved sign-in has expired; it renews when Claude Code next runs.".into();
        return Some(account);
    }
    let response = client()
        .get(CLAUDE_USAGE_URL)
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("Accept", "application/json")
        .timeout(PROBE_TIMEOUT)
        .send()
        .await;
    match response {
        Err(_) => account.note = "Couldn't reach Anthropic's usage endpoint.".into(),
        Ok(r) if r.status() == reqwest::StatusCode::TOO_MANY_REQUESTS => {
            account.note = "Anthropic is rate limiting usage checks; trying again later.".into()
        }
        Ok(r) if r.status() == reqwest::StatusCode::UNAUTHORIZED => {
            account.note = "The saved sign-in was refused; it renews when Claude Code next runs.".into()
        }
        Ok(r) if !r.status().is_success() => {
            account.note = format!("Anthropic's usage endpoint returned {}.", r.status().as_u16())
        }
        Ok(r) => match r.json::<serde_json::Value>().await {
            Ok(payload) => {
                account.limits = claude_limits(&payload);
                if account.limits.is_empty() {
                    account.note = "The usage endpoint reported no limits.".into();
                }
            }
            Err(_) => account.note = "The usage endpoint's answer was not readable.".into(),
        },
    }
    Some(account)
}

/// The Claude logins to show: the seats' one, and the Windows one only when it
/// is signed in to a different account.
async fn claude_logins() -> Vec<ClaudeLogin> {
    let seat = seat_login().await;
    let mut logins = Vec::new();
    if let Some(windows) = windows_login() {
        let seat_account = seat.as_ref().and_then(|s| account_uuid(&s.account_file));
        let windows_account = account_uuid(&windows.account_file);
        let signed_in = windows.config_dir.join(".credentials.json").exists();
        if signed_in && windows_account.is_some() && windows_account != seat_account {
            logins.push(windows);
        }
    }
    if let Some(seat) = seat {
        logins.insert(0, seat);
    }
    logins
}

// ---- Codex ---------------------------------------------------------------------

/// `codex app-server`, where the seats run; exits 127 when Codex isn't installed.
const CODEX_SCRIPT: &str =
    "command -v codex >/dev/null 2>&1 || exit 127\nexec codex -s read-only -a on-request app-server";

fn codex_command() -> tokio::process::Command {
    let mut cmd = if cfg!(windows) {
        let distro = std::env::var("RIG_WSL_DISTRO").unwrap_or_else(|_| "Ubuntu".to_string());
        let mut cmd = tokio::process::Command::new("wsl.exe");
        cmd.args(["-d", &distro, "-e", "bash", "-ic", CODEX_SCRIPT]);
        cmd
    } else {
        let mut cmd = tokio::process::Command::new("bash");
        cmd.args(["-ic", CODEX_SCRIPT]);
        cmd
    };
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    no_window(&mut cmd);
    cmd
}

fn codex_window(window: &serde_json::Value) -> Option<Limit> {
    let used = window["usedPercent"].as_f64()?;
    let mins = window["windowDurationMins"].as_u64().unwrap_or(0);
    let label = match mins {
        10_080 => "Weekly (7-day)".to_string(),
        300 => "Session (5-hour)".to_string(),
        m if m > 0 && m % 60 == 0 => format!("{}h window", m / 60),
        m if m > 0 => format!("{m}m window"),
        _ => "Limit".to_string(),
    };
    let resets_at = window["resetsAt"].as_i64().map(iso_from_unix).unwrap_or_default();
    Some(Limit {
        label,
        percent: (used / 100.0).clamp(0.0, 1.0),
        resets_at,
    })
}

fn rpc_request(id: u64, method: &str, params: serde_json::Value) -> String {
    serde_json::json!({ "id": id, "method": method, "params": params }).to_string() + "\n"
}

/// The reply to request `want`, skipping anything else: notifications, shell chatter.
async fn rpc_answer(
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    want: u64,
) -> Option<serde_json::Value> {
    while let Some(line) = lines.next_line().await.ok()? {
        if let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) {
            if message["id"].as_u64() == Some(want) {
                return Some(message);
            }
        }
    }
    None
}

/// Codex's limits, or None when Codex isn't installed where the seats run.
async fn codex_account() -> Option<Account> {
    let mut child = codex_command().spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    let mut lines = BufReader::new(child.stdout.take()?).lines();
    let mut account = Account {
        id: "codex".into(),
        provider: "codex".into(),
        label: "Codex".into(),
        plan: String::new(),
        limits: Vec::new(),
        note: String::new(),
    };

    let talk = async {
        let init = rpc_request(
            1,
            "initialize",
            serde_json::json!({ "clientInfo": { "name": "rig-workbench", "version": "1" } }),
        );
        stdin.write_all(init.as_bytes()).await.ok()?;
        rpc_answer(&mut lines, 1).await?;
        stdin
            .write_all(b"{\"method\":\"initialized\",\"params\":{}}\n")
            .await
            .ok()?;
        let read = rpc_request(2, "account/rateLimits/read", serde_json::json!({}));
        stdin.write_all(read.as_bytes()).await.ok()?;
        rpc_answer(&mut lines, 2).await
    };
    let reply = tokio::time::timeout(CODEX_TIMEOUT, talk).await.ok().flatten();
    let _ = child.kill().await;
    let status = child.try_wait().ok().flatten();
    if reply.is_none() && status.and_then(|s| s.code()) == Some(127) {
        return None;
    }
    match reply {
        Some(message) => {
            let limits = &message["result"]["rateLimits"];
            account.plan = limits["planType"].as_str().unwrap_or("").to_string();
            account.limits = [&limits["primary"], &limits["secondary"]]
                .into_iter()
                .filter_map(codex_window)
                .collect();
            if account.limits.is_empty() {
                account.note = message["error"]["message"].as_str().map_or(
                    "Codex reported no limits. Run `codex login` if it isn't signed in.".into(),
                    |m| format!("Codex: {m}"),
                );
            }
        }
        None => account.note = "Codex didn't answer; run `codex login` if it isn't signed in.".into(),
    }
    Some(account)
}

// ---- History and the command ----------------------------------------------------

fn history_path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("usage-history.json"))
}

fn load_history(path: &Path) -> Vec<Sample> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Add the fresh readings, drop old ones, and save. Only percentages are stored.
fn record(path: &Path, fresh: &[Account]) -> Vec<Sample> {
    let now = now_secs();
    let mut history = load_history(path);
    history.retain(|s| now.saturating_sub(s.t) <= HISTORY_KEEP_SECS);
    for account in fresh {
        let last = history
            .iter()
            .filter(|s| s.account == account.id)
            .map(|s| s.t)
            .max()
            .unwrap_or(0);
        if now.saturating_sub(last) < HISTORY_MIN_GAP_SECS {
            continue;
        }
        for limit in &account.limits {
            history.push(Sample {
                t: now,
                account: account.id.clone(),
                label: limit.label.clone(),
                percent: limit.percent,
            });
        }
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string(&history) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
    history
}

/// Usage for every logged-in subscription, and the last day of readings.
/// `force` (a refresh someone asked for) shortens the reuse window.
#[tauri::command]
pub async fn usage_read(app: AppHandle, state: State<'_, UsageState>, force: bool) -> Result<Usage, String> {
    let min_interval = if force {
        PROBE_MIN_INTERVAL_FORCED
    } else {
        PROBE_MIN_INTERVAL
    };
    let logins = claude_logins().await;
    let mut wanted: Vec<String> = logins.iter().map(|l| l.id.to_string()).collect();
    wanted.push("codex".into());

    let mut accounts = Vec::new();
    let mut fresh = Vec::new();
    let cache = state.cache.lock().await.clone();
    for id in &wanted {
        if let Some((at, account)) = cache.get(id) {
            if at.elapsed() < min_interval {
                accounts.push(account.clone());
                continue;
            }
        }
        let fetched = if id == "codex" {
            codex_account().await
        } else {
            match logins.iter().find(|l| l.id == id) {
                Some(login) => claude_account(login).await,
                None => None,
            }
        };
        let Some(mut account) = fetched else { continue };
        // A failed probe keeps showing the last numbers whose window hasn't reset.
        if account.limits.is_empty() {
            if let Some((_, previous)) = cache.get(id) {
                let now = iso_from_unix(now_secs() as i64);
                account.limits = previous
                    .limits
                    .iter()
                    .filter(|l| l.resets_at.is_empty() || l.resets_at.as_str() > now.as_str())
                    .cloned()
                    .collect();
            }
        } else {
            fresh.push(account.clone());
        }
        state
            .cache
            .lock()
            .await
            .insert(id.clone(), (Instant::now(), account.clone()));
        accounts.push(account);
    }

    let history = match history_path(&app) {
        Some(path) => record(&path, &fresh),
        None => Vec::new(),
    };
    let since = now_secs().saturating_sub(HISTORY_RETURN_SECS);
    Ok(Usage {
        accounts,
        history: history.into_iter().filter(|s| s.t >= since).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_labels() {
        assert_eq!(plan_label("default_claude_max_20x", "max"), "Max 20x");
        assert_eq!(plan_label("", "pro"), "Pro");
        assert_eq!(plan_label("", ""), "");
    }

    #[test]
    fn reads_percent_and_fraction_payloads() {
        let percent = serde_json::json!({
            "five_hour": { "utilization": 1.0, "resets_at": "2026-10-09T15:00:00Z" },
            "seven_day": { "utilization": 37.5, "resets_at": "2026-10-12T00:00:00Z" },
            "limits": [{ "kind": "weekly_scoped", "percent": 12, "scope": { "model": { "display_name": "Opus" } } }]
        });
        let limits = claude_limits(&percent);
        assert_eq!(limits.len(), 3);
        assert!(
            (limits[0].percent - 0.01).abs() < 1e-9,
            "1.0 in a percent payload is 1%"
        );
        assert!((limits[1].percent - 0.375).abs() < 1e-9);
        assert_eq!(limits[2].label, "Opus Weekly");
        let fraction = serde_json::json!({ "five_hour": { "utilization": 0.4 }, "seven_day": { "utilization": 0.1 } });
        assert!((claude_limits(&fraction)[0].percent - 0.4).abs() < 1e-9);
    }

    #[test]
    fn unix_to_iso() {
        assert_eq!(iso_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_from_unix(1_791_590_400), "2026-10-10T00:00:00Z");
    }
}
