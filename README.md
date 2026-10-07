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

## Status

| Works | Not yet |
|---|---|
| One block per seat: health, model, session, activity, queue count | Drawing or editing edges |
| Pan, zoom, minimap, draggable blocks | Adding a new pod |
| **Attach** opens a live terminal in the block; typing goes to the seat | Writing `rig.yaml` (the daemon is the source of truth) |
| **Add seat** to an existing pod; **edit** a seat's model, working directory, role or runtime; **remove** a seat | Launching or stopping whole rigs |
| Layout saved per rig: positions, zoom/pan, open terminals | |
| Working seats get a pulsing green outline; seats that need input, amber | |
| An edge flashes green when its seats talk; a temporary edge appears if they have none | |

### Editing seats

Click a block to open its inspector; **+ Add seat** opens the same form empty.

- **Model:** recorded with the daemon's `set-model` and used from the seat's
  next launch. Tick **Restart now** to relaunch it fresh straight away.
- **Working directory, role or runtime:** the daemon can't change these on a
  live seat, so the seat is **replaced**: removed and added back under the same
  name with a fresh conversation. The panel asks for confirmation.
- **Remove:** stops the seat and removes it from the rig (confirmation
  required). The daemon refuses if the seat still owns active queue items.
- **Rig folder:** roles are `local:` agent refs resolved against the folder
  holding the rig spec. The daemon doesn't record that folder, so the GUI
  guesses it (the working directory most seats share) and saves any change
  with the layout.

New seats get no cross-pod edges: the daemon's add-member route only accepts
edges inside a pod. Seats can still message any other seat.

### Saved layouts

One JSON file per rig name in the app data folder:
`%APPDATA%\dev.kairos.rigworkbench\layouts\<rig>.json` on Windows,
`~/.local/share/dev.kairos.rigworkbench/layouts/<rig>.json` on Linux. It lives
outside the app's install folder, so it survives restarts and updates. Seats are
keyed by logical id (`pod.member`), so a replaced or re-created seat keeps its
place.

### Communication flashes

- **`rig send` between seats:** each seat's outbox
  (`/api/queue/outbox/list`) is polled every 2 s. The daemon records sends made
  from a seat but emits no event for them. Sends with no known sender (for
  example from a plain shell) aren't recorded and don't flash.
- **Queue items** created or handed off between seats arrive on the daemon's
  event stream (`/api/events`), which also triggers immediate refreshes when a
  seat changes or its activity changes.

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
- **Polling.** Seats are also polled every 5 s as a fallback to the event
  stream.

## Next steps

1. Drag seat types from a palette onto the canvas; draw edges between blocks.
2. Add pods (the daemon's `expand` route).
3. Export the live rig to `rig.yaml` (`rig export`) so the spec stays in step
   with GUI edits.
4. Replace seat polling entirely with the event stream.
