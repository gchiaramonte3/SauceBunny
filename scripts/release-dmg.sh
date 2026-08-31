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
# over a mount, verify the artifact, keep a copy under its build number, and
# print an absolute path.
#
#   4. The bundler writes to one filename per semver, and a test build does not
#      move the semver, so each build silently replaced the last. Step 5 copies
#      it out to an archive keyed by CFBundleVersion. See scripts/archive-dmg.sh.

set -euo pipefail
cd "$(dirname "$0")/.."

WANT_VERSION="${1:-}"

echo "── 1/6  clearing stale staging volumes"
bash scripts/detach-stale-dmg.sh

echo "── 2/6  stamping version"
if [ -n "$WANT_VERSION" ]; then
  bash scripts/set-version.sh "$WANT_VERSION"
else
  bash scripts/set-version.sh
fi
VERSION="$(node -p "require('./package.json').version")"

# A semver bump is a RELEASE and needs a CHANGELOG entry; a re-stamp is a dev
# build and needs nothing. Checked only when the caller asked for a new semver,
# so handing someone a test build stays frictionless.
if [ -n "$WANT_VERSION" ]; then
  bash scripts/check-changelog.sh
fi

echo "── 3/6  building (this is the slow part)"
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

echo "── 4/6  verifying the artifact"
npm run --silent verify:bundle

echo "── 5/6  keeping this build"
# Not fatal, and not quiet either. The build succeeded and the DMG is on disk
# whatever happens here, so failing the whole command would misreport that.
# But an archive that silently stopped working is how you lose a build without
# noticing, so it gets a line in the summary either way.
ARCHIVED="yes"
if ! bash scripts/archive-dmg.sh; then
  ARCHIVED="FAILED - see above; this build is only in the build tree"
fi

echo "── 6/6  done"
BUILD_NO="$(/usr/libexec/PlistBuddy -c 'Print CFBundleVersion' \
  "src-tauri/target/release/bundle/macos/Sauce Bunny.app/Contents/Info.plist" 2>/dev/null || echo '?')"
# Leave the volumes clean for the NEXT build rather than for this one.
bash scripts/detach-stale-dmg.sh
echo
echo "  version  v${VERSION} (${BUILD_NO})"
echo "  dmg      $(cd "$(dirname "$DMG")" && pwd)/$(basename "$DMG")"
echo "  archived ${ARCHIVED}"
echo
