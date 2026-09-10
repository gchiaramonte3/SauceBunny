#!/usr/bin/env bash
# App-only guest acceptance fixture; no release changes or user library writes.
set -euo pipefail
cd "$(dirname "$0")/.."
SAUCE_MARKER_GUEST_ROOT="$(mktemp -d /private/tmp/sauce-marker-guest.XXXXXX)"
export SAUCE_MARKER_GUEST_ROOT
printf 'Isolated guest library: %s\n' "$SAUCE_MARKER_GUEST_ROOT"
bash scripts/build-app-with-ndi.sh --config harness-marker-guest/tauri.conf.json --bundles app "$@"
