import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { UpdatesSection } from "./updates";

export interface Settings {
  backgroundOpacity: number; // 0–100, the canvas backdrop only
  /** Start the daemon with its kernel (operator and advisor), not `--no-kernel`. */
  startKernel: boolean;
}

const DEFAULTS: Settings = { backgroundOpacity: 100, startKernel: false };

async function loadSettings(): Promise<Settings> {
  const saved = await invoke<Partial<Settings> | null>("settings_load").catch(() => null);
  return { ...DEFAULTS, ...saved };
}

function applySettings(settings: Settings) {
  document.documentElement.style.setProperty("--backdrop-opacity", String(settings.backgroundOpacity / 100));
}

export const openSettingsWindow = () => invoke("settings_open").catch((e) => console.warn("could not open settings", e));

/** Main window: apply saved settings at launch and whenever the settings window changes them. */
export function useAppliedSettings() {
  useEffect(() => {
    loadSettings().then(applySettings);
    const unlisten = listen<Settings>("settings-changed", (event) => applySettings({ ...DEFAULTS, ...event.payload }));
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);
}

export function SettingsWindow() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  const update = (next: Settings) => {
    setSettings(next);
    invoke("settings_save", { settings: next }).then(
      () => setError(null),
      (e) => setError(String(e)),
    );
  };

  if (!settings) return null;
  return (
    <main className="settings">
      <label className="settings__row">
        <span>Background opacity</span>
        <input
          type="range"
          min={0}
          max={100}
          value={settings.backgroundOpacity}
          onChange={(event) => update({ ...settings, backgroundOpacity: Number(event.target.value) })}
        />
        <span className="settings__value">{settings.backgroundOpacity}%</span>
      </label>
      <p className="settings__hint">Only the canvas backdrop fades; seats and connections stay solid.</p>
      {error && <p className="settings__error">{error}</p>}
      <DaemonSection
        startKernel={settings.startKernel}
        onStartKernelChange={(startKernel) => update({ ...settings, startKernel })}
      />
      <UpdatesSection />
    </main>
  );
}

interface DaemonHealth {
  running: boolean;
  version: string | null;
  pid: number | null;
  url: string;
}

const HEALTH_POLL_MS = 3000;

/** The Settings window's Daemon section: whether it runs, and a button to start it. */
function DaemonSection({
  startKernel,
  onStartKernelChange,
}: {
  startKernel: boolean;
  onStartKernelChange: (value: boolean) => void;
}) {
  const [health, setHealth] = useState<DaemonHealth | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const poll = useCallback(() => invoke<DaemonHealth>("daemon_health").then(setHealth, () => {}), []);

  useEffect(() => {
    poll();
    const timer = setInterval(poll, HEALTH_POLL_MS);
    return () => clearInterval(timer);
  }, [poll]);

  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  const start = async () => {
    setError(null);
    setOutput(null);
    setElapsed(0);
    setStartedAt(Date.now());
    try {
      const said = await invoke<string>("daemon_start", { withKernel: startKernel });
      setOutput(said.split("\n").filter(Boolean).slice(-3).join("\n") || "Daemon started.");
    } catch (e) {
      setError(String(e));
    } finally {
      setStartedAt(null);
      poll();
    }
  };

  const starting = startedAt !== null;
  return (
    <section className="settings__section">
      <h2 className="settings__heading">OpenRig daemon</h2>
      <p className={`settings__daemon ${health?.running ? "settings__daemon--up" : ""}`}>
        {health === null
          ? "Checking…"
          : health.running
            ? `Running${health.version ? ` · ${health.version}` : ""}${health.pid ? ` · pid ${health.pid}` : ""}`
            : starting
              ? `Starting… ${elapsed}s`
              : `Stopped (nothing answers at ${health.url})`}
      </p>
      {!health?.running && (
        <>
          <label className="settings__check">
            <input
              type="checkbox"
              checked={startKernel}
              disabled={starting}
              onChange={(event) => onStartKernelChange(event.target.checked)}
            />
            Also start the kernel (OpenRig's operator and advisor seats)
          </label>
          <button className="btn btn--primary" onClick={start} disabled={starting || health === null}>
            {starting ? "Starting…" : "Start daemon"}
          </button>
          <p className="settings__hint">
            Runs <code>rig daemon start</code>
            {startKernel ? "" : " --no-kernel"}
            {navigator.userAgent.includes("Windows") ? " inside WSL" : ""}.
          </p>
        </>
      )}
      {output && <pre className="settings__output">{output}</pre>}
      {error && <p className="settings__error">{error}</p>}
    </section>
  );
}
