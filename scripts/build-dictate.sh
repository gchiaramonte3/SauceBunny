#!/usr/bin/env bash
#
# Build the saucebunny-dictate Swift sidecar (on-device live dictation via
# Apple's Speech framework) and drop the binary into the Tauri sidecar tree
# with the platform-tuple naming Tauri expects.
#
# Usage:
#   bash scripts/build-dictate.sh              # arm64 only (dev default)
#   bash scripts/build-dictate.sh --universal  # arm64 + x86_64 fat binary
#
# Outputs (relative to repo root):
#   src-tauri/binaries/saucebunny-dictate-aarch64-apple-darwin
#   src-tauri/binaries/saucebunny-dictate-x86_64-apple-darwin   # only with --universal
#
# Notes:
#   - This target has NO external SwiftPM dependencies (system Speech +
#     AVFoundation only), so `--product saucebunny-dictate` builds fast and
#     never pulls the heavy diarizer packages.
#   - Self-contained: links only macOS system frameworks. The otool guard
#     below refuses to install a binary with a Homebrew / user-dir dylib ref.
#   - Not checked into git — regenerated locally; the cargo / tauri steps fail
#     loudly if it's missing, which is the prompt to re-run this.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SWIFT_DIR="${ROOT_DIR}/swift-sidecar"
BIN_DIR="${ROOT_DIR}/src-tauri/binaries"
PRODUCT="saucebunny-dictate"

if ! command -v swift >/dev/null 2>&1; then
  echo "error: 'swift' not found on PATH. Install Xcode or the command-line tools." >&2
  exit 1
fi

mkdir -p "${BIN_DIR}"
cd "${SWIFT_DIR}"

guard_self_contained() {
  local bin="$1"
  # Skip line 1 of `otool -L` (the binary's OWN path, which lives under the
  # repo at /Users/… and would false-positive); only the dependency lines
  # below it matter.
  local deps
  deps="$(otool -L "${bin}" | tail -n +2)"
  if printf '%s\n' "${deps}" | grep -qE '/opt/homebrew/|/usr/local/|/Users/'; then
    echo "✗ ${bin} references a non-system dylib — refusing to install:" >&2
    printf '%s\n' "${deps}" | grep -E '/opt/homebrew/|/usr/local/|/Users/' >&2
    exit 3
  fi
}

MODE="${1:-arm64}"
case "${MODE}" in
  "" | "arm64")
    echo "→ Building ${PRODUCT} (arm64-only, release)…"
    swift build --product "${PRODUCT}" -c release --arch arm64
    src="${SWIFT_DIR}/.build/arm64-apple-macosx/release/${PRODUCT}"
    dst="${BIN_DIR}/${PRODUCT}-aarch64-apple-darwin"
    guard_self_contained "${src}"
    cp "${src}" "${dst}"; chmod +x "${dst}"
    echo "✓ ${dst}"
    ;;

  "--universal")
    echo "→ Building ${PRODUCT} (arm64 + x86_64, release)…"
    swift build --product "${PRODUCT}" -c release --arch arm64
    swift build --product "${PRODUCT}" -c release --arch x86_64
    arm_src="${SWIFT_DIR}/.build/arm64-apple-macosx/release/${PRODUCT}"
    x86_src="${SWIFT_DIR}/.build/x86_64-apple-macosx/release/${PRODUCT}"
    arm_dst="${BIN_DIR}/${PRODUCT}-aarch64-apple-darwin"
    x86_dst="${BIN_DIR}/${PRODUCT}-x86_64-apple-darwin"
    guard_self_contained "${arm_src}"; cp "${arm_src}" "${arm_dst}"; chmod +x "${arm_dst}"
    guard_self_contained "${x86_src}"; cp "${x86_src}" "${x86_dst}"; chmod +x "${x86_dst}"
    echo "✓ ${arm_dst}"
    echo "✓ ${x86_dst}"
    ;;

  *)
    echo "usage: $0 [--universal]" >&2
    exit 2
    ;;
esac

echo "→ Smoke test:"
"${BIN_DIR}/${PRODUCT}-aarch64-apple-darwin" --version
