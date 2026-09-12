#!/usr/bin/env bash
# Build/stage an isolated internal app. No DMG, installation, launch or upload.
set -euo pipefail
if [[ $# != 2 || "$1" != /* || "$2" != /* || "$2" != *.app || -e "$2" || -L "$2" ]]; then
  echo 'usage: build-internal-app-with-obs.sh <diagnostic-runtime> <new-absolute-output.app>' >&2
  exit 2
fi
cd "$(dirname "$0")/.."
source scripts/stable-signing.sh
# Tauri can notarize even an app-only bundle when these credentials exist.
# Internal validation must not upload the artifact or consume release auth.
unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
[[ -f "$1/runtime-inventory.json" ]] || { echo 'Diagnostic runtime inventory is missing.' >&2; exit 2; }
: "${SAUCE_NDI_SDK_DIR:?Set SAUCE_NDI_SDK_DIR to the NDI SDK for Apple folder}"
# Separate, exclusive build artifact; retained as provenance on success/failure.
# Compiling this executable never loads the NDI runtime or starts a broadcast.
sender_work="$(mktemp -d "${TMPDIR:-/tmp}/sauce-ndi-internal.XXXXXX")"
bash scripts/build-ndi-sender.sh "$SAUCE_NDI_SDK_DIR/include" "$sender_work/sender"
export CARGO_TARGET_DIR="$PWD/src-tauri/target"
# Explicit app-only target: never enter the normal DMG/version/archive flow.
bash scripts/build-app-with-ndi.sh --bundles app
node scripts/stage-obs-app.mjs \
  "$PWD/src-tauri/target/release/bundle/macos/Sauce Bunny.app" "$1" "$2" "$sender_work/sender"
