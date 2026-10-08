import { Panel } from "@xyflow/react";
import type { CSSProperties } from "react";
import { EDGE_KINDS } from "./api";

/** Inline stroke for an edge kind; shared with the canvas so the legend matches it. */
export function edgeStyle(kind: string): CSSProperties {
  return kind === "can_observe" ? { strokeDasharray: "6 4" } : { strokeWidth: 1.5 };
}

/** Top-right key for the edge kinds the canvas is currently drawing. */
export function EdgeLegend({ kinds }: { kinds: string[] }) {
  if (kinds.length === 0) return null;
  const order = (kind: string) => {
    const i = EDGE_KINDS.findIndex((k) => k.kind === kind);
    return i === -1 ? EDGE_KINDS.length : i;
  };
  const sorted = [...new Set(kinds)].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  return (
    <Panel position="top-right" className="legend" aria-label="Edge legend">
      {sorted.map((kind) => (
        <div key={kind} className="legend__row">
          {/* Same marker and classes as a real edge, so the canvas CSS styles it too. */}
          <svg className={`legend__sample edge edge--${kind}`} width="40" height="12" aria-hidden="true">
            <defs>
              <marker
                id={`legend-arrow-${kind}`}
                className="react-flow__arrowhead"
                markerWidth="12.5"
                markerHeight="12.5"
                viewBox="-10 -10 20 20"
                markerUnits="strokeWidth"
                orient="auto-start-reverse"
                refX="0"
                refY="0"
              >
                <polyline
                  className="arrowclosed"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  points="-5,-4 0,0 -5,4 -5,-4"
                />
              </marker>
            </defs>
            <path
              className="react-flow__edge-path"
              d="M 2 6 L 34 6"
              style={edgeStyle(kind)}
              markerEnd={`url(#legend-arrow-${kind})`}
            />
          </svg>
          <span className="legend__text">{EDGE_KINDS.find((k) => k.kind === kind)?.reads ?? kind}</span>
        </div>
      ))}
    </Panel>
  );
}
