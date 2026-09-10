#!/usr/bin/env bash
# Only prepare licensed runtime artifacts here. Never install NDI globally.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/stable-signing.sh
: "${SAUCE_NDI_SDK_DIR:?Set SAUCE_NDI_SDK_DIR to the NDI SDK for Apple folder}"
npm --prefix premiere-companion run ccx
PREMIERE_BUNDLE_CONFIG="$(node scripts/prepare-premiere-bundle.mjs)"
NDI_BUNDLE_CONFIG="$(node scripts/prepare-ndi-bundle.mjs)"
npx tauri build --config "$NDI_BUNDLE_CONFIG" --config "$PREMIERE_BUNDLE_CONFIG" "$@"
