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

# The NAME comes from the built artifact, not from the manifests.
#
# tauri.conf.json is what the NEXT build will be stamped with, which is not the
# same thing as what this DMG contains: set-version.sh runs at the start of a
# build, so between two builds the config describes a build that does not exist
# yet, and archiving by it files the artifact under a number that was never in
# it. The .app inside the bundle is the only witness to what was actually made.
# The manifests remain the fallback for the case where the .app is gone but the
# DMG is not.
APP_PLIST="src-tauri/target/release/bundle/macos/Sauce Bunny.app/Contents/Info.plist"
if [ -f "$APP_PLIST" ]; then
  VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP_PLIST" 2>/dev/null || echo '')"
  BUILD="$(/usr/libexec/PlistBuddy -c 'Print CFBundleVersion' "$APP_PLIST" 2>/dev/null || echo '')"
fi
[ -n "${VERSION:-}" ] || VERSION="$(node -p "require('./package.json').version")"
[ -n "${BUILD:-}" ] || BUILD="$(node -p "require('./src-tauri/tauri.conf.json').bundle?.macOS?.bundleVersion ?? ''")"
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
  echo "⚠ $BUILD is already archived with DIFFERENT bytes." >&2
  echo "  Either a build ran without re-stamping, or the existing file is damaged." >&2
  echo "  Keeping both; check the older one before trusting it." >&2
fi

# Copy to a scratch name and RENAME into place, so the archived build either
# exists whole or does not exist.
#
# This was a straight `cp` to the final name, and an adversarial review found
# the hole by reproducing it: interrupt the copy and a truncated, unmountable
# DMG is left sitting at the canonical name for ever. Nothing repairs it -
# re-running sees a file already there, finds the bytes differ, and takes the
# collision branch, so the GOOD build is filed under a "(2)" suffix while the
# broken one keeps the name a human reaches for. Worse, once the next build
# overwrites the bundler's single output path, that truncated copy is the only
# copy of the earlier build in existence. Losing a build is the one thing this
# script exists to prevent.
#
# A note on -c, because the comment here used to say the opposite and was
# wrong: `man cp` states that if the target filesystem does not support
# cloning, cp FALLS BACK TO copyfile(2) internally to make the copy succeed.
# So `|| cp` was near-dead code, and it is `cp -c` itself that streams bytes
# on a non-APFS destination - exactly the external disk SB_BUILD_ARCHIVE
# exists to point at. On the default Desktop path (same APFS volume) it is a
# clonefile syscall: instant, and no extra space until one copy changes.
PARTIAL="$TARGET.partial"
# INT and TERM as well as EXIT: a Ctrl-C during a 100MB copy is the likeliest
# way this is ever interrupted, and EXIT alone does not run on a signal.
trap 'rm -f "$PARTIAL"' EXIT INT TERM
cp -c "$DMG" "$PARTIAL" 2>/dev/null || cp "$DMG" "$PARTIAL"
# Same directory, so this is a rename within one filesystem: atomic.
mv "$PARTIAL" "$TARGET"
trap - EXIT INT TERM

# find, not `ls | wc`: ls exits non-zero when the glob matches nothing, and
# under `set -o pipefail` that fails the whole pipeline. CLAUDE.md records the
# same trap biting verify-bundle.sh twice with `grep -q`.
# Both fall back rather than fail. The copy has ALREADY SUCCEEDED by this
# point, so a du that trips over one unreadable entry must not, under
# `set -o pipefail`, abort the script and have the caller report a build that
# was archived correctly as FAILED. Reporting is not the job; keeping the
# build is.
COUNT="$(find "$ARCHIVE" -maxdepth 1 -name '*.dmg' 2>/dev/null | wc -l | tr -d ' ' || echo '?')"
TOTAL="$(du -sh "$ARCHIVE" 2>/dev/null | cut -f1 || echo '?')"

echo "✓ archived    $TARGET"
echo "  archive     ${COUNT} build(s), ${TOTAL} in $ARCHIVE"
