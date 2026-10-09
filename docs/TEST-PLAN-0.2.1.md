# Rig Workbench 0.2.1 — manual test plan

Tests the five new features and re-checks earlier ones before 0.2.1 is cut.
**You run every step yourself.** The engineering seats do not stop, restart or
reinstall the daemon, and do not bring rigs up or down, so anything that needs
that is here.

Each step says **where** to run it, the **action**, what you should
**expect**, and what to do **if it doesn't** happen. Tick each box as you go.

- **[Windows]**: PowerShell on Windows, or the Rig Workbench window.
- **[WSL]**: a WSL Ubuntu terminal.
- **Report a failure** by writing the step number, what you saw, and a
  screenshot if useful. Send it to the orchestrator (`orch-lead`), who routes
  it to the rig-workbench engineer. A failure in Part D goes to the
  orchestrator **after** the recovery steps there, since it may have stopped
  the seats, the orchestrator's included.

## Safe order

1. **Part A, prep:** back up, record what's running, get the build.
2. **Part B, throwaway rig:** create a test rig that has nothing to lose.
3. **Part C, everyday tests:** everything that doesn't stop the daemon or
   your real rigs. Most of the plan is here.
4. **Part D, DESTRUCTIVE:** stopping and starting the daemon, stopping and
   starting the `workbench` rig, and (only if needed) restarting WSL. Only once Part C passes, and only once
   every seat has finished or handed off its work.
5. **Part E, clean up.**

Parts A to C never stop the daemon or any seat of `workbench` or `kernel`.

**Never, at any point in this plan:**
- `wsl --shutdown` or `wsl --terminate`: it ends the whole WSL VM, and with it
  the tmux server every seat lives in. **This is what caused the outage on
  2026-10-09 at about 21:38Z**, not a daemon stop.
- `tmux kill-server`, or any tmux test on the default server: the seats use
  the default tmux socket, so it ends every seat at once.
- Let Windows sleep while seats are running: keep sleep off for the whole run.

---

## Part A — Prep

- [ ] **A1 [WSL] Record what is running.**
  ```bash
  rig --version
  rig status
  rig ps --nodes > ~/rwb-test-before.txt; cat ~/rwb-test-before.txt
  curl -s http://127.0.0.1:7433/healthz | head -c 200; echo
  ```
  **Expect:** a version such as `0.6.8-kairos.1 (bf68b643)`; "Daemon running
  on port 7433"; rigs `workbench` and `kernel`; healthz starting
  `{"status":"ok"`.
  **If not:** stop here and tell the orchestrator. The plan assumes a healthy
  daemon to start from.

- [ ] **A2 [WSL] Back up OpenRig's state and the rig spec.** The database is
  copied with SQLite's own online backup, which gives a consistent copy while
  the daemon runs; everything else goes in a tar that leaves the live
  database files out. The archive holds `~/.openrig/secrets` and the
  activity-hook token, so it is made readable only by you: **don't share it**.
  ```bash
  STAMP=$(date +%F-%H%M); umask 077
  python3 -c "import sqlite3,sys;s=sqlite3.connect(sys.argv[1]);d=sqlite3.connect(sys.argv[2]);s.backup(d);d.close();s.close()" ~/.openrig/openrig.sqlite ~/openrig-db-$STAMP.sqlite
  tar czf ~/openrig-backup-$STAMP.tgz -C ~ --exclude='.openrig/openrig.sqlite*' .openrig
  cp /mnt/e/rigs/workbench/rig.yaml ~/rig.yaml.backup-$STAMP
  ls -lh ~/openrig-db-$STAMP.sqlite ~/openrig-backup-$STAMP.tgz ~/rig.yaml.backup-$STAMP
  echo "STAMP=$STAMP"
  ```
  **Expect:** three files listed and a `STAMP=` line; write the stamp down for
  RB3. `/mnt/e/rigs/workbench/rig.yaml` is the spec `workbench` runs from (its
  `.`-folder seats resolve there).
  **If not:** fix disk space or permissions before going on.

- [ ] **A3 [WSL] Take an OpenRig snapshot of the real rig.** Nothing restarts;
  OpenRig already takes one every few minutes, so this just makes a fresh one.
  `rig snapshot` takes the rig's id:
  ```bash
  RID=$(rig ps --json | python3 -c "import sys,json;print([r['rigId'] for r in json.load(sys.stdin) if r['name']=='workbench'][0])")
  rig snapshot "$RID"
  rig snapshot list "$RID" | tail -3
  ```
  **Expect:** a snapshot id, and the new snapshot at the end of the list.
  **If it errors:** note it and rely on A2.

- [ ] **A4 [Windows] Get the 0.2.1 build.** In PowerShell:
  ```powershell
  cd E:\rig-workbench
  git pull
  npm install
  npm run tauri dev
  ```
  **Expect:** the Rig Workbench window opens on the `workbench` rig, with its
  seats on the canvas. If you also have the installed 0.2.0 app open, close
  it first. Closing the app only detaches its terminals; the seats keep
  running.
  **If not:** copy the PowerShell output to the orchestrator.

- [ ] **A5 [Windows] Check WSL won't shut itself down when idle.** WSL can end
  the VM after an idle period, taking every seat with it. In PowerShell:
  ```powershell
  Get-Content "$env:USERPROFILE\.wslconfig" -ErrorAction SilentlyContinue
  ```
  **Expect:** a `[wsl2]` section containing `vmIdleTimeout=-1`.
  **If it's missing:** don't change it now. Changing it only takes effect
  after a WSL restart, which ends every seat, so it is step D5 at the end of
  the destructive part. Until then, keep a WSL terminal open and Windows
  awake for the whole run.

- [ ] **A6 [Windows] Note the app's data folder**, in case you want to reset
  the saved layout or usage history later:
  `%APPDATA%\dev.kairos.rigworkbench\` (`layouts\<rig>.json`, `settings.json`,
  `usage-history.json`). Nothing to do now.

---

## Part B — Create the throwaway rig

A rig called `rwb-test` with one plain shell seat and one Claude seat on a
tiny agent that does nothing. Its working folder is empty, so nothing of
value is at risk. **This does not stop or restart the daemon.**

- [ ] **B1 [WSL] Create its files.**
  ```bash
  mkdir -p ~/rwb-test/agents/probe ~/rwb-test/work
  cat > ~/rwb-test/agents/probe/agent.yaml <<'EOF'
  name: probe
  version: "1.0"
  description: Disposable test agent for Rig Workbench; does nothing.
  defaults:
    runtime: claude-code
  profiles:
    default:
      uses: { skills: [], guidance: [], subagents: [], plugins: [], runtime_resources: [] }
  startup:
    files: []
    actions: []
  EOF
  cat > ~/rwb-test/rig.yaml <<EOF
  version: "0.2"
  name: rwb-test
  summary: Throwaway rig for testing Rig Workbench. Safe to delete.
  pods:
    - id: t
      label: Test
      members:
        - id: shell
          label: Plain shell
          agent_ref: "builtin:terminal"
          runtime: terminal
          profile: none
          cwd: "."
        - id: probe
          label: Probe
          agent_ref: "local:agents/probe"
          runtime: claude-code
          model: claude-sonnet-5-5
          profile: default
          cwd: $HOME/rwb-test/work
      edges: []
  edges: []
  EOF
  rig requirements ~/rwb-test/rig.yaml
  ```
  **Expect:** `No requirements declared.`
  **If not:** send the output to the orchestrator.

- [ ] **B2 [WSL] Bring it up.**
  ```bash
  cd ~/rwb-test && rig up ./rig.yaml --yes
  rig ps --nodes --rig rwb-test
  ```
  **Expect:** `Status: completed`; `t.shell` and `t.probe` running. One idle
  Claude session (probe) is now open; it costs almost nothing while idle.
  **If not:** send the output to the orchestrator; skip the steps in Part C
  that need `rwb-test`.

- [ ] **B3 [Windows] Select it in the app.** Within a few seconds `rwb-test`
  appears in the rig dropdown in the toolbar; select it.
  **Expect:** two tiles, `t.shell` and `t.probe`, and a green dot with a
  **Stop** button next to the dropdown.
  **If not:** wait 10 s. If it still doesn't appear, that is a failure of
  feature 2 (the rig list should follow the daemon): report it.

---

## Part C — Everyday tests (no daemon restart, no real rig stopped)

### C1. Daemon status in Settings (feature 1, running case)

- [ ] **C1.1 [Windows]** Press **Ctrl+,** (or the **Settings** button).
  **Expect:** the Settings window has an **OpenRig daemon** section reading
  `Running · 0.6.8-kairos.1 · pid <n>`, and **no** Start button.
  **If not:** report it with a screenshot. The stopped case is tested in D1.

- [ ] **C1.2 [Windows]** In Settings → **Updates**, read the versions **but do
  not press Update if it offers a daemon update**: updating the daemon
  restarts it (that belongs in Part D). On Windows the note should say to
  update the daemon inside WSL.
  **Expect:** App `v0.2.0` (the version is bumped at release), Daemon
  `0.6.8-kairos.1 (bf68b643)`.

### C2. Rig start/stop on `rwb-test` (feature 2)

- [ ] **C2.1 [Windows]** With `rwb-test` selected, click **Attach** on
  `t.shell`, type `echo hello` and Enter.
  **Expect:** the terminal shows `hello`.

- [ ] **C2.2 [Windows]** Click **Stop** next to the dropdown.
  **Expect:** a red confirmation in the toolbar: *"Stop all 2 seats of
  **rwb-test**? Their sessions end (1 attached terminal will detach). Start
  brings them back."* with **Stop rig** and **Cancel**.
  Click **Cancel**: it goes back to **Stop** and nothing changes.

- [ ] **C2.3 [Windows]** Click **Stop**, then **Stop rig**.
  **Expect:** "Stopping rwb-test… Ns" for a few seconds; then the status line
  says *"Stopped rwb-test. Start brings its seats back with their
  conversations."*, the dot turns grey, the button becomes **Start**, and the
  open terminal shows `[detached from t-shell@rwb-test]`.
  [WSL] check: `rig ps --nodes --rig rwb-test` shows both seats stopped.
  **If not:** report the toolbar error text.

- [ ] **C2.4 [Windows]** Click **Start**.
  **Expect:** "Starting rwb-test… Ns", then a status line such as *"Started
  rwb-test: 1 resumed, 1 awaiting-decision"*. Then a notice: *"t.shell could
  not resume its conversation and was not started."* with **Start fresh** and
  **Leave stopped**. A plain shell has no conversation to resume, so it
  always lands here. The Claude probe usually resumes.
  **If not:** report the status and error text.

- [ ] **C2.5 [Windows]** Click **Start fresh**.
  **Expect:** *"Started t.shell fresh."*; the dot turns green; the `t.shell`
  terminal reattaches on its own, and typing works in it after a click.
  **If not:** check [WSL] `rig ps --nodes --rig rwb-test` and report both.

- [ ] **C2.6 [Windows] (optional)** Repeat C2.3–C2.4 and choose **Leave
  stopped**: the notice goes away and `t.shell` stays stopped. Then use C2.5
  to bring it back.

### C3. Launch modes (feature 3), on `t.probe`

- [ ] **C3.1 [Windows]** Click the gear on `t.probe`.
  **Expect:** the panel has **Launch mode** set to *"Rig default: Standard
  (accept edits)"*, a **Rig default for all seats** select showing *Standard
  (accept edits)*, and a line such as *"The daemon will next launch this seat
  with `acceptEdits` (OpenRig's default)."*.

- [ ] **C3.2 [Windows]** Open the **Rig default for all seats** select.
  **Expect:** only *Standard (accept edits)* and *Auto*: **no**
  skip-permissions option.

- [ ] **C3.3 [Windows]** Set **Launch mode** to **Auto**, leave **Restart now**
  unticked, and click **Save**.
  **Expect:** status *"t.probe will launch in Auto from its next launch."*; a
  small grey `auto` badge on the tile.
  [WSL] check:
  `grep -A8 "id: probe" ~/rwb-test/rig.yaml` shows `permission_policy: builtin:auto`.

- [ ] **C3.4 [Windows]** Open the gear again, tick **Restart now**, and
  **Save**.
  **Expect:** *"Restarted t.probe fresh in Auto."* (or similar).
  [WSL] check that it really launched in auto:
  `ps -eo args | grep -- '--permission-mode auto' | grep -v grep`
  shows one `claude … --permission-mode auto` line.

- [ ] **C3.5 [Windows]** Open the gear and choose **⚠ Skip all permission
  checks (dangerous)**.
  **Expect:** the select turns red; a red box explains the seat will run any
  command without asking, with an unticked checkbox *"I understand: probe skips
  all permission checks."* Click **Save** without ticking it: an error asks you
  to tick the box, and nothing is saved.

- [ ] **C3.6 [Windows]** Tick the box and **Save**, with **Restart now
  unticked** (we don't launch it in this mode).
  **Expect:** the tile shows a red **⚠ no permission checks** badge;
  `~/rwb-test/rig.yaml` has `permission_policy: builtin:yolo` under `probe`;
  the panel says the daemon will next launch it with `full_bypass` (set for
  this seat).
  **If the badge isn't red, or the box let you save unticked:** report it.
  This is the safety check.

- [ ] **C3.7 [Windows]** Set it back to **Rig default** and **Save**.
  **Expect:** the badge disappears; the `permission_policy` line is gone from
  `probe` in `~/rwb-test/rig.yaml`.

- [ ] **C3.8 [Windows]** Set **Rig default for all seats** to **Auto**.
  **Expect:** status *"Rig default is now Auto. 1 seat(s) following it launch
  that way from their next launch."*; `t.probe` shows `auto`;
  `~/rwb-test/rig.yaml` has `permission_policy: builtin:auto` near the top.
  Set it back to **Standard**: the top-level line is removed.

- [ ] **C3.9 [Windows]** Open the gear on `t.shell`.
  **Expect:** no Launch mode field (a plain shell isn't an agent).

### C4. AI usage overlay (feature 4)

- [ ] **C4.1 [Windows]** Look under the legend in the top-right corner.
  **Expect:** an **AI usage** box: *Claude · <plan>*, *Session (5-hour)* and
  *Weekly (7-day)* bars with percentages and "resets in …", and either a
  graph or *"The graph fills in while the app is open."* No Codex row unless
  Codex is installed in WSL. No Windows row unless Windows is signed in to a
  **different** Claude account.
  Compare with `/usage` in any Claude Code session: the percentages should
  match within a few points.
  **If not:** report the box contents and `/usage` output.

- [ ] **C4.2 [Windows]** Click **↻**.
  **Expect:** a brief `…`, then numbers (possibly the same). Clicking it
  repeatedly within 15 s doesn't make new requests. While a terminal has
  focus, clicking ↻ or the ▾ title leaves typing in the terminal.

- [ ] **C4.3 [Windows]** Click **▾ AI usage** to collapse, restart the app
  (close the window, `npm run tauri dev` again).
  **Expect:** it stays collapsed. Expand it again.

- [ ] **C4.4 [Windows] Signed-out / expired states. Optional, needs a login
  change.** Only if you're happy to sign out and back in:
  [WSL] `cp ~/.claude/.credentials.json ~/.claude/.credentials.json.bak`,
  then in a **new** WSL shell run `claude auth logout`, wait 1 minute, and
  click ↻.
  **Expect:** *"Not signed in. Run `claude auth login`."* (no numbers, no crash).
  Restore with `claude auth login`, or put back the backup:
  `cp ~/.claude/.credentials.json.bak ~/.claude/.credentials.json`.
  **Caution:** signing out affects every Claude seat's next launch, so put it
  back straight away. The *expired* message ("saved sign-in has expired; it
  renews when Claude Code next runs") can't be produced on demand; skip it.

- [ ] **C4.5** Leave the app open for about 30 minutes during other tests.
  **Expect:** the graph starts drawing a line per window (blue session, amber
  weekly). It only covers time the app was open: a known limit.

### C5. Resizable tiles (feature 5)

- [ ] **C5.1 [Windows]** Attach `t.shell`. Hover the tile.
  **Expect:** small blue handles on its corners and edges.

- [ ] **C5.2 [Windows]** Drag the bottom-right handle to make it much larger.
  **Expect:** the tile grows smoothly; the terminal fills it; after you let go,
  the shell re-wraps to the new width (`ls -la /usr/bin | head -40` shows long
  lines unwrapped). It can't go below about 360×240.

- [ ] **C5.3 [Windows]** Type into the terminal right after resizing.
  **Expect:** typing still goes to the terminal; no panel opened.

- [ ] **C5.4 [Windows]** Restart the app.
  **Expect:** the tile comes back at the size you gave it. Detach it: it shrinks
  to the normal compact card. Attach: the chosen size returns.

- [ ] **C5.5 [Windows]** Zoom far out, then **double-click** the tile's header
  (not a button).
  **Expect:** the canvas animates to show that tile at no more than 100% zoom,
  so its text is readable. Double-clicking inside the terminal selects a word
  as usual instead.

### C6. Regression of earlier features

Run these on `rwb-test` unless the step says otherwise.

- [ ] **C6.1 Attach focus [Windows]:** click **Attach** on a tile.
  **Expect:** you can type immediately, without clicking into the terminal.

- [ ] **C6.2 Gear [Windows]:** click a tile's body or header (not the gear).
  **Expect:** no panel opens. Click the gear: the panel opens.

- [ ] **C6.3 Zoom/pan focus [Windows]:** with a terminal focused, scroll on the
  empty canvas to zoom, drag the canvas to pan, click empty canvas, click
  another tile's header, use the +/- zoom buttons.
  **Expect:** after each, typing still goes into the terminal without a click.
  **If one of them loses focus:** report which action.

- [ ] **C6.4 rig.yaml sync of connections [Windows + WSL]:** drag from
  `t.shell` to `t.probe` and pick `collaborates_with`.
  **Expect:** in `~/rwb-test/rig.yaml`, under pod `t`'s own `edges:` (not the
  top-level list): `kind: collaborates_with`, `from: shell`, `to: probe`.
  `rig requirements ~/rwb-test/rig.yaml` still prints `No requirements
  declared.` Click the line and **Remove connection**: the entry is removed.

- [ ] **C6.5 rig.yaml sync of seats [Windows + WSL]:** **+ Add seat** to pod
  `t`, named `probe2`, runtime claude-code, the probe role, working directory
  `~/rwb-test/work` (as an absolute path), rig folder `~/rwb-test` (absolute).
  **Expect:** a new tile and a `probe2` entry in `~/rwb-test/rig.yaml`. Then
  open its gear and **Remove**: the tile and its entry go. This starts and
  stops one more idle Claude session.

- [ ] **C6.6 Update banner [Windows]:** click the version (`v0.2.0`) in the
  toolbar.
  **Expect:** *"v0.2.0 · up to date"*, or a banner offering a newer release.
  **Don't install it now:** that would replace the build under test.

---

## Part D — DESTRUCTIVE: daemon restart, `workbench` restart, WSL restart

> **Read all of Part D before starting.** These steps stop things that
> are running for real:
>
> - **D1 stops the OpenRig daemon.** A daemon stop alone does not end seats.
>   The daemon runs detached, and the seats live in a separate tmux server it
>   doesn't own. On 2026-10-09 a clean daemon stop at 21:39:53Z left the
>   kernel seats created at 21:38Z running. The earlier outage was the whole
>   WSL VM restarting at about 21:38Z, which ends everything (daemon, tmux,
>   Claude). **What does end seats:** rig down / **Stop rig**, a seat relaunch
>   or restore, `tmux kill-server` (seats share the default tmux server), and
>   any WSL shutdown (`wsl --shutdown` or `--terminate`, the WSL idle timeout,
>   Windows sleep or reboot). D1 checks that every session survives. While the
>   daemon is down, seats can't message each other or use the queue.
> - **D2 stops the whole `workbench` rig**, deliberately ending every one of
>   its sessions.
>
> **Throughout Part D:** don't run `wsl --shutdown` (except in D5), and keep
> Windows awake.
>
> **Before starting:** ask the orchestrator to have every seat finish or hand
> off its work (`rig ps --nodes`: nothing `working`, no WORK `yes`), and wait
> until it confirms. Do Part D when you can afford an interruption.

### D0. Just before

- [ ] **D0.1 [WSL]** Repeat A1 and A2 (fresh record and backup), and run
  `rig ps --nodes | grep -E "working|yes"`.
  **Expect:** no lines (nobody working). **If there are, wait.**

### D1. Daemon stopped → started from the app (feature 1, stopped case)

- [ ] **D1.1 [WSL]** Record the seats' sessions, then stop the daemon:
  ```bash
  tmux ls | sort > ~/tmux-before.txt; wc -l < ~/tmux-before.txt
  rig daemon stop
  curl -s -m 3 http://127.0.0.1:7433/healthz || echo "daemon is down"
  tmux ls | sort > ~/tmux-during.txt; diff ~/tmux-before.txt ~/tmux-during.txt && echo "all sessions survived"
  ```
  **Expect:** "daemon is down" **and** "all sessions survived": `tmux ls` still
  lists every seat. **If any is missing, that's a bug:** stop Part D, start the
  daemon (R1), bring the rigs back (R2), and report it.

- [ ] **D1.2 [Windows]** In the app, within a few seconds:
  **Expect:** the toolbar shows the daemon error and a **Start daemon…**
  button. In Settings, **OpenRig daemon** reads *"Stopped (nothing answers at
  http://127.0.0.1:7433)"* with a **Start daemon** button and the checkbox
  **Also start the kernel**.

- [ ] **D1.3 [Windows]** Tick **Also start the kernel** (you normally run the
  kernel) and click **Start daemon**. Here the checkbox makes no difference:
  the kernel's built-in boot is skipped whenever a rig named `kernel` already
  exists, so it never relaunches or duplicates kernel seats. They survive in
  tmux, or after a VM loss come back with R2.
  **Expect:** "Starting… Ns", then the section reads `Running · … · pid <n>`,
  with the last lines of `rig daemon start` beneath. Within ~5 s the main window
  loads the rigs again on its own.
  **If it fails:** the error shows the CLI's own output; go to **D3 Recovery**.

- [ ] **D1.4 [WSL]** Check the daemon and that the seats are the same ones:
  ```bash
  rig status; rig ps --nodes
  tmux ls | sort | diff ~/tmux-before.txt - && echo "same sessions as before"
  ```
  **Expect:** daemon running, both rigs listed, "same sessions as before",
  and every seat running. If seats show stopped or attention, use
  **D3 Recovery**.

### D2. Stop and start the real `workbench` rig (feature 2 on live seats)

- [ ] **D2.1 [Windows]** Select `workbench`. Click **Stop**.
  **Expect:** the confirmation names all 7 seats and how many are working or
  attached. Click **Stop rig**. Every workbench session ends, **including
  the orchestrator's.**

- [ ] **D2.2 [Windows]** Click **Start**.
  **Expect:** *"Started workbench: N resumed…"*. Any seat that couldn't resume
  appears in the notice: click **Start fresh** for it (it starts a new
  conversation and loses the old one), or **Leave stopped** to deal with it
  from WSL instead.

- [ ] **D2.3 [WSL]** `rig ps --nodes --rig workbench`.
  **Expect:** all seats running. Open the orchestrator and confirm it remembers
  the conversation.

### D3. Recovery (whenever something in Part D doesn't come back, or after a WSL VM loss)

After a WSL VM loss (every tmux session gone), start at R1: the daemon and
the seats both need bringing back.

- [ ] **R1 [WSL] Is the daemon up?**
  `curl -s http://127.0.0.1:7433/healthz | head -c 120; echo`
  If not: `rig daemon start` (add `--no-kernel` only if you normally run without
  the kernel), then `rig daemon status` and `rig daemon logs | tail -50`.

- [ ] **R2 [WSL] Bring the rigs back**, each only if it isn't running. If
  a rig won't come back this way, restore it as in D4:
  ```bash
  rig ps
  rig up workbench --existing
  rig up kernel --existing
  ```
  `--existing` restores from the last snapshot and resumes each seat's
  conversation where Claude allows it. Use the rig **name**, not the
  `rig.yaml`: `rig up rig.yaml` would start a new team in place of the old one.

- [ ] **R3 [WSL] Seats left "awaiting-decision"** (no resume token): start them
  fresh, one at a time, e.g. `rig up workbench --existing --fresh eng.gym`
  if the rest is still stopped, or from the app's notice / the seat's gear
  (**Restart now**) once the rig is up.

- [ ] **R4 [WSL]** Compare `rig ps --nodes` with `~/rwb-test-before.txt`.
  Every seat listed before should be running again.

### D4. Rollback (only if the daemon will not start at all)

- [ ] **RB1 [WSL]** Read why: `rig daemon logs | tail -80`, and send it to the
  orchestrator (or, if it's down too, keep it for when it's back).
- [ ] **RB2 [WSL]** Make sure no half-started daemon holds the port:
  `rig daemon status`. Don't kill processes by hand unless the logs say a stale
  process holds port 7433.
- [ ] **RB3 [WSL] Restore the state backup from A2/D0**, only if the logs point
  at a damaged database:
  with the daemon stopped (`rig daemon status` says it isn't running):
  ```bash
  mv ~/.openrig ~/.openrig.broken-$(date +%F-%H%M)
  tar xzf ~/openrig-backup-<STAMP>.tgz -C ~
  cp ~/openrig-db-<STAMP>.sqlite ~/.openrig/openrig.sqlite
  rig daemon start
  ```
  then R2 and R3.
- [ ] **RB4 [WSL] Restore rig.yaml** if it was changed and you want it back:
  `cp ~/rig.yaml.backup-<STAMP> /mnt/e/rigs/workbench/rig.yaml`.
- [ ] **RB5** If OpenRig itself won't run, `rig context get help` (or
  `daemon/docs/reference/help.md` in the installed `@openrig/cli` package) has
  the recovery guide. The installed version was recorded in A1.

### D5. WSL idle timeout (only if A5 found it missing)

Changing `.wslconfig` only takes effect after WSL restarts, and a WSL restart
**ends every seat**, as on 2026-10-09. Do this last, with work handed off as
for the rest of Part D.

- [ ] **D5.1 [Windows]** Edit `%UserProfile%\.wslconfig` (create it if
  missing) so that it contains:
  ```ini
  [wsl2]
  vmIdleTimeout=-1
  ```
  Keep any other lines already in it.
- [ ] **D5.2 [WSL]** Just before the restart: record the seats, redo the A2
  backup, and take fresh snapshots of both rigs, so R2 restores from this
  moment. Then stop the daemon cleanly, so it writes a shutdown receipt
  instead of being cut off by the VM:
  ```bash
  rig ps --nodes > ~/before-wsl-restart.txt
  # the whole A2 block again (note the new STAMP)
  for RIG in workbench kernel; do
    RID=$(rig ps --json | python3 -c "import sys,json;print([r['rigId'] for r in json.load(sys.stdin) if r['name']=='$RIG'][0])")
    rig snapshot "$RID"
  done
  rig daemon stop
  ```
- [ ] **D5.3 [Windows]** Close every WSL terminal, then in PowerShell:
  `wsl --shutdown`. This is the one place in the plan this command is allowed.
  Then open a new WSL terminal.
- [ ] **D5.4 [WSL]** Recover with D3 (R1, then R2 for `workbench` and `kernel`,
  then R3), and compare with `~/before-wsl-restart.txt`.
  **Expect:** every seat running again, conversations resumed where Claude
  allows.

---

## Part E — Clean up

- [ ] **E1 [WSL]** Remove the throwaway rig (stops only its own two seats):
  ```bash
  rig down rwb-test --delete
  rm -rf ~/rwb-test
  rig ps
  ```
  **Expect:** `rwb-test` gone; `workbench` and `kernel` unaffected.
  `--delete` removes the rig's record, so it can't be brought back. **Only ever
  run it with `rwb-test`, never `workbench` or `kernel`.**
- [ ] **E2** Tell the orchestrator which steps passed and which failed (step
  numbers). Keep the A2 backups until 0.2.1 has been in use for a few days.

## Known gaps to keep in mind

- The usage graph only covers time the app was open.
- Codex usage isn't tested here unless Codex is installed in WSL.
- `/mnt/e/rigs/workbench/rig.yaml` currently fails `rig requirements` because
  of two top-level `eng.openrig` ↔ `eng.rig-workbench` edges, which predate
  0.2.1. The app now writes such connections to the pod's own list, but
  doesn't fix existing ones. The running rig is unaffected; only a fresh
  `rig up rig.yaml` would refuse.
