#!/usr/bin/env bash
#
# Single source of the release version. Writes the SAME semver into every
# file that declares one, and stamps a date-based CFBundleVersion so two
# builds of the same semver are still distinguishable in Finder / crash logs.
#
#   package.json                  "version"
#   src-tauri/tauri.conf.json     "version"            -> CFBundleShortVersionString
#   src-tauri/Cargo.toml          [package] version
#   src-tauri/tauri.conf.json     bundle.macOS.bundleVersion -> CFBundleVersion (YYYYMMDDNN)
#
# CFBundleShortVersionString stays plain semver on purpose: Tauri's updater
# compares manifest versions with semver rules, and a date string like
# "2026.7.19-1" would sort BELOW "2026.7.19" (the `-1` reads as a prerelease).
# Date-versioning belongs in CFBundleVersion, which nothing compares.
#
# Usage:
#   bash scripts/set-version.sh 1.1.0
#   bash scripts/set-version.sh          # re-stamp bundleVersion only (no semver change)

set -euo pipefail
cd "$(dirname "$0")/.."

CONF="src-tauri/tauri.conf.json"
CARGO="src-tauri/Cargo.toml"
PKG="package.json"

NEW_VERSION="${1:-}"
if [ -n "$NEW_VERSION" ]; then
  echo "$NEW_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || {
    echo "✗ '$NEW_VERSION' is not a bare X.Y.Z semver (the updater requires it)" >&2
    exit 1
  }
else
  NEW_VERSION="$(node -p "require('./$PKG').version")"
  echo "→ no version argument; keeping $NEW_VERSION, re-stamping build number"
fi

# ── CFBundleVersion: YYYYMMDD + 2-digit build-of-day, monotonic ──────────
TODAY="$(date -u +%Y%m%d)"
PREV="$(node -p "require('./$CONF').bundle?.macOS?.bundleVersion ?? ''")"
if [ "${PREV:0:8}" = "$TODAY" ]; then
  SEQ="$(printf '%02d' $((10#${PREV:8:2} + 1)))"
else
  SEQ="01"
fi
BUNDLE_VERSION="${TODAY}${SEQ}"

# ── Write tauri.conf.json (node, so JSON stays valid + formatting stable) ─
node -e '
  const fs = require("fs");
  const p = process.argv[1], v = process.argv[2], bv = process.argv[3];
  const c = JSON.parse(fs.readFileSync(p, "utf8"));
  c.version = v;
  c.bundle = c.bundle || {};
  c.bundle.macOS = c.bundle.macOS || {};
  c.bundle.macOS.bundleVersion = bv;
  fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
' "$CONF" "$NEW_VERSION" "$BUNDLE_VERSION"

node -e '
  const fs = require("fs");
  const p = process.argv[1], v = process.argv[2];
  const c = JSON.parse(fs.readFileSync(p, "utf8"));
  c.version = v;
  fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
' "$PKG" "$NEW_VERSION"

# ── Cargo.toml: only the [package] version, which is the 3rd line region.
# Anchored to the first `version = ` after `[package]` so dependency
# versions further down are never touched.
awk -v v="$NEW_VERSION" '
  /^\[package\]/ { inpkg = 1 }
  /^\[/ && !/^\[package\]/ { inpkg = 0 }
  inpkg && /^version *=/ && !done { print "version = \"" v "\""; done = 1; next }
  { print }
' "$CARGO" > "$CARGO.tmp" && mv "$CARGO.tmp" "$CARGO"

echo "✓ version      $NEW_VERSION   (package.json, tauri.conf.json, Cargo.toml)"
echo "✓ bundleVersion $BUNDLE_VERSION  (CFBundleVersion)"
echo
echo "Next: add a '## [$NEW_VERSION] — $(date -u +%Y-%m-%d)' heading in CHANGELOG.md,"
echo "      then: git commit -am \"release: $NEW_VERSION\" && git tag v$NEW_VERSION"
