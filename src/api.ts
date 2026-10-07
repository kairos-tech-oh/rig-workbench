import { invoke } from "@tauri-apps/api/core";

export interface Rig {
  id: string;
  name: string;
}

export interface ActivityState {
  /** Fine-grained state, e.g. `idle-at-prompt`. */
  activity: string;
  /** Short label for display, e.g. `idle`. */
  display: string;
  needsInput: { count: number; reason: string | null } | null;
}

/** One seat, as returned by the daemon's `/api/rigs/:id/nodes`. */
export interface Seat {
  nodeId: string;
  logicalId: string;
  podNamespace: string;
  canonicalSessionName: string;
  runtime: string;
  model: string | null;
  cwd: string | null;
  sessionStatus: string | null;
  startupStatus: string | null;
  lifecycleState: string | null;
  activityState: ActivityState | null;
  pendingWorkCount: number | null;
}

export interface RigEdge {
  id: string;
  source: string;
  target: string;
  label: string;
}

export function daemonGet<T>(path: string): Promise<T> {
  return invoke<T>("daemon_get", { path });
}

export const listRigs = () => daemonGet<Rig[]>("/api/rigs");

export const listSeats = (rigId: string) =>
  daemonGet<Seat[]>(`/api/rigs/${encodeURIComponent(rigId)}/nodes`);

export async function listEdges(rigId: string): Promise<RigEdge[]> {
  const graph = await daemonGet<{ edges: RigEdge[] }>(
    `/api/rigs/${encodeURIComponent(rigId)}/graph`,
  );
  return graph.edges;
}
