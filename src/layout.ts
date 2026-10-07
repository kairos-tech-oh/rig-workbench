import { invoke } from "@tauri-apps/api/core";

/**
 * What Rig Workbench remembers about a rig, stored by the backend as one JSON
 * file per rig name. Keyed by logical id (`pod.member`), which stays the same
 * when a seat is replaced or the rig is re-created.
 */
export interface SavedLayout {
  version: 1;
  positions: Record<string, { x: number; y: number }>;
  viewport?: { x: number; y: number; zoom: number };
  openTerminals?: string[];
  /** Folder holding the rig spec; resolves `local:` agent refs when adding seats. */
  rigFolder?: string;
}

export function emptyLayout(): SavedLayout {
  return { version: 1, positions: {} };
}

export async function loadLayout(rigName: string): Promise<SavedLayout> {
  const saved = await invoke<SavedLayout | null>("layout_load", { rigName });
  if (!saved || saved.version !== 1) return emptyLayout();
  return { ...emptyLayout(), ...saved };
}

export function saveLayout(rigName: string, layout: SavedLayout): Promise<void> {
  return invoke("layout_save", { rigName, layout });
}
