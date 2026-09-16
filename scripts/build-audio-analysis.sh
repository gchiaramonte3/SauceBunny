#!/usr/bin/env bash
# Isolated optional audio worker. System frameworks only; never starts capture.
set -euo pipefail
cd "$(dirname "$0")/.."
swift build --package-path swift-sidecar --product saucebunny-audio-analysis -c release --arch arm64
audio_stage="$(mktemp -d "${TMPDIR:-/tmp}/sauce-audio-runtime.XXXXXX")"
cp swift-sidecar/.build/arm64-apple-macosx/release/saucebunny-audio-analysis "$audio_stage/saucebunny-audio-analysis"
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$audio_stage/saucebunny-audio-analysis"
fi
node scripts/audio-analysis-runtime.mjs stamp "$audio_stage"
node scripts/audio-analysis-runtime.mjs verify "$audio_stage"
mkdir -p src-tauri/audio-runtime
cp "$audio_stage/saucebunny-audio-analysis" src-tauri/audio-runtime/saucebunny-audio-analysis
cp "$audio_stage/runtime-manifest.json" src-tauri/audio-runtime/runtime-manifest.json
node scripts/audio-analysis-runtime.mjs verify src-tauri/audio-runtime
