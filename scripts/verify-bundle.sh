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

# Read once; sections 2 and 3 both need it.
BIN_STRINGS="$(strings "${BIN}" 2>/dev/null || true)"

# ── 2. The CSP baked into the binary permits what startup registers ──
# This is the r150 bug. The CSP lives in the Rust binary (generate_context!
# compiles tauri.conf.json in), so a frontend-only rebuild does NOT change it,
# and nothing outside the packaged app can observe it.
#
# Config first, binary second — the same two-part shape as the asset scope, and
# for a sharper reason. The first version of this check ran
# `strings … | grep -m1 script-src` and parsed whatever came back. That is
# order-dependent, and the order differs by machine: locally the first hit is
# the real policy, on a CI runner the first hit is Tauri's CSP TEMPLATE
# (`…_root_script-src __TAURI_SCRIPT_NONCE__ style-src…`) run together with
# half the string table. So the check FAILED every CI run on a bundle whose
# CSP was perfectly correct. A gate that cries wolf is worse than no gate: it
# trains people to ignore a red build.
#
# The config is unambiguous and parseable, so assert the directives there; the
# binary only has to corroborate that this config is the one compiled in, for
# which one distinctive token is enough.
CSP_VERDICT="$(python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    conf = json.load(f)
csp = conf.get("app", {}).get("security", {}).get("csp")
if not csp:
    print("FAIL\tno CSP in tauri.conf.json — the webview would run wide open"); raise SystemExit
if isinstance(csp, dict):          # per-directive object form
    parts = {k: " ".join(v) if isinstance(v, list) else str(v) for k, v in csp.items()}
else:
    parts = {}
    for chunk in str(csp).split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        name, _, rest = chunk.partition(" ")
        parts[name] = rest
# Each directive is checked on ITS OWN value. Searching the whole policy would
# be vacuously true — "blob:" appears under media-src, so a whole-string match
# passes on exactly the broken r150 configuration.
problems = []
if "wasm-unsafe-eval" not in parts.get("script-src", ""):
    problems.append("script-src lacks '"'"'wasm-unsafe-eval'"'"' (WASM decoders hang silently)")
if "blob:" not in parts.get("worker-src", ""):
    problems.append("worker-src lacks blob: (ProRes decode and MP3 export hang)")
if problems:
    print("FAIL\t" + "; ".join(problems))
else:
    print("OK\tCSP allows WebAssembly instantiation and blob: Workers")
' "${ROOT_DIR}/src-tauri/tauri.conf.json" 2>/dev/null || printf 'FAIL\tcould not read the CSP out of tauri.conf.json')"
case "${CSP_VERDICT}" in
  OK*) pass "${CSP_VERDICT#OK	}" ;;
  *)   fail "${CSP_VERDICT#FAIL	}" ;;
esac

# `wasm-unsafe-eval` appears in our policy and NOT in Tauri's template, so its
# presence proves the config above is what got compiled in.
case "${BIN_STRINGS}" in
  *"wasm-unsafe-eval"*) pass "  and that CSP is the one baked into this binary" ;;
  *) fail "  the binary has no 'wasm-unsafe-eval' — it was built from a different config" ;;
esac

# ── 3. The asset-protocol scope is narrow ────────────────────────────
# NOTE THE SHAPE, it bit this very script twice: `anything | grep -q` under
# `pipefail` reports FAILURE on a successful match. grep -q exits the instant it
# matches, the writer upstream takes SIGPIPE (exit 141), and pipefail propagates
# that. Capturing first does not help - it just moves the SIGPIPE to `printf`.
# So: no pipe. `case` does the match in the shell itself.
#
# Two checks, because neither is sufficient alone. This started as one `case`
# asking whether the token APPCACHE appeared anywhere in the binary, which
# could not fail for the regression it was named after: widening the scope to
# ["$APPCACHE/**", "$HOME/**"] leaves $APPCACHE/** in place, so the token is
# still there and the check still printed green.
#
#  (a) the config is the source of truth, so assert the scope set EXACTLY;
#  (b) the binary must contain the token, which proves the config we just
#      read is the one generate_context! compiled in rather than an edit made
#      after the build.
SCOPE_VERDICT="$(python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    conf = json.load(f)
sec = conf.get("app", {}).get("security", {})
ap = sec.get("assetProtocol") or {}
scope = ap.get("scope")
if not ap.get("enable"):
    print("OK\tasset protocol is disabled entirely"); raise SystemExit
if scope is None:
    print("FAIL\tassetProtocol.enable is true with NO scope - that is the wide-open default")
    raise SystemExit
if isinstance(scope, dict):          # {allow: [...], deny: [...]}
    entries = list(scope.get("allow") or [])
else:
    entries = list(scope)
extra = [e for e in entries if e != "$APPCACHE/**"]
if extra:
    print("FAIL\tscope has widened beyond $APPCACHE/**: " + ", ".join(map(str, extra)))
elif entries == ["$APPCACHE/**"]:
    print("OK\tasset-protocol scope is exactly [$APPCACHE/**]")
else:
    print("FAIL\tunexpected empty asset-protocol scope")
' "${ROOT_DIR}/src-tauri/tauri.conf.json" 2>/dev/null || printf 'FAIL\tcould not read assetProtocol out of tauri.conf.json')"
case "${SCOPE_VERDICT}" in
  OK*)   pass "${SCOPE_VERDICT#OK	}" ;;
  *)     fail "${SCOPE_VERDICT#FAIL	}" ;;
esac

case "${BIN_STRINGS}" in
  *"APPCACHE/**"*) pass "  and that scope is the one baked into this binary" ;;
  *) fail "  the binary does not contain \$APPCACHE/** - it was built from a different config" ;;
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
#
# The deep verify is gated on the signature CLASS, and that gate is the whole
# point of this section. `tauri build` with no identity configured emits a
# linker-signed ad-hoc bundle with `Sealed Resources=none`, and
# `codesign --verify --deep --strict` can never succeed against one — it
# reports "code has no resources but signature indicates they must be
# present". An earlier version of this section called ad-hoc "expected
# locally" in one breath and hard-failed on it two lines later, so
# `npm run verify:bundle` — the command CONTRIBUTING.md tells you to run after
# a local build — exited 1 every single time. A gate that always fails teaches
# people to ignore it, which is worse than not having it.
SIGINFO="$(codesign -dvv "${APP}" 2>&1 || true)"
SIGNED_FOR_REAL=0
case "${SIGINFO}" in
  *"Signature=adhoc"*) warn "ad-hoc signed (expected locally; a release needs a Developer ID)" ;;
  *"Signature="*)      pass "signed with an identity"; SIGNED_FOR_REAL=1 ;;
  *) if [ "${ALLOW_STUBS}" -eq 1 ]; then
       warn "unsigned (CI has no signing identity)"
     else
       fail "the bundle is not signed at all"
     fi ;;
esac

if codesign --verify --deep --strict "${APP}" 2>/dev/null; then
  pass "signature verifies"
elif [ "${SIGNED_FOR_REAL}" -eq 1 ]; then
  # A bundle claiming a real identity that will not verify is a hard failure:
  # Gatekeeper will reject it on someone else's Mac.
  fail "signature does not verify — Gatekeeper will refuse this bundle"
  codesign --verify --deep --strict "${APP}" 2>&1 | sed 's/^/      /'
else
  warn "deep verify skipped — an ad-hoc/unsigned bundle seals no resources, so it cannot pass"
fi

printf '\n'
if [ "${FAILED}" -ne 0 ]; then
  printf '\033[31m✗ bundle verification failed\033[0m\n\n'
  exit 1
fi
# "Shippable" is a claim about Gatekeeper, and only a real identity can earn it.
#
# Every check above can pass on an ad-hoc bundle, because ad-hoc is the expected
# LOCAL state and is warned rather than failed. The summary then said "bundle
# looks shippable" over a bundle `spctl -a -t exec` rejects outright - the one
# sentence a person reads, telling them the opposite of what would happen on
# someone else's Mac. Contents and signing are separate verdicts, so say both.
if [ "${SIGNED_FOR_REAL}" -eq 1 ]; then
  printf '\033[32m✓ bundle looks shippable\033[0m\n\n'
else
  printf '\033[32m✓ bundle contents check out\033[0m — but it is \033[33mNOT shippable\033[0m:\n'
  printf '  ad-hoc signed, so Gatekeeper will reject it on any other Mac.\n'
  printf '  A release needs a Developer ID and notarization (docs/DISTRIBUTION.md).\n\n'
fi
