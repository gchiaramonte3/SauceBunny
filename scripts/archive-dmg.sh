#!/usr/bin/env bash
#
# Keep every DMG that gets built, instead of writing over yesterday's.
#
# Why this exists, concretely: the bundler writes to ONE path,
#
#   src-tauri/target/release/bundle/dmg/Sauce Bunny_<semver>_aarch64.dmg
#
# and the semver deliberately does NOT move between builds handed to someone
# for testing - scripts/check-changelog.sh says as much in as many words: a
# bump is a release. So consecutive test builds collide on the filename and
# the older one is simply gone. That is not hypothetical. Build 2026082903
# was overwritten by 2026083101 within a day, and nothing announced it.
#
# What distinguishes two builds of one semver is CFBundleVersion, which is
# also what Settings ▸ About shows. So that is what the archived name carries,
# and the two together are the whole point: a folder where "the build I sent
# on Tuesday" is a file you can actually put your hands on.
#
# The Desktop is the default because that is where it was asked for and where
# a build is easy to find. SB_BUILD_ARCHIVE overrides it, which is how you
# move the archive to another disk later without editing this script.
#
# Nothing here ever deletes or overwrites. Old builds accumulate on purpose;
# that is the feature. The size is printed on every run so it stays a thing
# you decided rather than a thing you discovered.

set -euo pipefail
cd "$(dirname "$0")/.."

# CI has no Desktop and no reason to keep artifacts this way.
if [ -n "${CI:-}" ]; then
  echo "→ CI: skipping build archive"
  exit 0
fi

VERSION="$(node -p "require('./package.json').version")"
BUILD="$(node -p "require('./src-tauri/tauri.conf.json').bundle?.macOS?.bundleVersion ?? ''")"
DMG="src-tauri/target/release/bundle/dmg/Sauce Bunny_${VERSION}_aarch64.dmg"

if [ ! -f "$DMG" ]; then
  echo "✗ nothing to archive: $DMG does not exist" >&2
  exit 1
fi
if [ -z "$BUILD" ]; then
  # Without a build number two DMGs of one semver are indistinguishable, which
  # is the exact problem this script exists to solve. Refuse rather than
  # archive something that cannot be told apart later.
  echo "✗ tauri.conf.json has no bundle.macOS.bundleVersion; run scripts/set-version.sh" >&2
  exit 1
fi

ARCHIVE="${SB_BUILD_ARCHIVE:-$HOME/Desktop/Sauce Bunny Builds}"
mkdir -p "$ARCHIVE"

TARGET="$ARCHIVE/Sauce Bunny $VERSION ($BUILD).dmg"

if [ -e "$TARGET" ]; then
  # Same bytes: already archived, and re-running is not an error.
  if cmp -s "$DMG" "$TARGET"; then
    echo "✓ already archived  $TARGET"
    exit 0
  fi
  # Same stamp, different bytes. That means a build ran without re-stamping,
  # so the number lies about which build this is - but the older file is still
  # somebody's build and must not be destroyed to make room for this one.
  n=2
  while [ -e "${TARGET%.dmg} ($n).dmg" ]; do n=$((n + 1)); done
  TARGET="${TARGET%.dmg} ($n).dmg"
  echo "⚠ a different build is already stamped $BUILD; archiving alongside it" >&2
fi

# -c clones on APFS: instant, and costs no extra space until one of the two
# copies changes, which neither ever does. Falls back for any other filesystem.
cp -c "$DMG" "$TARGET" 2>/dev/null || cp "$DMG" "$TARGET"

# find, not `ls | wc`: ls exits non-zero when the glob matches nothing, and
# under `set -o pipefail` that fails the whole pipeline. CLAUDE.md records the
# same trap biting verify-bundle.sh twice with `grep -q`.
COUNT="$(find "$ARCHIVE" -maxdepth 1 -name '*.dmg' | wc -l | tr -d ' ')"
TOTAL="$(du -sh "$ARCHIVE" | cut -f1)"

echo "✓ archived    $TARGET"
echo "  archive     ${COUNT} build(s), ${TOTAL} in $ARCHIVE"
