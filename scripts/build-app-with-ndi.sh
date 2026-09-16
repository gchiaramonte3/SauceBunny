#!/usr/bin/env bash
# Only prepare licensed runtime artifacts here. Never install NDI globally.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/stable-signing.sh
: "${SAUCE_NDI_SDK_DIR:?Set SAUCE_NDI_SDK_DIR to the NDI SDK for Apple folder}"
# This is first-party source, not a vendor binary. Packaging a previously
# copied helper can silently omit newer thumbnail modes even when the app's
# frontend/backend build IDs match. Build it before Tauri assembles the app.
bash scripts/build-capture.sh
bash scripts/build-aaf.sh
VIDEO_PYTHON="${VIDEO_PYTHON:-${AAF_PYTHON:-python3.12}}" bash scripts/build-video.sh
bash scripts/build-audio-analysis.sh
npm --prefix premiere-companion run ccx
PREMIERE_BUNDLE_CONFIG="$(node scripts/prepare-premiere-bundle.mjs)"
NDI_BUNDLE_CONFIG="$(node scripts/prepare-ndi-bundle.mjs)"
npx tauri build --config "$NDI_BUNDLE_CONFIG" --config "$PREMIERE_BUNDLE_CONFIG" "$@"
