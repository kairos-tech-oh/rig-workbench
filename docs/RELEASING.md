# Releasing

How a version goes from `main` to every installed copy.

## What a release is

Pushing a tag `vX.Y.Z` runs `.github/workflows/build.yml`:

1. `check` type-checks and builds the front end, then checks formatting,
   lints and tests the Rust side. It runs on every push and pull request.
2. `bundle` builds the Windows (NSIS, MSI) and Linux (deb, rpm, AppImage)
   installers. It runs only for a tag or a manual run from the Actions tab,
   and keeps its files for two days: the release is their permanent home.
   With the update key available it also writes a `.sig` beside each
   installer the updater can use.
3. `release` writes `latest.json` from those signatures and creates a **draft**
   GitHub release with everything attached.

A draft is invisible to installed copies. They read
`https://github.com/kairos-tech-oh/rig-workbench/releases/latest/download/latest.json`
(`plugins.updater.endpoints` in `src-tauri/tauri.conf.json`), which only
resolves once the release is **published**. Publishing the draft Actions
made — not a new release made by hand from the tag — is what ships it.

## Cutting one

1. Set the version in the three places, which must agree:
   `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`
   (then `npm install` and a `cargo build` to update both lockfiles).
2. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`
   and start a new empty `Unreleased` above it. That section becomes the notes
   the app shows under "What's new".
3. Commit to `main`, tag the commit `vX.Y.Z`, push the tag.
4. When the workflow is green, open the draft release, read it, publish it.

Each copy checks on launch and offers the update under the toolbar; clicking
the version number in the toolbar checks on demand. On Windows the installer
runs passively and the app restarts itself.

## The repository must be reachable without signing in

The updater, and anyone downloading an installer, fetch the release files
anonymously. **While `kairos-tech-oh/rig-workbench` is private, those requests
get a 404**: an installed copy reports "could not check for updates", and
installers can only be downloaded by someone signed in to GitHub with access
to the repository. Builds and draft releases still work; nothing can be
fetched from them automatically.

Ways to make it work, in order of simplicity:

- **Make the repository public.** Everything here works as written. The
  source becomes public too.
- **Publish releases to a separate public repository** (for example
  `kairos-tech-oh/rig-workbench-releases`) that holds only release files. The
  source stays private. The `release` job then needs a token that can write
  to that repository (a fine-grained personal access token, stored as a
  secret), `softprops/action-gh-release` gets `repository:` and `token:`, and
  `latest-json.mjs` and the updater endpoint name that repository.
- **Host `latest.json` and the installers elsewhere** that serves them
  publicly (an object store bucket, or GitHub Pages of a public repository),
  uploaded by the `release` job. The endpoint points there.
- **Not recommended:** building a GitHub token into the app so it can read the
  private repository's releases. Every installed copy would carry the token.

Without any of these, installs are manual: download the installer from the
release page while signed in, and run it. The in-app check then fails quietly
at launch, and with a message when clicked.

GitHub Actions minutes on a private repository are billed against the
account's allowance, and Windows runners count double.

## The update key

Updates are signed with a minisign key. The public half is in
`src-tauri/tauri.conf.json` (`plugins.updater.pubkey`) and is compiled into
every build; the private half signs releases in CI. An installed copy refuses
any update the private key did not sign.

The private key and its password are held by the maintainer, outside the
repository (on the build machine: `%USERPROFILE%\.tauri\rig-workbench-updater.key`
and `rig-workbench-updater.password.txt`). It is a different key from Home
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
