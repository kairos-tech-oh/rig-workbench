//! Reading and writing the rig spec, `rig.yaml` in the rig folder.
//!
//! The webview decides what the file says (it edits the YAML so comments and
//! layout survive); Rust only finds the file, reads it, and replaces it.
//!
//! The rig folder is a path as the daemon sees it. On Windows the daemon runs
//! in WSL, so a Linux path is mapped to one Windows can open: `/mnt/<drive>/…`
//! to `<DRIVE>:\…`, anything else through `\\wsl.localhost\<distro>\…`.

use std::path::PathBuf;

const SPEC_FILE: &str = "rig.yaml";

fn spec_path(folder: &str) -> Result<PathBuf, String> {
    let folder = folder.trim().trim_end_matches('/');
    if !folder.starts_with('/') || folder.split('/').any(|part| part == "..") {
        return Err(format!("rig folder '{folder}' must be an absolute path"));
    }
    Ok(native_path(folder).join(SPEC_FILE))
}

#[cfg(windows)]
pub(crate) fn native_path(linux: &str) -> PathBuf {
    let parts: Vec<&str> = linux.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() >= 2 && parts[0] == "mnt" && parts[1].len() == 1 && parts[1].chars().all(|c| c.is_ascii_alphabetic())
    {
        let mut path = PathBuf::from(format!("{}:\\", parts[1].to_ascii_uppercase()));
        path.extend(&parts[2..]);
        return path;
    }
    let distro = std::env::var("RIG_WSL_DISTRO").unwrap_or_else(|_| "Ubuntu".to_string());
    let mut path = PathBuf::from(format!(r"\\wsl.localhost\{distro}\"));
    path.extend(&parts);
    path
}

#[cfg(not(windows))]
pub(crate) fn native_path(linux: &str) -> PathBuf {
    PathBuf::from(linux)
}

/// The text of `<folder>/rig.yaml`.
#[tauri::command]
pub async fn rig_spec_read(folder: String) -> Result<String, String> {
    let path = spec_path(&folder)?;
    std::fs::read_to_string(&path).map_err(|e| format!("could not read {}: {e}", path.display()))
}

/// Replace `<folder>/rig.yaml` with `text`, but only if it still reads
/// `expected` (what the edit was based on), so an edit made meanwhile by hand
/// or by `rig` is never overwritten. Written to a temporary file and renamed
/// into place so a crash mid-write never leaves a truncated spec.
#[tauri::command]
pub async fn rig_spec_write(folder: String, text: String, expected: String) -> Result<(), String> {
    let path = spec_path(&folder)?;
    let current = std::fs::read_to_string(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    if current != expected {
        return Err(format!(
            "{} changed while it was being updated; left as it is",
            path.display()
        ));
    }
    let tmp = path.with_extension("yaml.workbench-tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("could not replace {}: {e}", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_relative_and_parent_paths() {
        assert!(spec_path("rigs/workbench").is_err());
        assert!(spec_path("/mnt/e/rigs/../etc").is_err());
        assert!(spec_path("/mnt/e/rigs/workbench/").is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn maps_wsl_paths_to_windows() {
        assert_eq!(
            spec_path("/mnt/e/rigs/workbench").unwrap(),
            PathBuf::from(r"E:\rigs\workbench\rig.yaml")
        );
        let home = spec_path("/home/me/rig").unwrap();
        assert!(home.to_string_lossy().starts_with(r"\\wsl.localhost\"));
        assert!(home.to_string_lossy().ends_with(r"home\me\rig\rig.yaml"));
    }

    /// A scratch folder, and the path the daemon would use for it.
    fn scratch_folder() -> (PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("rig-spec-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let native = dir.to_string_lossy().to_string();
        let folder = if cfg!(windows) {
            // C:\Users\me\Temp\x -> /mnt/c/Users/me/Temp/x
            let (drive, rest) = native.split_once(":\\").unwrap();
            format!("/mnt/{}/{}", drive.to_ascii_lowercase(), rest.replace('\\', "/"))
        } else {
            native
        };
        (dir, folder)
    }

    #[test]
    fn writes_only_when_unchanged() {
        let (dir, folder) = scratch_folder();
        std::fs::write(dir.join(SPEC_FILE), "a: 1\n").unwrap();
        let read = |f: &str| tauri::async_runtime::block_on(rig_spec_read(f.to_string()));
        let write = |text: &str, expected: &str| {
            tauri::async_runtime::block_on(rig_spec_write(folder.clone(), text.into(), expected.into()))
        };
        assert_eq!(read(&folder).unwrap(), "a: 1\n");
        assert!(write("a: 2\n", "stale\n").is_err());
        assert_eq!(read(&folder).unwrap(), "a: 1\n");
        write("a: 2\n", "a: 1\n").unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(SPEC_FILE)).unwrap(), "a: 2\n");
        assert!(!dir.join("rig.yaml.workbench-tmp").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
