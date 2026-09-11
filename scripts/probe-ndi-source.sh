#!/usr/bin/env bash
# Receive-only production-engine probe. `list` discovers names without capture.
# `capture` requires an exact discovered name; never auto-selects another feed.
# Outputs stay in a new private temporary directory. No room publication.
set -euo pipefail
: "${SAUCE_NDI_SDK_DIR:?Set SAUCE_NDI_SDK_DIR to your NDI SDK for Apple folder}"
NDI_PROBE_MODE="${1:-list}"
case "$NDI_PROBE_MODE" in
  list) [[ $# -le 1 ]] || exit 2 ;;
  capture) [[ $# -ge 2 && $# -le 3 && -n "$2" ]] || { echo 'Usage: probe-ndi-source.sh capture "exact source name" [1-60 seconds]' >&2; exit 2; } ;;
  *) echo 'Use list or capture "exact source name" [1-60 seconds]' >&2; exit 2 ;;
esac
NDI_PROBE_SECONDS="${3:-30}"
[[ "$NDI_PROBE_SECONDS" =~ ^([1-9]|[1-5][0-9]|60)$ ]] || exit 2
NDI_PROBE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NDI_PROBE_DIR="$(mktemp -d /private/tmp/sauce-ndi-probe.XXXXXX)"
xcrun clang++ -std=c++17 -O2 -fobjc-arc -fblocks -mmacosx-version-min=14.0 \
  -I "${SAUCE_NDI_SDK_DIR}/include" \
  "${NDI_PROBE_ROOT}/src-tauri/native/ndi_bridge.mm" "${NDI_PROBE_ROOT}/src-tauri/native/ndi_probe.mm" \
  -framework Foundation -framework AVFoundation -framework CoreMedia -framework CoreVideo \
  -framework CoreImage -framework CoreGraphics -framework AudioToolbox -framework UniformTypeIdentifiers -framework VideoToolbox \
  -o "${NDI_PROBE_DIR}/ndi-probe"
echo "Receive-only probe: ${NDI_PROBE_DIR}"
if [[ "$NDI_PROBE_MODE" == list ]]; then
  "${NDI_PROBE_DIR}/ndi-probe" "${SAUCE_NDI_SDK_DIR}/lib/macOS/libndi.dylib" list
else
  echo 'Capturing this source locally only. The sender may already be broadcasting on the LAN.'
  "${NDI_PROBE_DIR}/ndi-probe" "${SAUCE_NDI_SDK_DIR}/lib/macOS/libndi.dylib" capture "$2" "$NDI_PROBE_DIR" "$NDI_PROBE_SECONDS"
fi
