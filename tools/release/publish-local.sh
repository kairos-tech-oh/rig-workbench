#!/usr/bin/env bash
# Builds and publishes a release from this machine, with no GitHub Actions.
# See docs/RELEASING.md, "Publishing without Actions".
set -euo pipefail

REPO="kairos-tech-oh/rig-workbench"
FORK="kairos-tech-oh/openrig"

usage() {
  cat <<'EOF'
Usage:
  tools/release/publish-local.sh [--dry-run] (--daemon-tag <tag> | --no-daemon)
      Build the Linux installers (AppImage, deb, rpm), sign them with the update
      key, attach the OpenRig daemon tarball from the fork release <tag>, write
      latest.json and publish GitHub release v<version> on this commit.

  tools/release/publish-local.sh --add [--dry-run] <file>...
      Upload more files to the existing release v<version> (e.g. the Windows
      installers and their .sig built on Windows), then rebuild latest.json from
      every signature on the release.

  tools/release/publish-local.sh --check-key
      Sign a throwaway file with the update key and check it against the public
      key built into the app. Run it once after putting the key in place.

  --dry-run   Do everything except create or change the GitHub release.

The update key is read from TAURI_SIGNING_PRIVATE_KEY and
TAURI_SIGNING_PRIVATE_KEY_PASSWORD, or else from
~/.tauri/rig-workbench-updater.key and rig-workbench-updater.password.txt.
It is never printed. The script never pushes commits or tags on its own:
the release (and its tag, at this commit) is created only when you run it.
EOF
}

die() { echo "publish-local: $*" >&2; exit 1; }

mode=build dry=0 daemon_tag="" no_daemon=0 extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --dry-run) dry=1 ;;
    --add) mode=add ;;
    --check-key) mode=check-key ;;
    --daemon-tag) daemon_tag="${2:?--daemon-tag needs a tag}"; shift ;;
    --no-daemon) no_daemon=1 ;;
    -*) die "unknown option $1 (see --help)" ;;
    *) extra+=("$1") ;;
  esac
  shift
done

cd "$(git rev-parse --show-toplevel)"
for tool in gh node npm git sha256sum tar; do
  command -v "$tool" > /dev/null || die "$tool is not installed"
done

# One version in all three places, and a clean tree, or nothing happens.
v_conf=$(node -p 'require("./src-tauri/tauri.conf.json").version')
v_pkg=$(node -p 'require("./package.json").version')
v_cargo=$(sed -n 's/^version = "\(.*\)"/\1/p' src-tauri/Cargo.toml | head -1)
[ "$v_conf" = "$v_pkg" ] && [ "$v_conf" = "$v_cargo" ] ||
  die "versions disagree: tauri.conf.json $v_conf, package.json $v_pkg, Cargo.toml $v_cargo"
version=$v_conf tag="v$version"
[ "$mode" = check-key ] || [ -z "$(git status --porcelain)" ] || die "the working tree has changes; commit or stash them first"
head=$(git rev-parse HEAD)
if git rev-parse -q --verify "refs/tags/$tag" > /dev/null; then
  [ "$(git rev-parse "$tag^{commit}")" = "$head" ] || die "tag $tag exists here but is not this commit"
fi
echo "Rig Workbench $version at ${head:0:12}"

load_key() {
  if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    local key="$HOME/.tauri/rig-workbench-updater.key" pass="$HOME/.tauri/rig-workbench-updater.password.txt"
    [ -f "$key" ] || die "no update key: set TAURI_SIGNING_PRIVATE_KEY or create $key"
    TAURI_SIGNING_PRIVATE_KEY=$(cat "$key")
    [ -f "$pass" ] && TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$(cat "$pass")
  fi
  export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
}

if [ "$mode" = check-key ]; then
  load_key
  probe=$(mktemp)
  trap 'rm -f "$probe" "$probe.sig"' EXIT
  echo "update key probe" > "$probe"
  npm run tauri -- signer sign "$probe" > /dev/null
  node tools/release/verify-sig.mjs "$probe" || die "this key is not the one installed copies trust; do not release with it"
  echo "The update key is in place and matches the app's public key."
  exit 0
fi

stage=$(mktemp -d)
# A dry run keeps what it built, so it can be inspected or installed by hand.
[ $dry = 1 ] || trap 'rm -rf "$stage"' EXIT

if [ "$mode" = add ]; then
  [ ${#extra[@]} -gt 0 ] || die "--add needs files to upload"
  gh release view "$tag" -R "$REPO" > /dev/null 2>&1 || die "release $tag does not exist yet; publish it first"
  for f in "${extra[@]}"; do
    [ -f "$f" ] || die "$f does not exist"
    case "$(basename "$f")" in *"$version"*) ;; *) die "$f is not named for $version" ;; esac
    cp "$f" "$stage/"
  done
  # Every signature already on the release, so latest.json covers all platforms.
  for f in "${extra[@]}"; do
    [ ! -f "$f.sig" ] || node tools/release/verify-sig.mjs "$f" || die "$f is not signed by the update key"
  done
  gh release download "$tag" -R "$REPO" -D "$stage" -p '*.sig' -p 'openrig-cli-*.json' --skip-existing
  node tools/release/latest-json.mjs "$stage" "$tag" "$REPO" "$stage/latest.json"
  if [ $dry = 1 ]; then
    echo "--dry-run: would upload ${extra[*]} and replace latest.json:"
    cat "$stage/latest.json"
    exit 0
  fi
  gh release upload "$tag" -R "$REPO" "${extra[@]}"
  gh release upload "$tag" -R "$REPO" "$stage/latest.json" --clobber
  echo "Added to $tag: ${extra[*]}"
  exit 0
fi

[ ${#extra[@]} -eq 0 ] || die "unexpected arguments: ${extra[*]} (see --help)"
[ -n "$daemon_tag" ] || [ $no_daemon = 1 ] || die "name the daemon with --daemon-tag <fork tag>, or pass --no-daemon"
if gh release view "$tag" -R "$REPO" > /dev/null 2>&1; then
  die "release $tag already exists; use --add to attach more files"
fi
if ! gh api "repos/$REPO/commits/$head" > /dev/null 2>&1; then
  [ $dry = 1 ] || die "commit ${head:0:12} is not on GitHub; push it first"
  echo "warning: commit ${head:0:12} is not on GitHub; a real run would stop here"
fi
grep -q "^## \[$version\]" CHANGELOG.md || echo "warning: CHANGELOG.md has no [$version] section; the notes will be a plain heading"
load_key

npm ci
node tools/release/ci-config.mjs "$stage/ci.conf.json"
npm run tauri -- build --bundles deb,rpm --config "$stage/ci.conf.json"
LINUXDEPLOY_EXCLUDED_LIBRARIES='libwayland-*.so*' npm run tauri -- build --bundles appimage --config "$stage/ci.conf.json"
bundle=src-tauri/target/release/bundle
tools/release/appimage-check.sh "$bundle"/appimage/*"$version"*.AppImage
cp "$bundle"/appimage/*"$version"*.AppImage{,.sig} "$bundle"/deb/*"$version"*.deb "$bundle"/rpm/*"$version"*.rpm "$stage/"

if [ -n "$daemon_tag" ]; then
  # The fork's tarball is checked against its sha256, then signed with our update key.
  gh release download "$daemon_tag" -R "$FORK" -D "$stage" -p 'openrig-cli-*.tgz' -p 'openrig-cli-*.tgz.sha256'
  tgz=$(ls "$stage"/openrig-cli-*.tgz)
  (cd "$stage" && sha256sum -c "$(basename "$tgz").sha256")
  info=$(tar -xzOf "$tgz" package/daemon/dist/build-info.js)
  d_version=$(sed -n 's/^ *semver: "\(.*\)",/\1/p' <<< "$info")
  d_commit=$(sed -n 's/^ *commit: "\(.*\)",/\1/p' <<< "$info")
  grep -q 'dirty: false' <<< "$info" || die "$daemon_tag was built from a dirty tree"
  [ "v$d_version" = "$daemon_tag" ] || die "$daemon_tag holds daemon $d_version"
  [ "$(basename "$tgz")" = "openrig-cli-$d_version.tgz" ] || die "unexpected tarball name $(basename "$tgz")"
  npm run tauri -- signer sign "$tgz" > /dev/null
  printf '{ "version": "%s", "commit": "%s" }\n' "$d_version" "$d_commit" > "${tgz%.tgz}.json"
  echo "Daemon $d_version (${d_commit:0:12}) signed"
fi

# Nothing ships unless installed copies would accept its signature.
signed=("$stage"/*.AppImage)
[ -z "$daemon_tag" ] || signed+=("$tgz")
node tools/release/verify-sig.mjs "${signed[@]}" || die "a signature does not match the app's public key"
node tools/release/latest-json.mjs "$stage" "$tag" "$REPO" "$stage/latest.json"
rm -f "$stage/ci.conf.json"
# This version's changelog section, as on the release page.
node -e 'console.log(require(process.argv[1]).notes)' "$stage/latest.json" > "$stage/notes.md"

if [ $dry = 1 ]; then
  echo "--dry-run: would publish $tag at ${head:0:12} with these files, kept in $stage:"
  ls -1 "$stage" | grep -v '^notes.md$'
  cat "$stage/latest.json"
  exit 0
fi
files=()
for f in "$stage"/*; do [ "$(basename "$f")" = notes.md ] || files+=("$f"); done
gh release create "$tag" -R "$REPO" --target "$head" --title "Rig Workbench $version" --notes-file "$stage/notes.md" "${files[@]}"
echo "Published $tag. Fetch the tag with: git fetch --tags"
