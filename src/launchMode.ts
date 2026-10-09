/**
 * How a seat's agent is launched, as OpenRig expresses it: a `permission_policy`
 * in rig.yaml, per seat or for the whole rig, and a per-seat selection the
 * running daemon applies to the seat's next launch.
 *
 *   Standard   builtin:standard  claude --permission-mode acceptEdits   (OpenRig's floor)
 *   Auto       builtin:auto      claude --permission-mode auto
 *   Skip       builtin:yolo      claude --dangerously-skip-permissions   (codex: full access)
 *
 * Skipping permission checks is only ever a per-seat choice the user confirms;
 * the rig-wide default offers Standard and Auto only.
 */

export type LaunchMode = "standard" | "auto" | "skip";
/** A seat's own setting: one of the modes, or follow the rig's default. */
export type SeatLaunchMode = LaunchMode | "rig";

export const POLICY: Record<LaunchMode, string> = {
  standard: "builtin:standard",
  auto: "builtin:auto",
  skip: "builtin:yolo",
};

/** The daemon's per-seat selection (`rig seat set-permissions --mode`). */
const LIVE: Record<LaunchMode, string> = {
  standard: "floor",
  auto: "auto",
  skip: "full_bypass",
};

export const LABEL: Record<LaunchMode, string> = {
  standard: "Standard (accept edits)",
  auto: "Auto",
  skip: "Skip all permission checks",
};

/**
 * The mode a policy ref means, or null for one this app doesn't set (a custom
 * policy file, or locked/open), which it leaves alone. No ref means standard.
 */
export function modeOf(policy: string | null | undefined): LaunchMode | null {
  if (!policy || policy === POLICY.standard) return "standard";
  if (policy === POLICY.auto) return "auto";
  if (policy === POLICY.skip) return "skip";
  return null;
}

/** The modes a runtime supports: Codex has no auto mode. */
export function modesFor(runtime: string): LaunchMode[] {
  return runtime === "codex" ? ["standard", "skip"] : ["standard", "auto", "skip"];
}

/** Terminal seats are not agents and take no launch mode. */
export const hasLaunchMode = (runtime: string) => runtime === "claude-code" || runtime === "codex";

/** The mode a seat launches in: its own, else the rig's default where its runtime supports it. */
export function effectiveMode(mode: SeatLaunchMode, rigDefault: LaunchMode, runtime: string): LaunchMode {
  if (mode !== "rig") return mode;
  return modesFor(runtime).includes(rigDefault) ? rigDefault : "standard";
}

/** What the daemon should launch a seat with, given its own setting and the rig's default. */
export function liveSelection(mode: SeatLaunchMode, rigDefault: LaunchMode, runtime: string): string {
  return LIVE[effectiveMode(mode, rigDefault, runtime)];
}
