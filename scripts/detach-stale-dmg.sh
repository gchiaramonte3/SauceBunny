#!/usr/bin/env bash
#
# Detach leftover DMG staging volumes from a previous build of THIS repo.
#
# bundle_dmg.sh builds the disk image by attaching a read-write scratch copy
# (bundle/macos/rw.<pid>.<name>.dmg) at /Volumes/dmg.XXXXXX and detaching it at
# the end. When a build is interrupted - or fails partway - that detach never
# happens, and the volume stays attached at the DEVICE level. The next build
# then dies in bundle_dmg.sh, and `rm -rf target/release/bundle` does NOT fix
# it, because the mount does not live in the build tree. The error tauri prints
# ("failed to run bundle_dmg.sh") says nothing about any of this, so the second
# failure looks like the first one and costs the same twenty minutes.
#
# Scope is deliberately narrow: only images whose backing file is inside THIS
# repo, and only ones matching the rw.* staging shape. Someone's mounted
# installer DMG is not ours to eject.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

detached=0
while read -r dev; do
  [ -n "$dev" ] || continue
  echo "→ detaching stale build volume $dev"
  hdiutil detach "$dev" -force >/dev/null 2>&1 || echo "  (could not detach $dev; a build may be running)"
  detached=$((detached + 1))
done < <(
  hdiutil info 2>/dev/null | awk -v root="$ROOT" '
    /^image-path/ {
      mine = (index($0, root "/src-tauri/target/release/bundle/macos/rw.") > 0)
    }
    mine && /^\/dev\/disk/ && /\/Volumes\/dmg\./ { print $1; mine = 0 }
  '
)

# The orphaned scratch images themselves, now that nothing is mounted on them.
rm -f src-tauri/target/release/bundle/macos/rw.*.dmg 2>/dev/null || true

if [ "$detached" -gt 0 ]; then
  echo "✓ cleared $detached stale staging volume(s)"
fi
