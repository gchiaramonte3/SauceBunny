#!/usr/bin/env bash
# Assert that a BUILT .app is actually shippable.
#
# WHY THIS EXISTS
# Every gate this project had ran against source: tsc, vitest, clippy, cargo
# test, Playwright-with-mocked-IPC. Nothing ever looked at the artifact. Three
# real defects walked straight through that gap:
#
#   · the CSP in the packaged binary forbade WebAssembly, so audio was silent
#     in the .dmg and fine in `tauri dev` (three user reports to find);
#   · `Contents/Resources/licenses` shipped as a single FILE containing only
#     THIRD-PARTY-LICENSES.md, so the MIT LICENSE and the GPLv3 text that
#     bundled ffmpeg requires were in NO build;
#   · tauri's own DMG step failed while the .app it had already produced was
#     perfectly good, and only a human watching the log noticed.
#
# Each check below corresponds to something that actually broke. Add one when
# the next thing does.
#
# Usage: scripts/verify-bundle.sh [path/to/Some.app]
#        defaults to src-tauri/target/release/bundle/macos/Sauce Bunny.app
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# --allow-stub-sidecars: CI builds with zero-byte sidecar stubs (the real
# binaries are gitignored and two are compiled from source), so there the
# sidecar checks report rather than fail. NEVER pass it for a release.
ALLOW_STUBS=0
ARGS=()
for a in "$@"; do
  case "${a}" in
    --allow-stub-sidecars) ALLOW_STUBS=1 ;;
    *) ARGS+=("${a}") ;;
  esac
done
APP="${ARGS[0]:-${ROOT_DIR}/src-tauri/target/release/bundle/macos/Sauce Bunny.app}"
FAILED=0

pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m⚠\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; FAILED=1; }

printf '\n── Bundle: %s\n\n' "${APP}"
[ -d "${APP}" ] || { fail "no .app at that path — build first (npm run tauri build)"; exit 1; }

BIN="${APP}/Contents/MacOS/sauce-bunny"
RES="${APP}/Contents/Resources"
PLIST="${APP}/Contents/Info.plist"

# ── 1. The executable exists and is the right architecture ──────────
if [ -x "${BIN}" ]; then
  BIN_ARCH="$(file -b "${BIN}" 2>/dev/null || true)"
  case "${BIN_ARCH}" in
    *arm64*) : ;;
    *) fail "executable is not arm64: ${BIN_ARCH}" ;;
  esac
  if [ "${FAILED}" -eq 0 ] || case "${BIN_ARCH}" in *arm64*) true ;; *) false ;; esac; then
    pass "executable present, arm64"
  else
    fail "executable is not arm64: $(file -b "${BIN}")"
  fi
else
  fail "no executable at Contents/MacOS/sauce-bunny"
fi

# ── 2. The CSP baked into the binary permits what startup registers ──
# This is the r150 bug. The CSP lives in the Rust binary (generate_context!
# compiles tauri.conf.json in), so a frontend-only rebuild does NOT change it,
# and nothing outside the packaged app can observe it.
CSP_LINE="$(strings "${BIN}" 2>/dev/null | grep -m1 "script-src" || true)"  # -m1 + || true: safe
if [ -z "${CSP_LINE}" ]; then
  fail "no CSP found in the binary (did tauri.conf.json lose app.security.csp?)"
else
  # Check the script-src DIRECTIVE specifically. A whole-string match would be
  # vacuously true: 'blob:' appears later under media-src, so grepping the
  # whole policy for it passes on exactly the broken r150 configuration.
  SCRIPT_SRC="$(printf '%s' "${CSP_LINE}" | tr ';' '\n' | grep 'script-src' || true)"
  WORKER_SRC="$(printf '%s' "${CSP_LINE}" | tr ';' '\n' | grep 'worker-src' || true)"
  case "${SCRIPT_SRC}" in
    *"'wasm-unsafe-eval'"*) pass "CSP script-src allows WebAssembly instantiation" ;;
    *) fail "CSP script-src lacks 'wasm-unsafe-eval' — WASM decoders will HANG silently: ${SCRIPT_SRC}" ;;
  esac
  case "${WORKER_SRC}" in
    *"blob:"*) pass "CSP worker-src allows blob: Workers" ;;
    *) fail "CSP worker-src lacks blob: — ProRes decode and MP3 export will hang: ${WORKER_SRC:-<absent>}" ;;
  esac
fi

# ── 3. The asset-protocol scope is narrow ────────────────────────────
# NOTE THE SHAPE, it bit this very script twice: `anything | grep -q` under
# `pipefail` reports FAILURE on a successful match. grep -q exits the instant it
# matches, the writer upstream takes SIGPIPE (exit 141), and pipefail propagates
# that. Capturing first does not help - it just moves the SIGPIPE to `printf`.
# So: no pipe. `case` does the match in the shell itself.
BIN_STRINGS="$(strings "${BIN}" 2>/dev/null || true)"
case "${BIN_STRINGS}" in
  *"APPCACHE"*) pass "asset-protocol scope is the narrowed \$APPCACHE/**" ;;
  *) warn "could not confirm the asset-protocol scope from the binary" ;;
esac

# ── 4. Licenses ship, and as separate readable files ────────────────
# The bug: three sources mapped to one destination key and collapsed into a
# single file. Assert each by name, and that the directory is a DIRECTORY.
if [ -d "${RES}/licenses" ]; then
  pass "Resources/licenses is a directory"
  for f in LICENSE THIRD-PARTY-LICENSES.md GPLv3.txt; do
    if [ -s "${RES}/licenses/${f}" ]; then
      pass "  ships ${f}"
    else
      fail "  MISSING ${f} — required to distribute the bundled components"
    fi
  done
elif [ -e "${RES}/licenses" ]; then
  fail "Resources/licenses is a FILE, not a directory — the resource map collapsed (see tauri.conf.json)"
else
  fail "Resources/licenses is absent — no license text ships at all"
fi

# ── 5. Every declared sidecar is present and non-stub ────────────────
# CI stubs these to zero bytes for cargo check; a stubbed binary must never
# reach a bundle.
SIDECARS="$(python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    conf = json.load(f)
for p in conf.get("bundle", {}).get("externalBin", []):
    print(p.rsplit("/", 1)[-1])
' "${ROOT_DIR}/src-tauri/tauri.conf.json" 2>/dev/null || true)"
if [ -z "${SIDECARS}" ]; then
  warn "no externalBin declared in tauri.conf.json"
else
  for name in ${SIDECARS}; do
    p="${APP}/Contents/MacOS/${name}"
    if [ ! -f "${p}" ]; then
      fail "sidecar ${name} missing from the bundle"
    elif [ ! -s "${p}" ]; then
      if [ "${ALLOW_STUBS}" -eq 1 ]; then
        warn "sidecar ${name} is a stub (expected in CI)"
      else
        fail "sidecar ${name} is a 0-byte stub — a CI stub reached a real bundle"
      fi
    elif [ ! -x "${p}" ]; then
      fail "sidecar ${name} is not executable"
    else
      pass "sidecar ${name}"
    fi
  done
fi

# ── 6. The Liquid Glass icon (Tahoe white-plates a bare .icns) ───────
if [ -s "${RES}/Assets.car" ]; then
  pass "Assets.car present (Tahoe-native icon)"
else
  fail "Assets.car missing — macOS 26 will white-plate the icon"
fi

# ── 7. Info.plist keys the app depends on at runtime ────────────────
plist_get() { /usr/libexec/PlistBuddy -c "Print :$1" "${PLIST}" 2>/dev/null; }
for key in CFBundleIdentifier CFBundleShortVersionString LSMinimumSystemVersion CFBundleIconName; do
  v="$(plist_get "${key}")"
  if [ -n "${v}" ]; then pass "Info.plist ${key} = ${v}"; else fail "Info.plist missing ${key}"; fi
done
# TCC prompts show these strings; a missing one means the OS denies silently.
for key in NSCameraUsageDescription NSMicrophoneUsageDescription; do
  if [ -n "$(plist_get "${key}")" ]; then pass "Info.plist ${key} present"; else fail "Info.plist missing ${key} — the OS will deny access with no prompt"; fi
done

# ── 8. Signature ────────────────────────────────────────────────────
# NOT piped into grep: `grep -q` exits on first match, codesign gets SIGPIPE,
# and under pipefail the pipeline reports failure ~half the time. Capture, then
# match. (Measured: 20 false negatives in 40 runs of the piped form.)
SIGINFO="$(codesign -dvv "${APP}" 2>&1 || true)"
case "${SIGINFO}" in
  *"Signature=adhoc"*) warn "ad-hoc signed (expected locally; a release needs a Developer ID)" ;;
  *"Signature="*)      pass "signed with an identity" ;;
  *) if [ "${ALLOW_STUBS}" -eq 1 ]; then
       warn "unsigned (CI has no signing identity)"
     else
       fail "the bundle is not signed at all"
     fi ;;
esac
if codesign --verify --deep --strict "${APP}" 2>/dev/null; then
  pass "signature verifies"
elif [ "${ALLOW_STUBS}" -eq 1 ]; then
  warn "signature does not verify (CI: unsigned, and the sidecars are stubs)"
else
  fail "signature does not verify"
fi

printf '\n'
if [ "${FAILED}" -ne 0 ]; then
  printf '\033[31m✗ bundle verification failed\033[0m\n\n'
  exit 1
fi
printf '\033[32m✓ bundle looks shippable\033[0m\n\n'
