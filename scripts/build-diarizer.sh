#!/usr/bin/env bash
#
# Build the saucebunny-diarize Swift sidecar and drop the binary into the
# Tauri sidecar tree with the platform-tuple naming Tauri expects.
#
# Usage:
#   bash scripts/build-diarizer.sh              # arm64 only (dev default)
#   bash scripts/build-diarizer.sh --universal  # arm64 + x86_64 fat binary
#
# Outputs (all relative to the repo root):
#   swift-sidecar/.build/...                   # SwiftPM intermediate output
#   src-tauri/binaries/saucebunny-diarize-aarch64-apple-darwin
#   src-tauri/binaries/saucebunny-diarize-x86_64-apple-darwin   # only with --universal
#
# Requirements:
#   - macOS 14+ (FluidAudio platform pin)
#   - Xcode command-line tools (swift, lipo)
#   - First run downloads the FluidAudio SwiftPM package (~10s)
#   - First runtime invocation of the binary then downloads Core ML
#     models to ~/.cache/fluidaudio/Models/ (a few hundred MB, one-time)
#
# Notes:
#   - We don't check the built binary into git — it's regenerated locally
#     by every developer and signed by the Tauri bundler at app-build
#     time. The cargo build + tauri dev steps will fail loudly if the
#     binary is missing, which is the prompt to re-run this script.
#   - Signing happens later: Tauri's bundler resigns sidecars using the
#     same identity as the main app during `tauri build`. For `tauri
#     dev` the binary runs ad-hoc-signed (the OS allows it because the
#     parent process is the dev binary, not a notarized app).

set -euo pipefail

# Resolve repo root regardless of where the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SWIFT_DIR="${ROOT_DIR}/swift-sidecar"
BIN_DIR="${ROOT_DIR}/src-tauri/binaries"

MODE="${1:-arm64}"

if ! command -v swift >/dev/null 2>&1; then
  echo "error: 'swift' not found on PATH. Install Xcode or the command-line tools." >&2
  exit 1
fi

mkdir -p "${BIN_DIR}"

cd "${SWIFT_DIR}"

case "${MODE}" in
  "" | "arm64")
    echo "→ Building saucebunny-diarize (arm64-only, release)…"
    swift build -c release --arch arm64
    src="${SWIFT_DIR}/.build/arm64-apple-macosx/release/saucebunny-diarize"
    dst="${BIN_DIR}/saucebunny-diarize-aarch64-apple-darwin"
    cp "${src}" "${dst}"
    chmod +x "${dst}"
    echo "✓ ${dst}"
    ;;

  "--universal")
    # Build each slice, then `lipo` them into one fat binary per slice.
    # FluidAudio's Core ML models run on the ANE on arm64 and fall back
    # to CPU on x86_64 — slower but functional, which is the right
    # tradeoff for a Universal build.
    echo "→ Building saucebunny-diarize (arm64 + x86_64, release)…"
    swift build -c release --arch arm64
    swift build -c release --arch x86_64

    arm_src="${SWIFT_DIR}/.build/arm64-apple-macosx/release/saucebunny-diarize"
    x86_src="${SWIFT_DIR}/.build/x86_64-apple-macosx/release/saucebunny-diarize"

    arm_dst="${BIN_DIR}/saucebunny-diarize-aarch64-apple-darwin"
    x86_dst="${BIN_DIR}/saucebunny-diarize-x86_64-apple-darwin"
    cp "${arm_src}" "${arm_dst}"; chmod +x "${arm_dst}"
    cp "${x86_src}" "${x86_dst}"; chmod +x "${x86_dst}"

    echo "✓ ${arm_dst}"
    echo "✓ ${x86_dst}"
    ;;

  *)
    echo "usage: $0 [--universal]" >&2
    exit 2
    ;;
esac

echo "→ Smoke test:"
"${BIN_DIR}/saucebunny-diarize-aarch64-apple-darwin" --version
