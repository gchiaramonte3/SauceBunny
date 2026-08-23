#!/usr/bin/env bash
#
# Every gate CLAUDE.md lists under "Before every change", in one command.
#
# They were five separate invocations across three toolchains, which is exactly
# how one of them quietly stops being run. This runs all of them, keeps going
# after a failure so you see the whole picture rather than the first thing that
# broke, and exits non-zero if anything failed.
#
#   npm run verify
#
# NOT a substitute for launching the app. It cannot open a file, transcribe
# anything, or join a session — see docs/HAND-TEST.md for what only a human can
# check.
set -uo pipefail

cd "$(dirname "$0")/.."

FAILED=()
run() {
  local label="$1"; shift
  printf '\n\033[1m── %s ──\033[0m\n' "$label"
  if "$@"; then
    printf '\033[32m✓ %s\033[0m\n' "$label"
  else
    printf '\033[31m✗ %s\033[0m\n' "$label"
    FAILED+=("$label")
  fi
}

run "TypeScript"    npx tsc --noEmit
run "Unit tests"    npm test --silent
run "Lint"          npm run lint --silent
run "Rust compile"  cargo check --manifest-path src-tauri/Cargo.toml
run "Rust tests"    cargo test --lib --manifest-path src-tauri/Cargo.toml
# CI runs this with -D warnings, and this script did not - so "all gates
# passed" was reported for 98 commits while clippy was failing on two
# pre-existing lints. A local gate that is a subset of the CI gate is a
# gate that tells you the wrong thing.
run "Clippy"        cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
run "Swift sidecar" swift build --package-path swift-sidecar
# CI runs this too, and this script did not - the same subset bug as clippy
# below, found the same way. It takes a second and it is the check that stops
# a strong-copyleft dependency being LINKED into an MIT app, which is the one
# licensing mistake that cannot be undone after a release.
run "Licenses"      npm run check:licenses --silent
run "E2E"           npx playwright test e2e/

printf '\n'
if [ ${#FAILED[@]} -eq 0 ]; then
  printf '\033[32mAll gates passed.\033[0m Launch it before trusting any of it: docs/HAND-TEST.md\n'
  exit 0
fi

# Plain loop, not a pipeline: `grep -q` in a pipeline exits on first match and
# SIGPIPEs the writer, which under pipefail reports failure on success. That
# has bitten this repo's scripts before (see CLAUDE.md, bundling gotchas).
printf '\033[31m%d gate(s) failed:\033[0m\n' "${#FAILED[@]}"
for f in "${FAILED[@]}"; do printf '  · %s\n' "$f"; done
exit 1
