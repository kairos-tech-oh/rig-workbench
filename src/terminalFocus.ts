import type { MouseEvent } from "react";
import type { Terminal } from "@xterm/xterm";

/**
 * Keeps typing going to the terminal you were typing in while you pan and
 * zoom the canvas.
 *
 * A mousedown on the canvas would otherwise move keyboard focus off the
 * terminal: to the page for the pane, or to the tile itself, which React Flow
 * makes focusable. Either way keystrokes stop reaching the seat until you click
 * back into its terminal.
 */

let last: Terminal | null = null;

/** Remember `term` as the terminal to keep focused once it has had focus. Returns the cleanup. */
export function trackTerminalFocus(term: Terminal): () => void {
  const textarea = term.textarea;
  const onFocus = () => {
    last = term;
  };
  textarea?.addEventListener("focus", onFocus);
  return () => {
    textarea?.removeEventListener("focus", onFocus);
    if (last === term) last = null;
  };
}

/** Things on the canvas that take focus on purpose: fields, other terminals, tile buttons. */
function takesFocus(target: Element): boolean {
  if (target.closest(".seat-terminal, input, textarea, select, [contenteditable]")) return true;
  // The zoom buttons are canvas chrome, like the pane.
  return !!target.closest("button, a") && !target.closest(".react-flow__controls");
}

/**
 * For the canvas's `onMouseDownCapture`: a press on the pane, a tile, an edge
 * or the zoom controls leaves keyboard focus where it is. Panning, dragging,
 * selecting and clicking still work; React Flow and d3 ignore `defaultPrevented`.
 */
export function holdFocusOnCanvas(event: MouseEvent) {
  if (event.target instanceof Element && !takesFocus(event.target)) event.preventDefault();
}

/** After a pan or zoom: if keyboard focus has fallen to nothing, give it back to the last terminal. */
export function restoreTerminalFocus() {
  const active = document.activeElement;
  const nowhere = !active || active === document.body || (active.closest(".react-flow") && !takesFocus(active));
  if (last && nowhere) last.focus();
}
