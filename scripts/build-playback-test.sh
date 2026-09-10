#!/usr/bin/env bash
# App-only, independently identified native test. No DMG or publication.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/stable-signing.sh
npx tauri build --config harness-playback/tauri.conf.json --bundles app "$@"
