import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * How much of each logged-in AI subscription's rate limits is used, under the
 * legend. Read-only: the Rust side reads the logins and asks the providers;
 * only labels, percentages, reset times and plans reach this view.
 */

interface Limit {
  label: string;
  /** 0 to 1. */
  percent: number;
  resetsAt: string;
}

interface Account {
  id: string;
  provider: string;
  label: string;
  plan: string;
  limits: Limit[];
  note: string;
}

interface Sample {
  t: number;
  account: string;
  label: string;
  percent: number;
}

interface Usage {
  accounts: Account[];
  history: Sample[];
}

const POLL_MS = 5 * 60 * 1000;
const COLLAPSED_KEY = "rig-workbench.usage.collapsed";
/** The graph spans the last day. */
const SPAN_SECS = 24 * 3600;
/** Validated dark-mode pair, as in netwatch's usage panel. */
const SERIES = ["#3987e5", "#c98500"];

function limitClass(percent: number): string {
  return percent >= 0.9 ? "usage__bar--high" : percent >= 0.7 ? "usage__bar--warn" : "";
}

/** "in 2h 10m", "in 3d 4h", or "" when unknown or past. */
function resetsIn(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (!iso || Number.isNaN(ms) || ms <= 0) return "";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `resets in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `resets in ${hours}h ${mins % 60}m`;
  return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Percent over the last day, one line per window (the first two: session and weekly). */
function Sparkline({ samples, labels }: { samples: Sample[]; labels: string[] }) {
  const width = 200;
  const height = 40;
  const now = Date.now() / 1000;
  const lines = labels.slice(0, SERIES.length).map((label, i) => {
    const points = samples
      .filter((s) => s.label === label)
      .sort((a, b) => a.t - b.t)
      .map((s) => {
        const x = ((s.t - (now - SPAN_SECS)) / SPAN_SECS) * width;
        const y = height - s.percent * height;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
    return { label, color: SERIES[i], points };
  });
  if (lines.every((l) => l.points.length < 2)) {
    return <p className="usage__graph-empty">The graph fills in while the app is open.</p>;
  }
  return (
    <svg className="usage__graph" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" y1={height / 2} x2={width} y2={height / 2} className="usage__grid" />
      {lines.map((l) =>
        l.points.length >= 2 ? (
          <polyline key={l.label} points={l.points.join(" ")} fill="none" stroke={l.color} strokeWidth="1.5" />
        ) : null,
      )}
    </svg>
  );
}

export function UsageOverlay() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const load = useCallback(async (force: boolean) => {
    setLoading(true);
    try {
      setUsage(await invoke<Usage>("usage_read", { force }));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(false);
    const timer = setInterval(() => load(false), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // Not remembered; it still toggles.
    }
  };

  if (usage && usage.accounts.length === 0 && !error) return null;

  return (
    <section className="usage nowheel" aria-label="AI usage">
      <header className="usage__header">
        <button className="usage__title" onClick={toggle} aria-expanded={!collapsed}>
          {collapsed ? "▸" : "▾"} AI usage
        </button>
        {!collapsed && (
          <button className="usage__refresh" onClick={() => load(true)} disabled={loading} title="Check now">
            {loading ? "…" : "↻"}
          </button>
        )}
      </header>
      {!collapsed && (
        <>
          {error && <p className="usage__note">{error}</p>}
          {!usage && !error && <p className="usage__note">Checking…</p>}
          {usage?.accounts.map((account) => {
            const labels = account.limits.map((l) => l.label);
            return (
              <div key={account.id} className="usage__account">
                <div className="usage__name">
                  {account.label}
                  {account.plan && <span className="usage__plan"> · {account.plan}</span>}
                </div>
                {account.limits.map((limit, i) => (
                  <div key={limit.label} className="usage__limit" title={resetsIn(limit.resetsAt)}>
                    <span className="usage__label">
                      {i < SERIES.length && <span className="usage__swatch" style={{ background: SERIES[i] }} />}
                      {limit.label}
                    </span>
                    <span className="usage__pct">{Math.round(limit.percent * 100)}%</span>
                    <div className="usage__track">
                      <div
                        className={`usage__bar ${limitClass(limit.percent)}`}
                        style={{ width: `${Math.max(1, limit.percent * 100)}%` }}
                      />
                    </div>
                    {resetsIn(limit.resetsAt) && <span className="usage__reset">{resetsIn(limit.resetsAt)}</span>}
                  </div>
                ))}
                {account.note && <p className="usage__note">{account.note}</p>}
                {account.limits.length > 0 && (
                  <Sparkline samples={usage.history.filter((s) => s.account === account.id)} labels={labels} />
                )}
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}
