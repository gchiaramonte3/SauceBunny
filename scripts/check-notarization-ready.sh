#!/usr/bin/env bash
#
# Pre-flight check for `npm run tauri build` → notarized .dmg.
# Run this BEFORE every release. Refuses to pass if anything is set
# up in a way that will get the bundle rejected by Apple's notarytool
# or break at runtime on a user's Mac.
#
# Exit code is non-zero on any failure so it can gate CI / pre-commit.
#
# Usage: bash scripts/check-notarization-ready.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

fail=0
pass()  { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn()  { printf "  \033[33m⚠\033[0m %s\n" "$1"; }
fatal() { printf "  \033[31m✗\033[0m %s\n" "$1"; fail=$((fail + 1)); }

echo "── Sidecar discipline ──────────────────────────────────────────"
echo "  (every binary must be self-contained — no Homebrew / user-dir dylib refs)"
echo
# Required set FIRST (review fix): the dylib loop below only audits binaries
# that exist, so a missing sidecar sailed through silently. ffprobe going
# missing would quietly degrade every seek to keyframe precision (the RC7
# epoch probe falls back to the rebased timeline with no hard failure).
REQUIRED_SIDECARS="yt-dlp ffmpeg ffprobe whisper-cli saucebunny-diarize saucebunny-dictate saucebunny-capture llama-server"
for req in $REQUIRED_SIDECARS; do
  bin="${ROOT_DIR}/src-tauri/binaries/${req}-aarch64-apple-darwin"
  if [ ! -f "$bin" ]; then
    fatal "${req} MISSING from src-tauri/binaries/ (npm run setup / the matching build script)"
  elif [ ! -s "$bin" ]; then
    # -f is true for a 0-byte CI/iCloud-evicted stub; that would ship a DMG
    # with a dead sidecar. Require real content + a Mach-O header.
    fatal "${req} is a 0-byte stub — rebuild it (npm run build:${req#saucebunny-} or refresh:sidecars)"
  elif ! file "$bin" | grep -q 'Mach-O'; then
    fatal "${req} is not a Mach-O executable (corrupt/evicted) — rebuild it"
  else
    pass "${req} present + non-empty Mach-O"
  fi
done
echo

# Integrity: are these the exact bytes we decided to ship?
#
# The self-containment check below proves a binary will RUN on someone else's
# Mac. It says nothing about whether the binary is the one we reviewed. Until
# sidecars.lock.json existed, ffmpeg was fetched by scraping a vendor's
# homepage for a filename and yt-dlp came from a mutable "latest" pointer, so
# the answer to "what is in the .dmg you signed" was "whatever the network
# served that day". This gate is the last place to catch that before a release
# goes out with your signature on it.
if bash "${ROOT_DIR}/scripts/verify-sidecars.sh" --quiet; then
  pass "every sidecar matches its pin in sidecars.lock.json"
else
  fatal "a sidecar does not match sidecars.lock.json (see above) — do not ship until you know why"
fi
echo
for bin in "${ROOT_DIR}"/src-tauri/binaries/*-aarch64-apple-darwin; do
  [ -f "$bin" ] || continue
  name=$(basename "$bin" -aarch64-apple-darwin)
  # BSD grep doesn't support negative lookahead; simple alternation is
  # fine since no system dylib actually lives under /opt/homebrew or
  # /Users.
  #
  # tail -n +2 skips otool's first line, which is the binary's own
  # path (would always match `/Users/` and produce false positives).
  # The `: $` filter also drops the universal-binary architecture
  # headers (e.g. "/.../yt-dlp (architecture arm64):").
  leaks=$(otool -L "$bin" 2>/dev/null \
    | tail -n +2 \
    | grep -v ': *$' \
    | grep -E '/opt/homebrew/|/usr/local/|/Users/' || true)
  if [ -n "$leaks" ]; then
    fatal "$name has non-system dylib references:"
    echo "$leaks" | sed 's/^/      /'
  else
    pass "$name"
  fi
done

echo
echo "── ffmpeg filters ──────────────────────────────────────────────"
# The 10-bit/HDR playback prep (media.rs) emits zscale/tonemap filter
# chains. Those need libzimg compiled into the static ffmpeg — swscale
# alone is NOT enough — and a refreshed sidecar without them would fail
# playback for every 10-bit/HDR file. Catch that at release time.
FFMPEG_BIN="${ROOT_DIR}/src-tauri/binaries/ffmpeg-aarch64-apple-darwin"
if [ -f "$FFMPEG_BIN" ]; then
  filters=$("$FFMPEG_BIN" -hide_banner -filters 2>/dev/null || true)
  for f in zscale tonemap setparams; do
    if echo "$filters" | grep -qE "^ .. ${f} "; then
      pass "ffmpeg has filter: $f"
    else
      fatal "ffmpeg is missing the '$f' filter (needed by 10-bit/HDR playback prep — rebuild/re-fetch an ffmpeg with libzimg)"
    fi
  done
else
  fatal "ffmpeg sidecar missing — run npm run refresh:ffmpeg"
fi

echo
echo "── Entitlements ────────────────────────────────────────────────"
ENT="${ROOT_DIR}/src-tauri/entitlements.plist"
if [ -f "$ENT" ]; then
  pass "entitlements.plist present"
  # Guard against accidentally shipping a debug build with get-task-allow.
  if grep -q 'get-task-allow' "$ENT"; then
    fatal "entitlements.plist contains 'get-task-allow' — strip before notarization (debug-only)"
  fi
  # Make sure tauri.conf.json points at it.
  CONF_ENT=$(node -e "console.log(require('${ROOT_DIR}/src-tauri/tauri.conf.json').bundle?.macOS?.entitlements ?? '')")
  if [ "$CONF_ENT" = "entitlements.plist" ]; then
    pass "tauri.conf.json references entitlements.plist"
  else
    fatal "tauri.conf.json bundle.macOS.entitlements is not set (got: '$CONF_ENT')"
  fi
else
  fatal "entitlements.plist missing at $ENT"
fi

echo
echo "── Minimum macOS version ───────────────────────────────────────"
MIN=$(node -e "console.log(require('${ROOT_DIR}/src-tauri/tauri.conf.json').bundle?.macOS?.minimumSystemVersion ?? '')")
if [ "$MIN" = "14.0" ]; then
  pass "minimumSystemVersion = $MIN (FluidAudio + native dictation floor)"
else
  fatal "minimumSystemVersion = '$MIN' — must be exactly 14.0 (the real floor everywhere: Package.swift, README, CLAUDE.md)"
fi

echo
echo "── Signing identity env var ────────────────────────────────────"
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  case "$APPLE_SIGNING_IDENTITY" in
    "Developer ID Application:"*)
      pass "APPLE_SIGNING_IDENTITY is set + uses Developer ID Application"
      ;;
    "Apple Development:"*)
      fatal "APPLE_SIGNING_IDENTITY is a development cert — notarization will reject. Use a 'Developer ID Application: …' cert."
      ;;
    *)
      warn "APPLE_SIGNING_IDENTITY = '$APPLE_SIGNING_IDENTITY' (not a Developer ID Application cert)"
      ;;
  esac
else
  fatal "APPLE_SIGNING_IDENTITY env var is not set — tauri build will produce an ad-hoc-signed .dmg that won't notarize"
fi

if [ -z "${APPLE_ID:-}" ] || [ -z "${APPLE_PASSWORD:-}" ] || [ -z "${APPLE_TEAM_ID:-}" ]; then
  fatal "APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID env vars missing — needed for notarytool (see docs/DISTRIBUTION.md)"
else
  pass "notarytool env vars present (APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID)"
fi

echo
echo "── Version lockstep ────────────────────────────────────────────"
PKG_V=$(node -p "require('${ROOT_DIR}/package.json').version")
CONF_V=$(node -p "require('${ROOT_DIR}/src-tauri/tauri.conf.json').version")
CARGO_V=$(awk '/^\[package\]/{p=1} /^\[/&&!/^\[package\]/{p=0} p&&/^version *=/{gsub(/[" ]/,"",$3); print $3; exit}' "${ROOT_DIR}/src-tauri/Cargo.toml")

if [ "$PKG_V" = "$CONF_V" ] && [ "$CONF_V" = "$CARGO_V" ]; then
  pass "version is $PKG_V in all three files"
else
  fatal "version drift — package.json=$PKG_V tauri.conf.json=$CONF_V Cargo.toml=$CARGO_V (run: bash scripts/set-version.sh X.Y.Z)"
fi

# Bare X.Y.Z only: Tauri's updater compares with semver, and a suffixed
# version like "1.1.0-beta" sorts BELOW "1.1.0".
echo "$CONF_V" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' \
  && pass "version is bare semver (updater-safe)" \
  || fatal "version '$CONF_V' is not bare X.Y.Z"

# The DMG filename is the only thing a user sees; 1.0.0 forever means
# every download looks identical. Refuse to ship a version already tagged.
if git -C "${ROOT_DIR}" rev-parse "v${CONF_V}" >/dev/null 2>&1; then
  fatal "v${CONF_V} is already tagged — bump before building (bash scripts/set-version.sh X.Y.Z)"
else
  pass "v${CONF_V} is not yet tagged"
fi

# CFBundleVersion must be present and distinct per build.
BUNDLE_V=$(node -p "require('${ROOT_DIR}/src-tauri/tauri.conf.json').bundle?.macOS?.bundleVersion ?? ''")
[ -n "$BUNDLE_V" ] \
  && pass "CFBundleVersion = $BUNDLE_V" \
  || warn "bundle.macOS.bundleVersion unset — CFBundleVersion defaults to the semver, so same-version rebuilds are indistinguishable"

echo
echo "── Build-ID handshake ──────────────────────────────────────────"
TS_ID=$(grep -oE 'EXPECTED_BACKEND_BUILD_ID = "[^"]+"' "${ROOT_DIR}/src/lib/build-id.ts" | sed 's/.*"\(.*\)"/\1/')
RS_ID=$(grep -oE 'BACKEND_BUILD_ID: &str = "[^"]+"' "${ROOT_DIR}/src-tauri/src/commands/system.rs" | sed 's/.*"\(.*\)"/\1/')
if [ -n "$TS_ID" ] && [ "$TS_ID" = "$RS_ID" ]; then
  pass "build-id matches ($TS_ID)"
else
  fatal "build-id mismatch — build-id.ts='$TS_ID' system.rs='$RS_ID'"
fi

echo
echo "── Toolchain ───────────────────────────────────────────────────"
command -v cargo >/dev/null && pass "cargo present" || fatal "cargo missing — install Rust"
command -v swift >/dev/null && pass "swift present" || fatal "swift missing — install Xcode CLT"
command -v node  >/dev/null && pass "node present"  || fatal "node missing"
command -v xcrun >/dev/null && pass "xcrun present" || fatal "xcrun missing — install Xcode CLT"

echo
if [ "$fail" -eq 0 ]; then
  printf "\033[32m✓ All checks passed — safe to run \`npm run tauri build\`\033[0m\n"
  exit 0
else
  printf "\033[31m✗ %d check(s) failed — fix before building\033[0m\n" "$fail"
  exit 1
fi
