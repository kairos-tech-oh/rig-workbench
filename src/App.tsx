import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Edge,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./App.css";
import { listEdges, listRigs, listSeats, onDaemonEvent, type Rig, type RigEdge, type Seat } from "./api";
import { emptyLayout, loadLayout, saveLayout, type SavedLayout } from "./layout";
import { SeatNode, type SeatFlowNode } from "./SeatNode";
import { SeatPanel, type RoleOption } from "./SeatPanel";
import { useCommunicationFlashes, type Flash } from "./useCommunicationFlashes";

const POLL_MS = 5000;
const SAVE_DELAY_MS = 400;
const STATUS_MS = 6000;
const COLUMN_WIDTH = 720;
const ROW_HEIGHT = 180;

const nodeTypes = { seat: SeatNode };

/** Default position for a seat with no saved one: a column per pod. */
function defaultPositions(seats: Seat[]): Map<string, { x: number; y: number }> {
  const pods: string[] = [];
  const rowInPod = new Map<string, number>();
  const positions = new Map<string, { x: number; y: number }>();
  for (const seat of seats) {
    if (!pods.includes(seat.podNamespace)) pods.push(seat.podNamespace);
    const row = rowInPod.get(seat.podNamespace) ?? 0;
    rowInPod.set(seat.podNamespace, row + 1);
    positions.set(seat.logicalId, {
      x: pods.indexOf(seat.podNamespace) * COLUMN_WIDTH,
      y: row * ROW_HEIGHT,
    });
  }
  return positions;
}

/** Best guess at the rig spec's folder: the working directory most seats share. */
function guessRigFolder(seats: Seat[]): string {
  const counts = new Map<string, number>();
  for (const seat of seats) {
    if (seat.cwd) counts.set(seat.cwd, (counts.get(seat.cwd) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

/** Daemon edges use node ids; the canvas uses logical ids, which survive a seat being replaced. */
function toFlowEdge(edge: RigEdge, nodeToLogical: Map<string, string>): Edge | null {
  const source = nodeToLogical.get(edge.source);
  const target = nodeToLogical.get(edge.target);
  if (!source || !target) return null;
  const observe = edge.label === "can_observe";
  return {
    id: edge.id,
    source,
    target,
    label: edge.label,
    style: observe ? { strokeDasharray: "6 4" } : { strokeWidth: 1.5 },
    markerEnd: { type: MarkerType.ArrowClosed },
    className: `edge edge--${edge.label}`,
  };
}

/** Highlight edges between seats that just talked; draw a temporary one where none exists. */
function withFlashes(edges: Edge[], flashes: Flash[]): Edge[] {
  if (flashes.length === 0) return edges;
  const matches = (edge: Edge, f: Flash) =>
    (edge.source === f.from && edge.target === f.to) || (edge.source === f.to && edge.target === f.from);
  const result = edges.map((edge) =>
    flashes.some((f) => matches(edge, f))
      ? { ...edge, className: `${edge.className ?? ""} edge--flash`, zIndex: 5 }
      : edge,
  );
  for (const f of flashes) {
    if (edges.some((edge) => matches(edge, f))) continue;
    result.push({
      id: `flash:${f.from}>${f.to}`,
      source: f.from,
      target: f.to,
      className: "edge edge--flash edge--transient",
      markerEnd: { type: MarkerType.ArrowClosed },
      zIndex: 5,
    });
  }
  return result;
}

/**
 * Restores the saved viewport for a rig, or frames the whole rig if none was
 * saved. Runs once per rig, after its blocks have been measured.
 */
function InitialView({ rigId, viewport }: { rigId: string | null; viewport: Viewport | null | undefined }) {
  const { fitView, setViewport } = useReactFlow();
  const initialized = useNodesInitialized();
  const appliedRig = useRef<string | null>(null);

  useEffect(() => {
    if (!initialized || !rigId || viewport === undefined || appliedRig.current === rigId) return;
    appliedRig.current = rigId;
    // Wait a frame so React Flow has applied the measured sizes.
    requestAnimationFrame(() => {
      if (viewport) setViewport(viewport);
      else fitView({ padding: 0.15 });
    });
  }, [initialized, rigId, viewport, fitView, setViewport]);

  return null;
}

export default function App() {
  const [rigs, setRigs] = useState<Rig[]>([]);
  const [rigId, setRigId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [rigEdges, setRigEdges] = useState<RigEdge[]>([]);
  const [layout, setLayout] = useState<SavedLayout | null>(null);
  const [openTerminals, setOpenTerminals] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<SeatFlowNode>([]);

  const rigName = rigs.find((rig) => rig.id === rigId)?.name ?? null;
  const flashes = useCommunicationFlashes(seats);

  // ---- Layout persistence ----------------------------------------------------

  const layoutRef = useRef<SavedLayout | null>(null);
  layoutRef.current = layout;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** Change the saved layout and write it to disk shortly after. */
  const updateLayout = useCallback(
    (change: (current: SavedLayout) => SavedLayout) => {
      if (!rigName || !layoutRef.current) return;
      const next = change(layoutRef.current);
      layoutRef.current = next;
      setLayout(next);
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveLayout(rigName, next).catch((e) => setError(`Could not save layout: ${e}`));
      }, SAVE_DELAY_MS);
    },
    [rigName],
  );

  useEffect(() => {
    if (!rigName) return;
    let cancelled = false;
    setLayout(null);
    loadLayout(rigName)
      .catch((e) => {
        setError(`Could not load saved layout: ${e}`);
        return emptyLayout();
      })
      .then((loaded) => {
        if (cancelled) return;
        setLayout(loaded);
        setOpenTerminals(new Set(loaded.openTerminals ?? []));
      });
    return () => {
      cancelled = true;
    };
  }, [rigName]);

  // ---- Daemon data -------------------------------------------------------------

  useEffect(() => {
    listRigs()
      .then((found) => {
        setRigs(found);
        setRigId((current) => current ?? found[0]?.id ?? null);
        setError(found.length === 0 ? "The daemon is running but has no rigs." : null);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const layoutLoaded = layout !== null;

  const refresh = useCallback(async () => {
    if (!rigId) return;
    try {
      const [nextSeats, nextEdges] = await Promise.all([listSeats(rigId), listEdges(rigId)]);
      const saved = layoutRef.current?.positions ?? {};
      const defaults = defaultPositions(nextSeats);
      setSeats(nextSeats);
      setRigEdges(nextEdges);
      // Existing blocks stay where they are; new ones use their saved position.
      setNodes((current) => {
        const byId = new Map(current.map((node) => [node.id, node]));
        return nextSeats.map((seat) => ({
          id: seat.logicalId,
          type: "seat" as const,
          position: byId.get(seat.logicalId)?.position ?? saved[seat.logicalId] ?? defaults.get(seat.logicalId)!,
          dragHandle: ".seat__header",
          selected: byId.get(seat.logicalId)?.selected,
          data: { seat, terminalOpen: false, onToggleTerminal: () => {} },
        }));
      });
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [rigId, setNodes]);

  useEffect(() => {
    if (!rigId || !layoutLoaded) return;
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [rigId, layoutLoaded, refresh]);

  // Refresh promptly when the daemon reports a seat change or activity.
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = onDaemonEvent((event) => {
      if (event.rigId !== rigId) return;
      if (!event.type.startsWith("node.") && event.type !== "agent.activity") return;
      clearTimeout(pending);
      pending = setTimeout(refresh, 300);
    });
    return () => {
      clearTimeout(pending);
      unsubscribe();
    };
  }, [rigId, refresh]);

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), STATUS_MS);
    return () => clearTimeout(timer);
  }, [status]);

  // ---- Interaction -------------------------------------------------------------

  const toggleTerminal = useCallback(
    (logicalId: string) => {
      setOpenTerminals((current) => {
        const next = new Set(current);
        if (next.has(logicalId)) next.delete(logicalId);
        else next.add(logicalId);
        updateLayout((l) => ({ ...l, openTerminals: [...next] }));
        return next;
      });
    },
    [updateLayout],
  );

  const onSeatRemoved = useCallback(
    (logicalId: string) => {
      setSelected(null);
      setOpenTerminals((current) => {
        const next = new Set(current);
        next.delete(logicalId);
        return next;
      });
      updateLayout((l) => {
        const { [logicalId]: _removed, ...positions } = l.positions;
        return { ...l, positions, openTerminals: (l.openTerminals ?? []).filter((id) => id !== logicalId) };
      });
    },
    [updateLayout],
  );

  const onChanged = useCallback(
    (message: string) => {
      setStatus(message);
      refresh();
    },
    [refresh],
  );

  // ---- Rendering ----------------------------------------------------------------

  const renderedNodes = useMemo(
    () =>
      nodes.map((node) => {
        const terminalOpen = openTerminals.has(node.id);
        // An open terminal is taller than the row spacing; draw it above its neighbours.
        return {
          ...node,
          zIndex: terminalOpen ? 10 : 0,
          data: { ...node.data, terminalOpen, onToggleTerminal: toggleTerminal },
        };
      }),
    [nodes, openTerminals, toggleTerminal],
  );

  const edges = useMemo(() => {
    const nodeToLogical = new Map(seats.map((s) => [s.nodeId, s.logicalId]));
    const base = rigEdges.map((e) => toFlowEdge(e, nodeToLogical)).filter((e): e is Edge => e !== null);
    return withFlashes(base, flashes);
  }, [rigEdges, seats, flashes]);

  const pods = useMemo(() => [...new Set(seats.map((s) => s.podNamespace))], [seats]);
  const roles = useMemo<RoleOption[]>(() => {
    const byRef = new Map<string, string>();
    for (const s of seats) {
      if (s.agentRef && !byRef.has(s.agentRef)) byRef.set(s.agentRef, s.resolvedSpecName ?? s.agentRef);
    }
    return [...byRef.entries()].map(([agentRef, label]) => ({ agentRef, label }));
  }, [seats]);
  const rigFolder = layout?.rigFolder ?? guessRigFolder(seats);
  const setRigFolder = useCallback(
    (folder: string) => updateLayout((l) => ({ ...l, rigFolder: folder })),
    [updateLayout],
  );

  const selectedSeat = seats.find((s) => s.logicalId === selected) ?? null;
  const panelProps = {
    rigId: rigId ?? "",
    roles,
    rigFolder,
    onRigFolderChange: setRigFolder,
    onChanged,
  };

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
              setSeats([]);
              setSelected(null);
              setAdding(false);
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
        <button
          className="btn btn--primary toolbar__add"
          disabled={!rigId || seats.length === 0}
          onClick={() => {
            setSelected(null);
            setAdding(true);
          }}
        >
          + Add seat
        </button>
        <span className="toolbar__summary">
          {rigName ? `${seats.length} seats · ${openTerminals.size} attached` : ""}
        </span>
        {status && <span className="toolbar__status">{status}</span>}
        {error && <span className="toolbar__error">{error}</span>}
      </header>
      <div className="canvas">
        <ReactFlow
          nodes={renderedNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeClick={(_, node) => {
            setAdding(false);
            setSelected(node.id);
          }}
          onPaneClick={() => setSelected(null)}
          onNodeDragStop={(_, __, dragged) =>
            updateLayout((l) => ({
              ...l,
              positions: { ...l.positions, ...Object.fromEntries(dragged.map((n) => [n.id, n.position])) },
            }))
          }
          onMoveEnd={(_, viewport) => updateLayout((l) => ({ ...l, viewport }))}
          deleteKeyCode={null}
          minZoom={0.1}
          maxZoom={2}
          colorMode="dark"
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
          <MiniMap pannable zoomable />
          <Controls />
          <InitialView rigId={rigId} viewport={layout === null ? undefined : layout.viewport ?? null} />
        </ReactFlow>

        {adding && (
          <SeatPanel key="add" mode="add" pods={pods} onClose={() => setAdding(false)} {...panelProps} />
        )}
        {!adding && selectedSeat && (
          <SeatPanel
            key={selectedSeat.logicalId}
            mode="edit"
            seat={selectedSeat}
            onClose={() => setSelected(null)}
            onRemoved={onSeatRemoved}
            {...panelProps}
          />
        )}
      </div>
    </div>
  );
}
