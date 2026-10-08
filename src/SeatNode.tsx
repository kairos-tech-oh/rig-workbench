import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { Seat } from "./api";
import { SeatTerminal } from "./SeatTerminal";

export type SeatNodeData = {
  seat: Seat;
  terminalOpen: boolean;
  onToggleTerminal: (logicalId: string) => void;
};

export type SeatFlowNode = Node<SeatNodeData, "seat">;

/**
 * Attachment points on every side and corner. All are `source` handles: the
 * canvas uses loose connection mode, so any point can connect to any other,
 * and the edge's direction comes from where the drag started.
 */
export const HANDLES: { id: string; position: Position; style?: React.CSSProperties }[] = [
  { id: "t", position: Position.Top },
  { id: "r", position: Position.Right },
  { id: "b", position: Position.Bottom },
  { id: "l", position: Position.Left },
  { id: "tl", position: Position.Top, style: { left: 0 } },
  { id: "tr", position: Position.Top, style: { left: "100%" } },
  { id: "br", position: Position.Bottom, style: { left: "100%" } },
  { id: "bl", position: Position.Bottom, style: { left: 0 } },
];

type Health = "ready" | "attention" | "down";

// lifecycleState can stay `attention_required` after a seat recovers (for
// example from a startup login failure), so health follows the live signals.
function seatHealth(seat: Seat): Health {
  if (seat.sessionStatus !== "running") return "down";
  if (seat.startupStatus !== "ready" || seat.activityState?.needsInput?.count) {
    return "attention";
  }
  return "ready";
}

export function SeatNode({ data, selected }: NodeProps<SeatFlowNode>) {
  const { seat, terminalOpen, onToggleTerminal } = data;
  const health = seatHealth(seat);
  // working | idle | needs-input | unknown
  const activity = seat.activityState?.display ?? "unknown";

  const classes = [
    "seat",
    terminalOpen && "seat--open",
    activity === "working" && "seat--working",
    activity === "needs-input" && "seat--needs-input",
    selected && "seat--selected",
  ].filter(Boolean).join(" ");

  return (
    <div className={classes}>
      {HANDLES.map((h) => (
        <Handle key={h.id} id={h.id} type="source" position={h.position} style={h.style} className="seat__handle" />
      ))}
      {/* Clips the content to the rounded corners; the handles sit outside it. */}
      <div className="seat__clip">
        <header className="seat__header">
          <span className={`seat__dot seat__dot--${health}`} title={health} />
          <span className="seat__name">{seat.logicalId}</span>
          <span className="seat__model">{seat.model ?? seat.runtime}</span>
          <button
            className="seat__toggle nodrag"
            onClick={(event) => {
              event.stopPropagation();
              onToggleTerminal(seat.logicalId);
            }}
            title={terminalOpen ? "Detach terminal" : "Attach terminal"}
          >
            {terminalOpen ? "Detach" : "Attach"}
          </button>
        </header>
        <div className="seat__meta">
          <span>{seat.canonicalSessionName}</span>
          <span className={`seat__activity seat__activity--${activity}`}>
            {activity}
            {seat.pendingWorkCount ? ` · ${seat.pendingWorkCount} queued` : ""}
          </span>
        </div>
        {seat.cwd && <div className="seat__cwd">{seat.cwd}</div>}
        {terminalOpen && <SeatTerminal session={seat.canonicalSessionName} />}
      </div>
    </div>
  );
}
