import { useEffect, useRef } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

type PtyEvent = { kind: "data"; b64: string } | { kind: "exit" };

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * A live terminal attached to a seat's tmux session. Unmounting detaches the
 * tmux client; the seat itself keeps running.
 */
export function SeatTerminal({ session }: { session: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // A fresh id per mount, so a quick unmount/remount (React StrictMode)
    // never closes the terminal that replaced it.
    const id = `${session}#${crypto.randomUUID()}`;
    const term = new Terminal({
      fontFamily: "'Cascadia Mono', Consolas, 'DejaVu Sans Mono', monospace",
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: "#0b0e14", foreground: "#d6dbe4" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    const channel = new Channel<PtyEvent>();
    channel.onmessage = (event) => {
      if (event.kind === "data") term.write(decodeBase64(event.b64));
      else term.write("\r\n\x1b[2m[detached from " + session + "]\x1b[0m\r\n");
    };

    let disposed = false;
    invoke("pty_open", { id, session, cols: term.cols, rows: term.rows, onEvent: channel })
      .then(() => {
        if (disposed) invoke("pty_close", { id }).catch(() => {});
      })
      .catch((error) => term.write(`\r\n\x1b[31mCould not attach: ${error}\x1b[0m\r\n`));

    const input = term.onData((data) => {
      invoke("pty_write", { id, data }).catch(() => {});
    });

    const resize = new ResizeObserver(() => {
      fit.fit();
      invoke("pty_resize", { id, cols: term.cols, rows: term.rows }).catch(() => {});
    });
    resize.observe(container);

    return () => {
      disposed = true;
      resize.disconnect();
      input.dispose();
      term.dispose();
      invoke("pty_close", { id }).catch(() => {});
    };
  }, [session]);

  // nodrag/nowheel/nopan: inside the terminal, mouse and wheel belong to the
  // terminal, not the canvas.
  return <div ref={containerRef} className="seat-terminal nodrag nowheel nopan" />;
}
