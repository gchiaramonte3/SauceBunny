#!/usr/bin/env bash
#
# Build a DMG, reliably, and say exactly where it is.
#
#   bash scripts/release-dmg.sh 0.2.4   # bump semver, then build
#   bash scripts/release-dmg.sh         # keep semver, restamp build number
#
# This exists because doing it by hand went wrong three separate ways in one
# day, and every one of them was silent or misleading:
#
#   1. Nothing forced scripts/set-version.sh to run, so four DMGs shipped as
#      the same 0.2.0 with a build number stamped three weeks earlier.
#   2. `npm run build:dmg` passes no argument, which KEEPS the semver and only
#      restamps the build number - so "bump the version" quietly did not.
#   3. bundle_dmg.sh dies if a previous run left its scratch volume attached,
#      and tauri reports only "failed to run bundle_dmg.sh". Deleting the build
#      tree does not help: the mount is at the device level.
#
# So: clean first, stamp deliberately, build, retry once if the bundler trips
# over a mount, verify the artifact, print an absolute path.

set -euo pipefail
cd "$(dirname "$0")/.."

WANT_VERSION="${1:-}"

echo "── 1/5  clearing stale staging volumes"
bash scripts/detach-stale-dmg.sh

echo "── 2/5  stamping version"
if [ -n "$WANT_VERSION" ]; then
  bash scripts/set-version.sh "$WANT_VERSION"
else
  bash scripts/set-version.sh
fi
VERSION="$(node -p "require('./package.json').version")"

echo "── 3/5  building (this is the slow part)"
# Bundling is the only step that trips over a mount, and it happens last, so a
# retry costs the bundler and not the whole compile.
if ! npx tauri build; then
  echo "   build failed; clearing mounts and retrying bundling once"
  bash scripts/detach-stale-dmg.sh
  npx tauri build
fi

DMG="src-tauri/target/release/bundle/dmg/Sauce Bunny_${VERSION}_aarch64.dmg"
if [ ! -f "$DMG" ]; then
  echo "✗ build reported success but $DMG is missing" >&2
  exit 1
fi

echo "── 4/5  verifying the artifact"
npm run --silent verify:bundle

echo "── 5/5  done"
BUILD_NO="$(/usr/libexec/PlistBuddy -c 'Print CFBundleVersion' \
  "src-tauri/target/release/bundle/macos/Sauce Bunny.app/Contents/Info.plist" 2>/dev/null || echo '?')"
# Leave the volumes clean for the NEXT build rather than for this one.
bash scripts/detach-stale-dmg.sh
echo
echo "  version  v${VERSION} (${BUILD_NO})"
echo "  dmg      $(cd "$(dirname "$DMG")" && pwd)/$(basename "$DMG")"
echo
