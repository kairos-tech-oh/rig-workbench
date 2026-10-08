#!/usr/bin/env bash
set -euo pipefail

status=0
for image in "$@"; do
  abs="$(realpath "$image")"
  work="$(mktemp -d)"
  (cd "$work" && "$abs" --appimage-extract > /dev/null)
  found="$(find "$work/squashfs-root" -name 'libwayland-*.so*')"
  rm -rf "$work"
  if [ -n "$found" ]; then
    echo "$image bundles libwayland, which breaks on hosts with a newer Mesa:"
    echo "$found" | sed "s|$work/squashfs-root/||"
    status=1
  else
    echo "$image: no bundled libwayland"
  fi
done
exit $status
