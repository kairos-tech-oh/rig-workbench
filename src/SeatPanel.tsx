import { useEffect, useState } from "react";
import {
  addSeat,
  relaunchSeatFresh,
  removeSeat,
  seatPermissions,
  setSeatModel,
  setSeatPermissions,
  splitLogicalId,
  type MemberConfig,
  type Seat,
  type SeatPermissions,
} from "./api";
import {
  LABEL,
  POLICY,
  effectiveMode,
  hasLaunchMode,
  liveSelection,
  modeOf,
  modesFor,
  type LaunchMode,
  type SeatLaunchMode,
} from "./launchMode";
import { updateRigSpec, type SpecPolicies } from "./rigSpec";

import modelCatalog from "./models.json";

interface ModelOption {
  id: string;
  label: string;
}

/** Models offered per runtime. Edit models.json as providers release new ones. */
const MODELS: Record<string, ModelOption[]> = modelCatalog;
const RUNTIMES = Object.keys(MODELS);
const CUSTOM = "__custom__";

/** Where the daemon's next-launch mode comes from, in words. */
const SOURCE: Record<string, string> = {
  explicit: "set for this seat",
  member_spec: "this seat in rig.yaml",
  rig_spec: "the rig's default",
  system_default: "OpenRig's default",
};
const MEMBER_ID = /^[a-z0-9][a-z0-9_-]*$/i;

const modelsFor = (runtime: string): ModelOption[] => MODELS[runtime] ?? [];
const isListed = (runtime: string, model: string) => modelsFor(runtime).some((m) => m.id === model);

/** A dropdown of the runtime's models, with "Custom…" for any other model id. */
function ModelSelect(props: { runtime: string; value: string; onChange: (model: string) => void }) {
  const options = modelsFor(props.runtime);
  const [custom, setCustom] = useState(!!props.value && !isListed(props.runtime, props.value));
  const showCustom = custom || options.length === 0;

  return (
    <>
      {options.length > 0 && (
        <select
          value={showCustom ? CUSTOM : props.value}
          onChange={(e) => {
            if (e.target.value === CUSTOM) {
              setCustom(true);
            } else {
              setCustom(false);
              props.onChange(e.target.value);
            }
          }}
        >
          {options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} ({m.id})
            </option>
          ))}
          <option value={CUSTOM}>Custom…</option>
        </select>
      )}
      {showCustom && (
        <input
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder="model id"
          spellCheck={false}
        />
      )}
    </>
  );
}

export interface RoleOption {
  agentRef: string;
  label: string;
}

interface Common {
  rigId: string;
  roles: RoleOption[];
  rigFolder: string;
  onRigFolderChange: (folder: string) => void;
  /** Launch policies from rig.yaml; null while loading or when it can't be read. */
  policies: SpecPolicies | null;
  /** Change the rig-wide default launch mode (Standard or Auto, never Skip). */
  onRigDefaultChange: (mode: LaunchMode) => Promise<string>;
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

  // Launch mode: the seat's own policy in rig.yaml, or the rig's default when it has none.
  const rigDefault: LaunchMode = modeOf(props.policies?.rig) ?? "standard";
  const ownPolicy = seat ? props.policies?.members[seat.logicalId] : undefined;
  // null: a policy this app doesn't set (a custom file, locked, open); it is left as it is.
  const initialLaunch: SeatLaunchMode | null = ownPolicy === undefined ? "rig" : modeOf(ownPolicy);
  const [launch, setLaunch] = useState<SeatLaunchMode | null>(initialLaunch);
  const [skipConfirmed, setSkipConfirmed] = useState(false);
  const [nextLaunch, setNextLaunch] = useState<SeatPermissions | null>(null);
  const launchChange = !!seat && launch !== initialLaunch;
  const choosingSkip = launch === "skip" && initialLaunch !== "skip";
  const ownPolicyFor = (mode: SeatLaunchMode | null) => (mode === null || mode === "rig" ? undefined : POLICY[mode]);

  useEffect(() => {
    if (!seat || !hasLaunchMode(seat.runtime)) return;
    seatPermissions(seat.canonicalSessionName).then(
      (p) => setNextLaunch(p),
      () => {},
    );
  }, [seat?.canonicalSessionName]);

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
    permissionPolicy: hasLaunchMode(runtime) ? ownPolicyFor(launch) : undefined,
  });

  /** Record the seat's launch mode: in rig.yaml, and with the daemon for its next launch. */
  const applyLaunch = async (target: Seat) => {
    if (launch === null) return;
    await setSeatPermissions(target.canonicalSessionName, liveSelection(launch, rigDefault, runtime));
    await updateRigSpec(props.rigFolder, {
      op: "setMemberPolicy",
      logicalId: target.logicalId,
      policy: ownPolicyFor(launch) ?? null,
    });
  };

  const validationError = (): string | null => {
    if (!pod) return "Choose a pod.";
    if (!MEMBER_ID.test(memberId.trim())) return "Seat name: letters, digits, - and _ only.";
    if (!model.trim()) return "Choose a model.";
    if (!cwd.trim()) return "Working directory is required.";
    if (!agentRef) return "Choose a role.";
    if (choosingSkip && !skipConfirmed) return "Tick the box to confirm skipping permission checks for this seat.";
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
        await removeSeat(props.rigId, seat.logicalId, null);
        try {
          await addSeat(props.rigId, pod, member(), props.rigFolder.trim());
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          throw new Error(`${seat.logicalId} was removed but could not be added back: ${reason}`);
        }
        // Back to following the rig: the add above only writes a policy, never removes one.
        if (launchChange && launch === "rig") {
          await updateRigSpec(props.rigFolder, { op: "setMemberPolicy", logicalId: seat.logicalId, policy: null });
        }
        return `Replaced ${seat.logicalId} with a fresh seat.`;
      });
      return;
    }
    if (!modelChange && !launchChange && !restartNow) return props.onClose();
    if (!model.trim()) return setError("Choose a model.");
    if (choosingSkip && !skipConfirmed) return setError(validationError());
    run(restartNow ? `Restarting ${seat.logicalId}…` : "Saving…", async () => {
      if (modelChange) await setSeatModel(seat.canonicalSessionName, model.trim());
      if (launchChange) await applyLaunch(seat);
      const changes = [modelChange && `on ${model}`, launchChange && launch && `in ${describe(launch)}`].filter(Boolean);
      if (restartNow) {
        await relaunchSeatFresh(seat.canonicalSessionName);
        return `Restarted ${seat.logicalId} fresh${changes.length ? ` ${changes.join(", ")}` : ""}.`;
      }
      return `${seat.logicalId} will launch ${changes.join(", ")} from its next launch.`;
    });
  };

  const submitRemove = () => {
    if (!seat || props.mode !== "edit") return;
    if (confirming !== "remove") return setConfirming("remove");
    run(`Removing ${seat.logicalId}…`, async () => {
      await removeSeat(props.rigId, seat.logicalId, props.rigFolder.trim());
      props.onRemoved(seat.logicalId);
      return `Removed ${seat.logicalId}.`;
    });
  };

  /** "Auto", or "the rig default (Standard (accept edits))". */
  const describe = (mode: SeatLaunchMode) =>
    mode === "rig" ? `the rig default (${LABEL[effectiveMode("rig", rigDefault, runtime)]})` : LABEL[mode];

  const changeRigDefault = (mode: LaunchMode) =>
    run(`Setting the rig default to ${LABEL[mode]}…`, () => props.onRigDefaultChange(mode));

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
          <span>Runtime</span>
          <select
            value={runtime}
            onChange={(e) => {
              const next = e.target.value;
              setRuntime(next);
              if (launch !== null && launch !== "rig" && !modesFor(next).includes(launch)) setLaunch("standard");
              // A listed model belongs to its runtime; switch to the new runtime's first.
              if (isListed(runtime, model) || !model) setModel(modelsFor(next)[0]?.id ?? "");
            }}
          >
            {RUNTIMES.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>

        <div className="field">
          <span>Model</span>
          <ModelSelect key={runtime} runtime={runtime} value={model} onChange={setModel} />
        </div>

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

        {hasLaunchMode(runtime) && (
          <div className="field">
            <span>Launch mode</span>
            <select
              value={launch ?? "custom"}
              onChange={(e) => {
                setLaunch(e.target.value as SeatLaunchMode);
                setSkipConfirmed(false);
              }}
              className={launch === "skip" ? "launch-select--danger" : undefined}
            >
              <option value="rig">Rig default: {LABEL[effectiveMode("rig", rigDefault, runtime)]}</option>
              {modesFor(runtime).map((mode) => (
                <option key={mode} value={mode}>
                  {mode === "skip" ? `⚠ ${LABEL.skip} (dangerous)` : LABEL[mode]}
                </option>
              ))}
              {launch === null && (
                <option value="custom" disabled>
                  Custom policy: {ownPolicy} (left as it is)
                </option>
              )}
            </select>
            {launch === "skip" && (
              <div className="launch-danger">
                <p>
                  This seat's agent will run any command and change any file without asking
                  {runtime === "codex" ? ", with full filesystem and network access" : ""}. Only for a seat
                  you trust with that, in a working directory you can afford to lose.
                </p>
                {choosingSkip && (
                  <label className="field--check">
                    <input type="checkbox" checked={skipConfirmed} onChange={(e) => setSkipConfirmed(e.target.checked)} />
                    <span>I understand: {memberId || "this seat"} skips all permission checks.</span>
                  </label>
                )}
              </div>
            )}
            <div className="launch-default">
              <span>Rig default for all seats</span>
              <select
                value={rigDefault}
                disabled={!!busy || !props.policies}
                onChange={(e) => changeRigDefault(e.target.value as LaunchMode)}
                title="Seats set to 'Rig default' launch this way. Skipping permission checks is never a default."
              >
                <option value="standard">{LABEL.standard}</option>
                <option value="auto">{LABEL.auto}</option>
              </select>
            </div>
            {seat && nextLaunch?.effectiveMode && (
              <p className="panel__note">
                The daemon will next launch this seat with <code>{nextLaunch.effectiveMode}</code>
                {nextLaunch.source ? ` (${SOURCE[nextLaunch.source] ?? nextLaunch.source})` : ""}.
              </p>
            )}
            {!props.policies && (
              <p className="panel__note">rig.yaml could not be read, so the current setting is not shown.</p>
            )}
          </div>
        )}

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

        {seat && (modelChange || launchChange) && !restartNow && !structuralChange && (
          <p className="panel__note">
            The new {[modelChange && "model", launchChange && "launch mode"].filter(Boolean).join(" and ")} takes
            effect the next time this seat launches.
          </p>
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
