# Releasing

How a version goes from `main` to every installed copy.

## What a release is

A release is a published GitHub release `vX.Y.Z` holding the installers, a
`.sig` beside each one the updater serves, the OpenRig daemon tarball for that
version (`openrig-cli-<version>.tgz` and its `.sig`), and `latest.json`.
Installed copies read
`https://github.com/kairos-tech-oh/rig-workbench/releases/latest/download/latest.json`
(`plugins.updater.endpoints` in `src-tauri/tauri.conf.json`), which only
resolves once the release is **published**, not a draft.

The repository is public, so the updater and anyone downloading an installer
fetch the files anonymously, and GitHub Actions minutes cost nothing. There are
two ways to build a release; both need the update key.

### With GitHub Actions

Pushing a tag `vX.Y.Z` runs `.github/workflows/build.yml`:

1. `check` type-checks and builds the front end, then checks formatting,
   lints and tests the Rust side. It runs on every push and pull request.
2. `bundle` builds the Windows (NSIS, MSI) and Linux (deb, rpm, AppImage)
   installers. It runs only for a tag or a manual run from the Actions tab,
   and keeps its files for two days: the release is their permanent home.
   With the update key available it also writes a `.sig` beside each
   installer the updater can use.
3. `release` writes `latest.json` from those signatures and creates a **draft**
   GitHub release with everything attached. Publishing that draft (not a new
   release made by hand from the tag) is what ships it.

A tag whose release already exists (one `publish-local.sh` made) is skipped by
`bundle` and `release`, so Actions never rebuilds or redrafts it. The Actions
route does not attach a daemon tarball: add it with `publish-local.sh --add`,
or the release's `latest.json` names no daemon and Settings says so.

### Publishing without Actions

`tools/release/publish-local.sh` builds and publishes from the maintainer's
Linux machine, with no Actions minutes:

```bash
tools/release/publish-local.sh --dry-run --daemon-tag v0.6.8-kairos.1   # builds, signs, writes latest.json, publishes nothing
tools/release/publish-local.sh --daemon-tag v0.6.8-kairos.1
```

It refuses to run on a working tree with changes, when `tauri.conf.json`,
`Cargo.toml` and `package.json` disagree on the version, when a local tag
`vX.Y.Z` points at another commit, when the release already exists, or when
the commit is not on GitHub (push the branch yourself first). It then builds
the AppImage, deb and rpm signed with the update key, checks the AppImage
carries no libwayland, attaches the daemon (below), writes `latest.json`, and
creates the **published** release `vX.Y.Z` at this commit with the
changelog section as its notes. Creating the release creates the tag on
GitHub; `git fetch --tags` brings it here. The script never pushes commits.
`--dry-run` keeps what it built in a temporary folder and prints its path.

Windows installers are built on a Windows machine (see "The update key" for
the commands) and added to the same release from Git Bash:

```bash
tools/release/publish-local.sh --add \
  "src-tauri/target/release/bundle/nsis/Rig Workbench_X.Y.Z_x64-setup.exe" \
  "src-tauri/target/release/bundle/nsis/Rig Workbench_X.Y.Z_x64-setup.exe.sig" \
  "src-tauri/target/release/bundle/msi/Rig Workbench_X.Y.Z_x64_en-US.msi"
```

`--add` uploads the files, downloads every signature already on the release
and replaces `latest.json` with one covering all of them. Until it runs, a
Windows copy is simply not offered the update.

## Cutting one

1. Set the version in the three places, which must agree:
   `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`
   (then `npm install` and a `cargo build` to update both lockfiles).
2. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`
   and start a new empty `Unreleased` above it. That section becomes the notes
   the app shows under "What's new".
3. Commit to `main` and push it.
4. Either run `tools/release/publish-local.sh --daemon-tag <fork tag>`, or tag
   the commit `vX.Y.Z`, push the tag, and publish the draft when the workflow
   is green.

Each copy checks on launch and offers the update under the toolbar; clicking
the version number in the toolbar, or **Settings → Updates**, checks on
demand. On Windows the installer runs passively and the app restarts itself.

## The OpenRig daemon

The app needs the edge routes of the fork
[kairos-tech-oh/openrig](https://github.com/kairos-tech-oh/openrig). The
contract with the fork, agreed with its maintainers:

- Versions are upstream's next patch plus a suffix, `X.Y.(Z+1)-kairos.N`
  (upstream 0.6.7 gives 0.6.8-kairos.1, .2, …), so a fork build sorts above
  the upstream release it is based on and is never mistaken for it.
- Each is a published GitHub release tagged `v<version>`, built with
  `scripts/build-package.sh` from the clean tagged commit, so the daemon's
  `/healthz` reports that version, that commit and `dirty: false`.
- Its assets are exactly `openrig-cli-<version>.tgz` and
  `openrig-cli-<version>.tgz.sha256` (`sha256sum` format).

`publish-local.sh --daemon-tag v<version>` downloads those two files, checks the
sha256, reads the version and commit stamped inside the tarball (refusing a
dirty build or one that does not match the tag), and **signs the tarball with
the app's update key**. The tarball, its `.sig` and a small
`openrig-cli-<version>.json` go on the app release, and `latest.json` gets:

```json
"daemon": { "version": "0.6.8-kairos.1", "commit": "…", "url": "…/openrig-cli-0.6.8-kairos.1.tgz", "signature": "…" }
```

So the daemon is trusted the same way as the app: the app downloads the
tarball and installs it only if its signature verifies against the public key
compiled into the app (`src-tauri/src/daemon_update.rs`). The fork's sha256 only
guards the hop from the fork release to the maintainer's machine.

**Settings → Updates** offers the daemon only when the running daemon is an
older fork release: it leaves alone a daemon that is up to date, newer, built
from a dirty tree, built from source at the released version (same version,
other commit), or not a fork release at all. The update stops the daemon
(`rig daemon stop` leaves tmux seats running; the queue is in SQLite on disk),
installs the tarball with the npm next to the node the daemon runs on and into
the prefix it was installed in, and starts it with the environment the old
daemon had, adding `--no-kernel` when no kernel rig is managed. A failed install
starts the previous daemon again. This is Linux only; on Windows the daemon runs
in WSL and is updated there by hand.

## The update key

Updates are signed with a minisign key. The public half is in
`src-tauri/tauri.conf.json` (`plugins.updater.pubkey`) and is compiled into
every build; the private half signs releases (in CI or in `publish-local.sh`)
and the daemon tarball. An installed copy refuses
any update the private key did not sign.

The private key and its password are held by the maintainer, outside the
repository (on the build machine: `%USERPROFILE%\.tauri\rig-workbench-updater.key`
and `rig-workbench-updater.password.txt`, or `~/.tauri/` on Linux, where
`publish-local.sh` looks for them). It is a different key from Home
Ledger's. In the repository's **Settings → Secrets and variables → Actions**
they are:

- `TAURI_SIGNING_PRIVATE_KEY`: the contents of the `.key` file.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the contents of the password file.

With the GitHub CLI, from PowerShell, without the values ever being shown:

```powershell
Get-Content "$env:USERPROFILE\.tauri\rig-workbench-updater.key" -Raw |
  gh secret set TAURI_SIGNING_PRIVATE_KEY --repo kairos-tech-oh/rig-workbench
Get-Content "$env:USERPROFILE\.tauri\rig-workbench-updater.password.txt" -Raw |
  gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo kairos-tech-oh/rig-workbench
```

**If the private key is lost, installed copies can never be updated
automatically again**: a new key means a new public key, which only a manually
installed build carries. Keep both files in a password manager as well as in
the secrets.

A build without the key — a local `npm run tauri build`, a pull request from a
fork — simply produces no update artifacts. Only a tagged release insists on
them.

To build a signed installer locally, as CI does:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$env:USERPROFILE\.tauri\rig-workbench-updater.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = Get-Content "$env:USERPROFILE\.tauri\rig-workbench-updater.password.txt" -Raw
node tools/release/ci-config.mjs ci.conf.json
npm run tauri -- build --bundles nsis,msi --config ci.conf.json
```

## Windows code signing

Unsigned installers work, but Windows SmartScreen warns that the publisher is
unknown. The workflow is wired for
[Azure Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/)
and switched off, as in Home Ledger. To switch it on:

1. In Azure, create a Trusted Signing account, complete identity validation,
   and create a *public trust* certificate profile.
2. Create an app registration (service principal) with the *Trusted Signing
   Certificate Profile Signer* role on that account.
3. In the repository's Actions settings add:
   - variables: `AZURE_SIGNING_ENDPOINT` (the account's region endpoint, such as
     `https://eus.codesigning.azure.net`), `AZURE_SIGNING_ACCOUNT`,
     `AZURE_SIGNING_PROFILE`, and `WINDOWS_SIGNING` = `trusted-signing`;
   - secrets: `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`.

`tools/release/ci-config.mjs` then adds a `signCommand` and the Windows job
installs `trusted-signing-cli` to run it. With `WINDOWS_SIGNING` set but a
setting missing, the build fails rather than shipping unsigned.

## The AppImage and libwayland

Left alone, Tauri's AppImage bundles the build machine's libwayland but not
Mesa, which always comes from the machine running the app. A Mesa newer than
the bundled libwayland (Mesa 25 and later) cannot create an EGL display with
it, and the window stays blank or never opens. The `.deb` and `.rpm` link the
system's libwayland and are unaffected.

So the workflow's AppImage step sets
`LINUXDEPLOY_EXCLUDED_LIBRARIES=libwayland-*.so*`, which linuxdeploy (the
tool Tauri bundles AppImages with, inheriting the build's environment) reads
as filename patterns not to bundle. `tools/release/appimage-check.sh` then
fails the job if any libwayland is still inside, because the updater gives
every Linux copy that file.

Home Ledger instead seeds Tauri's tool cache with a patched linuxdeploy GTK
plugin. That stopped working with Tauri CLI 2.12, which embeds the plugin and
overwrites any cached copy that differs, so it is not used here.
