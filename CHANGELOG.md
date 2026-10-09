# Changelog

Each released version's section is what the app shows under "What's new"
when it offers that update.

## [Unreleased]

- Each seat has a launch mode in its settings: Standard (accept edits), Auto,
  or Skip all permission checks, or the rig's default. It is written to
  rig.yaml as the seat's `permission_policy` and applies from the seat's next
  launch (or now, with Restart now). Skipping permission checks must be
  confirmed per seat and is marked in red on the tile; the rig-wide default
  offers only Standard and Auto, so it is never on by default.
- A connection drawn between two seats of the same pod is now written to that
  pod's own `edges:` list in rig.yaml. Before, it went to the top-level list,
  which OpenRig rejects when the rig is next brought up from the spec.
- Tiles with an attached terminal can be resized by dragging their edges or
  corners (the handles show on hover); the terminal refits and the seat's
  session reflows to the new size, and each tile's size is remembered.
  Double-click a tile's header to fit it on screen at a readable zoom.
- A Start/Stop button next to the rig dropdown brings the selected rig up or
  down (`rig up --existing` / `rig down`), with a confirmation before stopping.
  Starting resumes each seat's conversation where it can and reports the
  outcome; a seat that can't resume is offered a fresh start. Open terminals
  reattach when the rig comes back. The rig list also picks up rigs started
  elsewhere.
- Settings can start the OpenRig daemon (inside WSL on Windows) and shows
  whether it is running; the kernel is started too only if you ask. When the
  app can't reach the daemon, the toolbar offers to start it, and the app picks
  up the rigs as soon as it answers.

## [0.2.0] - 2026-10-08

- Settings has an Updates section showing the app and OpenRig daemon versions,
  with one button that updates the daemon (Linux) and then the app. The daemon
  is only replaced by a newer signed fork release, never a source build.
- A Settings window (toolbar button or Ctrl+,) with a background opacity
  slider: the canvas backdrop can fade to show the desktop behind it, while
  seats and connections stay solid. The setting is remembered.

## [0.1.1] - 2026-10-08

- Connections no longer carry their kind as text; a legend in the top right
  explains each line style.
- Fix connections missing and seat blocks vanishing a few seconds after
  opening a rig in the Linux AppImage.

## [0.1.0] - 2026-10-08

First release.

- A canvas of seats with live terminals, saved layouts per rig, activity
  outlines and communication flashes.
- Add, edit and remove seats; draw, move and remove connections. Seat and
  connection changes are written to the rig's `rig.yaml`.
- Typing stays in the attached terminal while the canvas is panned or zoomed.
- Installers for Windows and Linux, with signed in-app updates.
