import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./App.css";
import { listEdges, listRigs, listSeats, type Rig, type RigEdge, type Seat } from "./api";
import { SeatNode, type SeatFlowNode } from "./SeatNode";

const POLL_MS = 5000;
const COLUMN_WIDTH = 720;
const ROW_HEIGHT = 180;

const nodeTypes = { seat: SeatNode };

/**
 * Frames the whole rig once its blocks have been measured, and again when
 * another rig is selected. Later polls leave the view alone.
 */
function FitWhenLoaded({ rigId }: { rigId: string | null }) {
  const { fitView } = useReactFlow();
  const initialized = useNodesInitialized();
  const fittedRig = useRef<string | null>(null);

  useEffect(() => {
    if (initialized && rigId && fittedRig.current !== rigId) {
      fittedRig.current = rigId;
      // Wait a frame so React Flow has applied the measured sizes.
      requestAnimationFrame(() => fitView({ padding: 0.15 }));
    }
  }, [initialized, rigId, fitView]);

  return null;
}

/** Initial position: one column per pod, seats stacked in pod order. */
function layoutSeats(seats: Seat[]): Map<string, { x: number; y: number }> {
  const pods: string[] = [];
  const rowInPod = new Map<string, number>();
  const positions = new Map<string, { x: number; y: number }>();
  for (const seat of seats) {
    if (!pods.includes(seat.podNamespace)) pods.push(seat.podNamespace);
    const row = rowInPod.get(seat.podNamespace) ?? 0;
    rowInPod.set(seat.podNamespace, row + 1);
    positions.set(seat.nodeId, {
      x: pods.indexOf(seat.podNamespace) * COLUMN_WIDTH,
      y: row * ROW_HEIGHT,
    });
  }
  return positions;
}

function toFlowEdge(edge: RigEdge): Edge {
  const observe = edge.label === "can_observe";
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    style: observe ? { strokeDasharray: "6 4" } : { strokeWidth: 1.5 },
    markerEnd: { type: MarkerType.ArrowClosed },
    className: `edge edge--${edge.label}`,
  };
}

export default function App() {
  const [rigs, setRigs] = useState<Rig[]>([]);
  const [rigId, setRigId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openTerminals, setOpenTerminals] = useState<Set<string>>(new Set());
  const [nodes, setNodes, onNodesChange] = useNodesState<SeatFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const toggleTerminal = useCallback((nodeId: string) => {
    setOpenTerminals((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  useEffect(() => {
    listRigs()
      .then((found) => {
        setRigs(found);
        setRigId((current) => current ?? found[0]?.id ?? null);
        setError(found.length === 0 ? "The daemon is running but has no rigs." : null);
      })
      .catch((e) => setError(String(e)));
  }, []);

  // Poll seats and edges. Existing blocks keep wherever the user dragged them;
  // only new seats get a computed position.
  useEffect(() => {
    if (!rigId) return;
    let cancelled = false;

    const refresh = async () => {
      try {
        const [seats, rigEdges] = await Promise.all([listSeats(rigId), listEdges(rigId)]);
        if (cancelled) return;
        const layout = layoutSeats(seats);
        setNodes((current) => {
          const byId = new Map(current.map((node) => [node.id, node]));
          return seats.map((seat) => {
            const existing = byId.get(seat.nodeId);
            return {
              id: seat.nodeId,
              type: "seat" as const,
              position: existing?.position ?? layout.get(seat.nodeId)!,
              dragHandle: ".seat__header",
              data: { seat, terminalOpen: false, onToggleTerminal: toggleTerminal },
            };
          });
        });
        setEdges(rigEdges.map(toFlowEdge));
        setError(null);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    };

    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [rigId, setNodes, setEdges, toggleTerminal]);

  // Terminal state lives outside the polled data so a refresh never detaches one.
  const renderedNodes = useMemo(
    () =>
      nodes.map((node) => {
        const terminalOpen = openTerminals.has(node.id);
        // An open terminal is taller than the row spacing; draw it above its neighbours.
        return { ...node, zIndex: terminalOpen ? 10 : 0, data: { ...node.data, terminalOpen } };
      }),
    [nodes, openTerminals],
  );

  const rigName = rigs.find((rig) => rig.id === rigId)?.name;

  return (
    <div className="app">
      <header className="toolbar">
        <span className="toolbar__title">Rig Workbench</span>
        {rigs.length > 0 && (
          <select
            className="toolbar__rig"
            value={rigId ?? ""}
            onChange={(event) => {
              setNodes([]);
              setOpenTerminals(new Set());
              setRigId(event.target.value);
            }}
          >
            {rigs.map((rig) => (
              <option key={rig.id} value={rig.id}>
                {rig.name}
              </option>
            ))}
          </select>
        )}
        <span className="toolbar__summary">
          {rigName ? `${nodes.length} seats · ${openTerminals.size} attached` : ""}
        </span>
        {error && <span className="toolbar__error">{error}</span>}
      </header>
      <div className="canvas">
        <ReactFlow
          nodes={renderedNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          deleteKeyCode={null}
          minZoom={0.1}
          maxZoom={2}
          colorMode="dark"
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
          <MiniMap pannable zoomable />
          <Controls />
          <FitWhenLoaded rigId={rigId} />
        </ReactFlow>
      </div>
    </div>
  );
}
