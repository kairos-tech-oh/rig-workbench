import { Channel, invoke } from "@tauri-apps/api/core";
import { updateRigSpec } from "./rigSpec";

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
  agentRef: string | null;
  profile: string | null;
  resolvedSpecName: string | null;
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

/** The pod a seat belongs to, and its member id within the pod. */
export function splitLogicalId(logicalId: string): { pod: string; member: string } {
  const dot = logicalId.indexOf(".");
  return { pod: logicalId.slice(0, dot), member: logicalId.slice(dot + 1) };
}

export function daemonGet<T>(path: string): Promise<T> {
  return invoke<T>("daemon_get", { path });
}

export const listRigs = () => daemonGet<Rig[]>("/api/rigs");

/** A rig's state, from `/api/rigs/summary`. */
export interface RigSummary {
  id: string;
  name: string;
  nodeCount: number;
  /** running | degraded | attention_required | recoverable | stopped */
  lifecycleState: string;
}

export const listRigSummaries = () => daemonGet<RigSummary[]>("/api/rigs/summary");

/** One seat's outcome in `rig up --json`, e.g. resumed, fresh-primed or awaiting-decision. */
export interface SeatUpResult {
  logicalId: string;
  status: string;
  error?: string;
}

/** What `rig up --json` reports. Fields are optional: a refusal has a different shape. */
export interface RigUpResult {
  status?: string;
  rigResult?: string;
  nodes?: SeatUpResult[];
  error?: string;
  message?: string;
}

/** What `rig down --json` reports. */
export interface RigDownResult {
  sessionsKilled?: number;
  alreadyStopped?: boolean;
  errors?: string[];
  error?: string;
  message?: string;
}

/** Bring a stopped rig back, resuming its seats (`rig up <name> --existing`). */
export const rigUp = (name: string) => invoke<RigUpResult>("rig_up", { name });

/** Stop every seat of a rig (`rig down <name>`); the rig can be brought back. */
export const rigDown = (name: string) => invoke<RigDownResult>("rig_down", { name });

export const listSeats = (rigId: string) =>
  daemonGet<Seat[]>(`/api/rigs/${encodeURIComponent(rigId)}/nodes`);

export async function listEdges(rigId: string): Promise<RigEdge[]> {
  const graph = await daemonGet<{ edges: RigEdge[] }>(
    `/api/rigs/${encodeURIComponent(rigId)}/graph`,
  );
  return graph.edges;
}

export interface OutboxEntry {
  outboxId: string;
  senderSession: string;
  destinationSession: string;
  tsDispatched: string;
}

export const listOutbox = (senderSession: string) =>
  daemonGet<OutboxEntry[]>(
    `/api/queue/outbox/list?senderSession=${encodeURIComponent(senderSession)}&limit=10`,
  );

// ---- Writes ---------------------------------------------------------------

interface WriteResult {
  ok: boolean;
  status: number;
  body: unknown;
}

const REASON = "Changed in Rig Workbench";

/** The daemon's own explanation for a refused write. */
function describeFailure(result: WriteResult): string {
  const body = result.body as Record<string, unknown> | string | null;
  if (typeof body === "string") return body || `HTTP ${result.status}`;
  if (body && typeof body === "object") {
    for (const key of ["message", "error", "guidance"]) {
      if (typeof body[key] === "string") return body[key] as string;
    }
    if (Array.isArray(body.errors)) return body.errors.join("; ");
    return JSON.stringify(body);
  }
  return `HTTP ${result.status}`;
}

async function daemonWrite(method: "POST" | "DELETE", path: string, body?: unknown): Promise<unknown> {
  const result = await invoke<WriteResult>("daemon_write", { method, path, body: body ?? null });
  if (!result.ok) throw new Error(describeFailure(result));
  return result.body;
}

export interface MemberConfig {
  id: string;
  runtime: string;
  agentRef: string;
  profile: string;
  cwd: string;
  model: string;
  /** rig.yaml `permission_policy` for the seat; absent follows the rig's. */
  permissionPolicy?: string;
}

// Each topology write below also updates rig.yaml in the rig folder once the
// daemon has accepted it, so the spec keeps matching the running rig.

/**
 * Add a seat to an existing pod and launch it. `rigRoot` is the rig folder: it
 * resolves `local:` agent refs and holds the rig.yaml the seat is added to (or
 * updated in, when a seat of that name is already declared).
 */
export async function addSeat(rigId: string, pod: string, member: MemberConfig, rigRoot: string) {
  await daemonWrite(
    "POST",
    `/api/rigs/${encodeURIComponent(rigId)}/pods/${encodeURIComponent(pod)}/members`,
    {
      member: {
        id: member.id,
        runtime: member.runtime,
        agent_ref: member.agentRef,
        profile: member.profile,
        cwd: member.cwd,
        ...(member.model ? { model: member.model } : {}),
        ...(member.permissionPolicy ? { permission_policy: member.permissionPolicy } : {}),
      },
      rigRoot,
    },
  );
  await updateRigSpec(rigRoot, {
    op: "upsertMember",
    pod,
    member: {
      id: member.id,
      agent_ref: member.agentRef,
      runtime: member.runtime,
      model: member.model || undefined,
      profile: member.profile,
      cwd: member.cwd,
      permission_policy: member.permissionPolicy,
    },
  });
}

/**
 * Stop a seat and remove it from the rig, and from rig.yaml in `rigFolder`
 * along with its edges. `null` leaves the spec alone: a seat being replaced
 * keeps its entry, which the following `addSeat` updates in place.
 */
export async function removeSeat(rigId: string, logicalId: string, rigFolder: string | null) {
  await daemonWrite(
    "DELETE",
    `/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(logicalId)}`,
  );
  if (rigFolder !== null) await updateRigSpec(rigFolder, { op: "removeMember", logicalId });
}

/** Record a new model. It takes effect the next time the seat launches. */
export function setSeatModel(session: string, model: string) {
  return daemonWrite("POST", `/api/seat/set-model/${encodeURIComponent(session)}`, {
    model,
    reason: REASON,
  });
}

/**
 * Choose how the seat's agent is launched from its next launch on: `floor`,
 * `auto`, `full_bypass`, or `inherit`. Running agents are not changed.
 */
export function setSeatPermissions(session: string, mode: string) {
  // The daemon wants to know who asked; the app is not a seat, so it names itself.
  return daemonWrite("POST", `/api/seat/set-permissions/${encodeURIComponent(session)}`, {
    mode,
    reason: REASON,
    operator: "rig-workbench",
  });
}

/** How the seat's agent is launched now, as the daemon reports it. */
export interface SeatPermissions {
  effectiveMode: string | null;
  source: string | null;
}

export async function seatPermissions(session: string): Promise<SeatPermissions> {
  const status = await daemonGet<{ permissions?: { effective?: SeatPermissions } }>(
    `/api/seat/status/${encodeURIComponent(session)}`,
  );
  return status.permissions?.effective ?? { effectiveMode: null, source: null };
}

/** Stop the seat and launch it again with a fresh conversation. */
export function relaunchSeatFresh(session: string) {
  return daemonWrite("POST", `/api/seat/launch/${encodeURIComponent(session)}`, {
    fresh: true,
    stop: true,
    reason: REASON,
  });
}

/** Edge kinds the daemon accepts, with a plain-language reading of each. */
export const EDGE_KINDS: { kind: string; reads: string }[] = [
  { kind: "delegates_to", reads: "hands work to" },
  { kind: "can_observe", reads: "can watch" },
  { kind: "collaborates_with", reads: "works alongside" },
  { kind: "escalates_to", reads: "escalates to" },
  { kind: "spawned_by", reads: "was started by" },
];

/** Connect two seats (logical ids). Needs a daemon with the edge routes. */
export async function addEdge(rigId: string, from: string, to: string, kind: string, rigFolder: string) {
  await daemonWrite("POST", `/api/rigs/${encodeURIComponent(rigId)}/edges`, { from, to, kind });
  await updateRigSpec(rigFolder, { op: "addEdge", from, to, kind });
}

/** Disconnect two seats. `from`, `to` and `kind` find the edge in rig.yaml. */
export async function removeEdge(
  rigId: string,
  edge: { id: string; from: string; to: string; kind: string },
  rigFolder: string,
) {
  await daemonWrite(
    "DELETE",
    `/api/rigs/${encodeURIComponent(rigId)}/edges/${encodeURIComponent(edge.id)}`,
  );
  await updateRigSpec(rigFolder, { op: "removeEdge", from: edge.from, to: edge.to, kind: edge.kind });
}

// ---- Event stream -----------------------------------------------------------

export interface DaemonEvent {
  type: string;
  seq: number;
  /** UTC, formatted `YYYY-MM-DD HH:MM:SS`. */
  createdAt: string;
  [key: string]: unknown;
}

type Listener = (event: DaemonEvent) => void;
const listeners = new Set<Listener>();
let subscribed = false;

/** Listen to the daemon's event feed. The first listener opens the stream. */
export function onDaemonEvent(listener: Listener): () => void {
  listeners.add(listener);
  if (!subscribed) {
    subscribed = true;
    const channel = new Channel<string>();
    channel.onmessage = (raw) => {
      let event: DaemonEvent;
      try {
        event = JSON.parse(raw);
      } catch {
        return;
      }
      for (const l of listeners) l(event);
    };
    invoke("events_subscribe", { onEvent: channel }).catch((error) => {
      subscribed = false;
      console.warn("event stream unavailable:", error);
    });
  }
  return () => listeners.delete(listener);
}

/** Milliseconds since the event happened. Replayed history is old. */
export function eventAge(event: DaemonEvent): number {
  return Date.now() - Date.parse(event.createdAt.replace(" ", "T") + "Z");
}
