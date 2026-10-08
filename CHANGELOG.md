# Changelog

Each released version's section is what the app shows under "What's new"
when it offers that update.

## [Unreleased]

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
