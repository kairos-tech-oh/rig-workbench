# Rig Workbench

A desktop GUI for [OpenRig](https://github.com/mvschwarz/openrig): see a rig as
an infinite canvas of seats, each with its live terminal, and (eventually)
build and edit rigs by dragging seats around.

Built with Tauri 2: a Rust backend, and a React front end using React Flow for
the canvas and xterm.js for the terminals.

## Goal

- **Canvas:** an infinite canvas you drag to pan and scroll to zoom, like
  Google Maps.
- **Live terminals:** every seat is a block with its live terminal. Read the
  output and type straight into it.
- **Editing:** add a seat by dragging it onto the canvas and configure it in
  place (runtime, model, working directory, role). Add, edit and remove seats,
  factories and flows, and draw the edges between seats.
- **Same spec as the CLI:** the GUI reads and writes the rig spec
  (`rig.yaml`), so anything built here still runs with `rig up`.

The full background, and the rig this was built against, are in the
`workbench/` folder of the `workbench` branch of
[kairos-tech-oh/openrig](https://github.com/kairos-tech-oh/openrig).

## Status: spike

This is a first spike. It proves the two hard parts before the editor is built.

| Works | Not yet |
|---|---|
| Lists rigs from the daemon and shows one block per seat | Adding, editing or removing seats |
| Pan, zoom, minimap, draggable blocks | Saving block positions |
| Edges from the rig graph (`delegates_to` animated, `can_observe` dashed) | Drawing or editing edges |
| Seat health dot, model, session, activity and queue count, refreshed every 5 s | Writing `rig.yaml` |
| **Attach** opens a live terminal in the block; typing goes to the seat | Launching or stopping rigs from the GUI |

## How it works

```
GUI (Windows or Linux)
  ├─ daemon_get ──HTTP──▶ OpenRig daemon, 127.0.0.1:7433
  │                       /api/rigs, /api/rigs/:id/nodes, /api/rigs/:id/graph
  └─ pty_open ───PTY───▶ tmux attach-session -t =<seat session>
                         (inside WSL via `wsl.exe -e` on Windows)
```

- **`src-tauri/src/daemon.rs`:** read-only GET proxy to the daemon API. Only
  `/api/...` paths are allowed. Calls go through Rust so the daemon doesn't
  need to allow the webview's origin.
- **`src-tauri/src/pty.rs`:** one pseudo-terminal per attached block, running
  `tmux attach-session`. Output streams to the block over a Tauri channel
  (base64, so multi-byte characters split across reads survive). Detaching
  kills only the tmux client; the seat keeps running.
- **`src/App.tsx`:** the canvas. Seats are laid out one column per pod and
  keep wherever you drag them.
- **`src/SeatNode.tsx`, `src/SeatTerminal.tsx`:** the seat block and its
  xterm.js terminal.

## Running it

Prerequisites:

- Rust (stable) and Node 22+.
- On Windows: WebView2 (included with Windows 11) and the MSVC build tools.
- A running OpenRig daemon with a rig up. On Windows that means inside WSL2:
  `rig daemon start --no-kernel`, then `rig up <rig.yaml>`.

```bash
npm install
npm run tauri dev
```

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `RIG_DAEMON_URL` | `http://127.0.0.1:7433` | Daemon base URL |
| `RIG_WSL_DISTRO` | `Ubuntu` | WSL distro that runs tmux (Windows only) |

On Linux (for example the Arch laptop) the terminals run `tmux` directly, with
no WSL.

## Known limitations

- **Terminal size takes over the seat's window.** tmux resizes a session's
  window to fit its most recently active client, so attaching a block resizes
  that seat's window to the block's size, including in other attached
  terminals.
- **Text selection when zoomed.** The canvas scales blocks with CSS
  transforms, so mouse selection inside a terminal can be slightly off when not
  at 100% zoom. Typing and scrolling are unaffected.
- **Open terminals overlap neighbours.** Seats are laid out for collapsed
  blocks. An attached block grows and is drawn on top of the blocks below it;
  drag blocks apart as needed.
- **Polling.** Status is polled every 5 s. The daemon has `/api/events` and
  `/api/activity` streams that could replace polling.

## Next steps

1. Persist block positions per rig.
2. A seat inspector panel: edit runtime, model, cwd and role, backed by the rig
   spec.
3. A palette of seat types to drag onto the canvas; drawing edges between
   blocks.
4. Write the spec and apply it (`rig up`), with a plan preview first.
5. Switch from polling to the daemon's event stream.
