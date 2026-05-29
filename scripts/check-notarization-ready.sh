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
if [ -z "$MIN" ]; then
  warn "no minimumSystemVersion set in tauri.conf.json (Apple defaults to 10.13)"
elif [ "$MIN" = "13.0" ] || [ "${MIN%%.*}" -ge 13 ] 2>/dev/null; then
  pass "minimumSystemVersion = $MIN (matches CLAUDE.md target)"
else
  warn "minimumSystemVersion = $MIN — CLAUDE.md says macOS 13+"
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
  warn "APPLE_SIGNING_IDENTITY env var is not set — tauri build will produce an ad-hoc-signed .dmg that won't notarize"
fi

if [ -z "${APPLE_ID:-}" ] || [ -z "${APPLE_PASSWORD:-}" ] || [ -z "${APPLE_TEAM_ID:-}" ]; then
  warn "APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID env vars missing — needed for notarytool (see DISTRIBUTION.md)"
else
  pass "notarytool env vars present (APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID)"
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
