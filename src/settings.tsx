import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { UpdatesSection } from "./updates";

export interface Settings {
  backgroundOpacity: number; // 0–100, the canvas backdrop only
}

const DEFAULTS: Settings = { backgroundOpacity: 100 };

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
      <UpdatesSection />
    </main>
  );
}
