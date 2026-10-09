import { useEffect, useState } from "react";
import { relaunchSeatFresh, rigDown, rigUp, type RigSummary, type SeatUpResult } from "./api";

interface Props {
  rig: RigSummary | null;
  /** Seats currently working, for the stop confirmation. */
  working: number;
  /** Seats with an attached terminal, for the stop confirmation. */
  attached: number;
  /** A seat's tmux session, to start one fresh that could not resume. */
  sessionFor: (logicalId: string) => string | null;
  /** Called once an attempt ends, with a summary for the status line when it succeeded. */
  onChanged: (message: string | null, cameUp: boolean) => void;
  onError: (message: string) => void;
}

/** "5 resumed, 1 awaiting-decision", from each seat's outcome. */
function outcomes(nodes: SeatUpResult[]): string {
  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  return [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(", ");
}

/**
 * Start or stop the selected rig, next to the rig dropdown. Stopping ends
 * every seat's session (`rig down`); OpenRig snapshots the rig first, and
 * starting brings it back with each seat's conversation (`rig up --existing`).
 * A seat whose conversation can't be resumed is left for the user to start
 * fresh. The daemon keeps running either way.
 */
export function RigPower({ rig, working, attached, sessionFor, onChanged, onError }: Props) {
  const [busy, setBusy] = useState<"starting" | "stopping" | "fresh" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [waiting, setWaiting] = useState<SeatUpResult[]>([]);
  const [since, setSince] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - since) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy, since]);

  // A different rig cancels a pending confirmation or decision.
  useEffect(() => {
    setConfirming(false);
    setWaiting([]);
  }, [rig?.id]);
  useEffect(() => setConfirming(false), [rig?.lifecycleState]);

  if (!rig) return null;
  // `rig up --existing` refuses while any seat is live, so only a rig with no
  // running seat offers Start.
  const live = rig.lifecycleState !== "stopped" && rig.lifecycleState !== "recoverable";

  const begin = (kind: "starting" | "stopping" | "fresh") => {
    setConfirming(false);
    setBusy(kind);
    setSince(Date.now());
    setElapsed(0);
  };

  const start = async () => {
    begin("starting");
    setWaiting([]);
    try {
      const result = await rigUp(rig.name);
      const nodes = result.nodes ?? [];
      if (!result.status || result.error) {
        throw new Error(result.message ?? result.error ?? JSON.stringify(result));
      }
      setWaiting(nodes.filter((n) => n.status === "awaiting-decision"));
      onChanged(`Started ${rig.name}${nodes.length ? `: ${outcomes(nodes)}` : ""}.`, true);
    } catch (e) {
      onError(`Could not start ${rig.name}: ${e instanceof Error ? e.message : e}`);
      onChanged(null, true);
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    begin("stopping");
    setWaiting([]);
    try {
      const result = await rigDown(rig.name);
      const problems = [...(result.errors ?? []), ...(result.error ? [result.message ?? result.error] : [])];
      if (problems.length) throw new Error(problems.join("; "));
      onChanged(`Stopped ${rig.name}. Start brings its seats back with their conversations.`, false);
    } catch (e) {
      onError(`Could not stop ${rig.name}: ${e instanceof Error ? e.message : e}`);
      onChanged(null, false);
    } finally {
      setBusy(null);
    }
  };

  const startFresh = async () => {
    const seats = waiting;
    begin("fresh");
    const failed: string[] = [];
    for (const seat of seats) {
      const session = sessionFor(seat.logicalId);
      try {
        if (!session) throw new Error("no session name");
        await relaunchSeatFresh(session);
      } catch (e) {
        failed.push(`${seat.logicalId}: ${e instanceof Error ? e.message : e}`);
      }
    }
    setWaiting([]);
    setBusy(null);
    if (failed.length) onError(`Could not start fresh: ${failed.join("; ")}`);
    onChanged(failed.length ? null : `Started ${seats.map((s) => s.logicalId).join(", ")} fresh.`, true);
  };

  if (busy) {
    const doing = busy === "starting" ? "Starting" : busy === "stopping" ? "Stopping" : "Starting seats fresh in";
    return (
      <span className="rig-power rig-power--busy">
        {doing} {rig.name}… {elapsed}s
      </span>
    );
  }

  if (confirming) {
    const notes = [
      working > 0 && `${working} ${working === 1 ? "seat is" : "seats are"} working`,
      attached > 0 && `${attached} attached ${attached === 1 ? "terminal" : "terminals"} will detach`,
    ].filter(Boolean);
    return (
      <span className="rig-power rig-power--confirm" role="alertdialog">
        <span>
          Stop all {rig.nodeCount} seats of <strong>{rig.name}</strong>? Their sessions end
          {notes.length > 0 ? ` (${notes.join("; ")})` : ""}. Start brings them back.
        </span>
        <button className="btn btn--danger" onClick={stop}>
          Stop rig
        </button>
        <button className="btn" onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </span>
    );
  }

  if (waiting.length > 0) {
    return (
      <span className="rig-power rig-power--confirm" role="alertdialog">
        <span title={waiting.map((w) => `${w.logicalId}: ${w.error ?? w.status}`).join("\n")}>
          {waiting.map((w) => w.logicalId).join(", ")} could not resume {waiting.length === 1 ? "its" : "their"}{" "}
          conversation and {waiting.length === 1 ? "was" : "were"} not started.
        </span>
        <button className="btn btn--primary" onClick={startFresh}>
          Start fresh
        </button>
        <button className="btn" onClick={() => setWaiting([])}>
          Leave stopped
        </button>
      </span>
    );
  }

  return (
    <span className="rig-power">
      <span className={`rig-power__dot rig-power__dot--${rig.lifecycleState}`} title={rig.lifecycleState} />
      {live ? (
        <button className="btn" onClick={() => setConfirming(true)} title={`Stop every seat of ${rig.name} (rig down)`}>
          Stop
        </button>
      ) : (
        <button
          className="btn btn--primary"
          onClick={start}
          title={`Bring ${rig.name} back, resuming its seats (rig up --existing)`}
        >
          Start
        </button>
      )}
    </span>
  );
}
