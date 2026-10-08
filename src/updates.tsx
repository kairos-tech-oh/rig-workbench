import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Keeping the app current. The check, the download and the signature check
 * all happen in Rust (`src-tauri/src/updates.rs`); this only asks and reports.
 */

export interface UpdateInfo {
  version: string;
  current: string;
  notes: string;
  date: string;
}

type CheckState = "idle" | "checking" | "latest" | "failed";

export function useUpdates() {
  const [version, setVersion] = useState<string | null>(null);
  const [found, setFound] = useState<UpdateInfo | null>(null);
  const [check, setCheck] = useState<CheckState>("idle");
  const [error, setError] = useState<string | null>(null);

  const checkNow = useCallback(async () => {
    setCheck("checking");
    setError(null);
    try {
      const update = await invoke<UpdateInfo | null>("update_check");
      setFound(update);
      setCheck(update ? "idle" : "latest");
    } catch (e) {
      setError(String(e));
      setCheck("failed");
    }
  }, []);

  useEffect(() => {
    invoke<string>("app_version").then(setVersion, () => {});
    // Checked once a launch, and only in a release build: a development build
    // is always "older" than the latest release and would ask every time.
    if (!import.meta.env.PROD) return;
    invoke<UpdateInfo | null>("update_check").then(setFound, (e) => console.warn("update check failed", e));
  }, []);

  return { version, found, check, error, checkNow, dismiss: () => setFound(null) };
}

/** The app's version in the toolbar; clicking it checks for an update. */
export function VersionButton({ updates }: { updates: ReturnType<typeof useUpdates> }) {
  const { version, check, error, checkNow } = updates;
  if (!version) return null;
  const label =
    check === "checking" ? "Checking…" : check === "latest" ? `v${version} · up to date` : `v${version}`;
  return (
    <button
      className="toolbar__version"
      onClick={checkNow}
      disabled={check === "checking"}
      title={check === "failed" ? error ?? "" : "Check for updates"}
    >
      {label}
      {check === "failed" && <span className="toolbar__version-failed"> · check failed</span>}
    </button>
  );
}

/** Shown under the toolbar when a newer release is available. */
export function UpdateBanner({ updates }: { updates: ReturnType<typeof useUpdates> }) {
  const { found, dismiss } = updates;
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(false);
  if (!found) return null;

  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      // Restarts the app on success, so this only returns on failure.
      await invoke("update_install");
    } catch (e) {
      setError(String(e));
      setInstalling(false);
    }
  };

  return (
    <div className="update" role="status">
      <span>
        Rig Workbench <strong>{found.version}</strong> is available (this is {found.current}). Installing
        restarts the app; seats keep running.
        {found.notes && (
          <button className="update__link" onClick={() => setShowNotes(!showNotes)}>
            {showNotes ? "Hide" : "What's new"}
          </button>
        )}
      </span>
      <span className="update__actions">
        <button className="btn btn--primary" onClick={install} disabled={installing}>
          {installing ? "Downloading…" : "Install and restart"}
        </button>
        <button className="btn" onClick={dismiss} disabled={installing}>
          Later
        </button>
      </span>
      {showNotes && <pre className="update__notes">{found.notes}</pre>}
      {error && <p className="update__error">{error}</p>}
    </div>
  );
}
