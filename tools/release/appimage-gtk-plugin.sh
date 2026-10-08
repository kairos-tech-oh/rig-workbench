#!/usr/bin/env bash
set -euo pipefail

rev=dda522bce37387f1b853d9095713bfaa924c8423
sum=7804c9eef13e59bf2783aad9882ef9db8f3f3f9e8d631874b1d348d550a3693f
dir="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
out="$dir/linuxdeploy-plugin-gtk.sh"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

curl -fsSL "https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/$rev/linuxdeploy-plugin-gtk.sh" -o "$tmp"
echo "$sum  $tmp" | sha256sum -c --quiet -

mkdir -p "$dir"
{
  cat "$tmp"
  echo
  echo "find \"\$APPDIR\" -name 'libwayland-*.so*' -print -delete"
} > "$out"
chmod +x "$out"
echo "seeded $out"
