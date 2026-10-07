import { useState } from "react";
import {
  addSeat,
  relaunchSeatFresh,
  removeSeat,
  setSeatModel,
  splitLogicalId,
  type MemberConfig,
  type Seat,
} from "./api";

/** Suggestions only; any model id the runtime accepts can be typed. */
const KNOWN_MODELS = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-fable-5-1",
  "claude-haiku-4-5-20251001",
];
const RUNTIMES = ["claude-code", "codex"];
const MEMBER_ID = /^[a-z0-9][a-z0-9_-]*$/i;

export interface RoleOption {
  agentRef: string;
  label: string;
}

interface Common {
  rigId: string;
  roles: RoleOption[];
  rigFolder: string;
  onRigFolderChange: (folder: string) => void;
  onClose: () => void;
  /** Called after a successful change, with a summary for the status line. */
  onChanged: (message: string) => void;
}

type Props =
  | (Common & { mode: "add"; pods: string[] })
  | (Common & { mode: "edit"; seat: Seat; onRemoved: (logicalId: string) => void });

type Confirming = "replace" | "remove" | null;

export function SeatPanel(props: Props) {
  const seat = props.mode === "edit" ? props.seat : null;
  const original = seat && splitLogicalId(seat.logicalId);

  const [pod, setPod] = useState(original?.pod ?? (props.mode === "add" ? props.pods[0] ?? "" : ""));
  const [memberId, setMemberId] = useState(original?.member ?? "");
  const [runtime, setRuntime] = useState(seat?.runtime ?? "claude-code");
  const [model, setModel] = useState(seat?.model ?? "claude-opus-5-5");
  const [cwd, setCwd] = useState(seat?.cwd ?? "");
  const [agentRef, setAgentRef] = useState(seat?.agentRef ?? props.roles[0]?.agentRef ?? "");
  const [restartNow, setRestartNow] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const structuralChange =
    !!seat && (cwd !== (seat.cwd ?? "") || runtime !== seat.runtime || agentRef !== (seat.agentRef ?? ""));
  const modelChange = !!seat && model !== (seat.model ?? "");

  const member = (): MemberConfig => ({
    id: memberId.trim(),
    runtime,
    agentRef,
    profile: seat?.profile ?? "default",
    cwd: cwd.trim(),
    model: model.trim(),
  });

  const validationError = (): string | null => {
    if (!pod) return "Choose a pod.";
    if (!MEMBER_ID.test(memberId.trim())) return "Seat name: letters, digits, - and _ only.";
    if (!cwd.trim()) return "Working directory is required.";
    if (!agentRef) return "Choose a role.";
    if (agentRef.startsWith("local:") && !props.rigFolder.trim()) {
      return "Rig folder is required to resolve this role.";
    }
    return null;
  };

  const run = async (label: string, action: () => Promise<string>) => {
    setError(null);
    setBusy(label);
    try {
      props.onChanged(await action());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };

  const submitAdd = () => {
    const invalid = validationError();
    if (invalid) return setError(invalid);
    const logicalId = `${pod}.${memberId.trim()}`;
    run(`Adding ${logicalId} and starting it…`, async () => {
      await addSeat(props.rigId, pod, member(), props.rigFolder.trim());
      props.onClose();
      return `Added ${logicalId}.`;
    });
  };

  const submitEdit = () => {
    if (!seat) return;
    if (structuralChange) {
      const invalid = validationError();
      if (invalid) return setError(invalid);
      if (confirming !== "replace") return setConfirming("replace");
      run(`Replacing ${seat.logicalId}…`, async () => {
        await removeSeat(props.rigId, seat.logicalId);
        try {
          await addSeat(props.rigId, pod, member(), props.rigFolder.trim());
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          throw new Error(`${seat.logicalId} was removed but could not be added back: ${reason}`);
        }
        return `Replaced ${seat.logicalId} with a fresh seat.`;
      });
      return;
    }
    if (!modelChange && !restartNow) return props.onClose();
    run(restartNow ? `Restarting ${seat.logicalId}…` : "Saving…", async () => {
      if (modelChange) await setSeatModel(seat.canonicalSessionName, model.trim());
      if (restartNow) await relaunchSeatFresh(seat.canonicalSessionName);
      if (restartNow) return `Restarted ${seat.logicalId} fresh${modelChange ? ` on ${model}` : ""}.`;
      return `${seat.logicalId} will use ${model} from its next launch.`;
    });
  };

  const submitRemove = () => {
    if (!seat || props.mode !== "edit") return;
    if (confirming !== "remove") return setConfirming("remove");
    run(`Removing ${seat.logicalId}…`, async () => {
      await removeSeat(props.rigId, seat.logicalId);
      props.onRemoved(seat.logicalId);
      return `Removed ${seat.logicalId}.`;
    });
  };

  const roleOptions = props.roles.some((r) => r.agentRef === agentRef) || !agentRef
    ? props.roles
    : [...props.roles, { agentRef, label: agentRef }];

  return (
    <aside className="panel nowheel">
      <header className="panel__header">
        <span>{seat ? seat.logicalId : "Add seat"}</span>
        <button className="panel__close" onClick={props.onClose} disabled={!!busy} title="Close">
          ×
        </button>
      </header>

      <div className="panel__body">
        <label className="field">
          <span>Pod</span>
          {props.mode === "add" ? (
            <select value={pod} onChange={(e) => setPod(e.target.value)}>
              {props.pods.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          ) : (
            <input value={pod} disabled />
          )}
        </label>

        <label className="field">
          <span>Seat name</span>
          <input
            value={memberId}
            onChange={(e) => setMemberId(e.target.value)}
            disabled={props.mode === "edit"}
            placeholder="e.g. workbench"
          />
        </label>

        <label className="field">
          <span>Model</span>
          <input list="known-models" value={model} onChange={(e) => setModel(e.target.value)} />
          <datalist id="known-models">
            {KNOWN_MODELS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>

        <label className="field">
          <span>Working directory</span>
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/mnt/e/my-project"
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span>Role</span>
          <select value={agentRef} onChange={(e) => setAgentRef(e.target.value)}>
            {roleOptions.map((r) => (
              <option key={r.agentRef} value={r.agentRef}>{r.label}</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Runtime</span>
          <select value={runtime} onChange={(e) => setRuntime(e.target.value)}>
            {RUNTIMES.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>

        {(props.mode === "add" || structuralChange) && (
          <label className="field">
            <span>Rig folder (for roles)</span>
            <input
              value={props.rigFolder}
              onChange={(e) => props.onRigFolderChange(e.target.value)}
              placeholder="/mnt/e/rigs/my-rig"
              spellCheck={false}
            />
          </label>
        )}

        {seat && !structuralChange && (
          <label className="field field--check">
            <input type="checkbox" checked={restartNow} onChange={(e) => setRestartNow(e.target.checked)} />
            <span>Restart now with a fresh conversation{modelChange ? " (applies the model)" : ""}</span>
          </label>
        )}

        {seat && modelChange && !restartNow && !structuralChange && (
          <p className="panel__note">The new model takes effect the next time this seat launches.</p>
        )}
        {structuralChange && (
          <p className="panel__note panel__note--warn">
            Changing the working directory, role or runtime replaces this seat. Its current
            conversation ends and a fresh one starts.
          </p>
        )}
        {error && <p className="panel__error">{error}</p>}
        {busy && <p className="panel__busy">{busy}</p>}
      </div>

      <footer className="panel__footer">
        {props.mode === "add" ? (
          <button className="btn btn--primary" onClick={submitAdd} disabled={!!busy}>
            Add seat
          </button>
        ) : (
          <>
            <button
              className={`btn ${confirming === "replace" ? "btn--danger" : "btn--primary"}`}
              onClick={submitEdit}
              disabled={!!busy}
            >
              {confirming === "replace" ? "Confirm replace" : structuralChange ? "Replace seat" : "Save"}
            </button>
            <button className="btn btn--danger-outline" onClick={submitRemove} disabled={!!busy}>
              {confirming === "remove" ? "Confirm remove" : "Remove"}
            </button>
          </>
        )}
      </footer>
    </aside>
  );
}
