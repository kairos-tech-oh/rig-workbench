import { useState } from "react";
import { EDGE_KINDS, addEdge, removeEdge } from "./api";

const readingOf = (kind: string) => EDGE_KINDS.find((k) => k.kind === kind)?.reads ?? kind;

interface ConnectProps {
  rigId: string;
  rigFolder: string;
  from: string;
  to: string;
  onClose: () => void;
  /** Called with the chosen kind once the daemon has created the edge. */
  onConnected: (kind: string) => void;
}

/** Shown after drawing a line between two tiles: choose what the connection means. */
export function ConnectPanel({ rigId, rigFolder, from, to, onClose, onConnected }: ConnectProps) {
  const [kind, setKind] = useState(EDGE_KINDS[0].kind);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await addEdge(rigId, from, to, kind, rigFolder);
      onConnected(kind);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <aside className="panel panel--compact nowheel">
      <header className="panel__header">
        <span>New connection</span>
        <button className="panel__close" onClick={onClose} disabled={busy} title="Cancel">×</button>
      </header>
      <div className="panel__body">
        <label className="field">
          <span>Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)} autoFocus>
            {EDGE_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>{k.kind}</option>
            ))}
          </select>
        </label>
        <p className="panel__sentence">
          <strong>{from}</strong> {readingOf(kind)} <strong>{to}</strong>
        </p>
        {error && <p className="panel__error">{error}</p>}
      </div>
      <footer className="panel__footer">
        <button className="btn btn--primary" onClick={connect} disabled={busy}>
          {busy ? "Connecting…" : "Connect"}
        </button>
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
      </footer>
    </aside>
  );
}

interface EdgeProps {
  rigId: string;
  rigFolder: string;
  edgeId: string;
  from: string;
  to: string;
  kind: string;
  onClose: () => void;
  onRemoved: () => void;
}

/** Shown when a line is clicked: what it means, and a way to remove it. */
export function EdgePanel({ rigId, rigFolder, edgeId, from, to, kind, onClose, onRemoved }: EdgeProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    if (!confirming) return setConfirming(true);
    setBusy(true);
    setError(null);
    try {
      await removeEdge(rigId, { id: edgeId, from, to, kind }, rigFolder);
      onRemoved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <aside className="panel panel--compact nowheel">
      <header className="panel__header">
        <span>Connection</span>
        <button className="panel__close" onClick={onClose} disabled={busy} title="Close">×</button>
      </header>
      <div className="panel__body">
        <p className="panel__sentence">
          <strong>{from}</strong> {readingOf(kind)} <strong>{to}</strong>
        </p>
        <p className="panel__note">
          Drag either end of the line to another side or corner to move it, or onto another tile to
          reconnect it.
        </p>
        {error && <p className="panel__error">{error}</p>}
      </div>
      <footer className="panel__footer">
        <button className="btn btn--danger-outline" onClick={remove} disabled={busy}>
          {busy ? "Removing…" : confirming ? "Confirm remove" : "Remove connection"}
        </button>
      </footer>
    </aside>
  );
}
