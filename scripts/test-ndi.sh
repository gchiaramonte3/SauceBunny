#!/bin/bash
# Explicitly opt-in: synthetic NDI video/stereo tones for ~14s, with a 4s stall.
# The optional continuous mode captures ~28s, then tests sustained decoding.
set -euo pipefail
: "${SAUCE_NDI_SDK_DIR:?Set SAUCE_NDI_SDK_DIR to your NDI SDK for Apple folder}"
NDI_INPUT_RATE="${1:-30/1}"
case "$NDI_INPUT_RATE" in 24000/1001|24/1|25/1|30000/1001|30/1|60/1) ;; *) echo "Unsupported test rate: $NDI_INPUT_RATE" >&2; exit 2;; esac
NDI_SMOKE_ARGS=()
case "${2:-recovery}" in recovery) ;; continuous) NDI_SMOKE_ARGS=(continuous);; *) echo "Use recovery or continuous" >&2; exit 2;; esac
NDI_TEST_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NDI_TEST_DIR="$(mktemp -d /private/tmp/sauce-ndi-test.XXXXXX)"
xcrun clang++ -std=c++17 -O2 -fobjc-arc -fblocks -mmacosx-version-min=14.0 -DSAUCE_NDI_TIMING_TESTS \
  -I "${SAUCE_NDI_SDK_DIR}/include" \
  "${NDI_TEST_ROOT}/src-tauri/native/ndi_bridge.mm" \
  "${NDI_TEST_ROOT}/src-tauri/native/ndi_smoke.mm" \
  -framework Foundation -framework AVFoundation -framework CoreMedia -framework CoreVideo \
  -framework CoreImage -framework CoreGraphics -framework AudioToolbox -framework UniformTypeIdentifiers -framework VideoToolbox \
  -o "${NDI_TEST_DIR}/ndi-smoke"
"${NDI_TEST_DIR}/ndi-smoke" "${SAUCE_NDI_SDK_DIR}/lib/macOS/libndi.dylib" "${NDI_TEST_DIR}/program.mp4" "${NDI_INPUT_RATE%/*}" "${NDI_INPUT_RATE#*/}" ${NDI_SMOKE_ARGS[@]+"${NDI_SMOKE_ARGS[@]}"}
node --input-type=module - "$NDI_TEST_ROOT" "${NDI_TEST_DIR}/program.mp4" <<'JS'
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const probe = `${process.argv[2]}/src-tauri/binaries/ffprobe-aarch64-apple-darwin`;
for (const file of [process.argv[3], `${process.argv[3]}.preview.mp4`]) {
  const { streams } = JSON.parse(execFileSync(probe, ['-v', 'error', '-show_streams', '-of', 'json', file], { encoding: 'utf8' }));
  const video = streams.find(s => s.codec_type === 'video'), audio = streams.find(s => s.codec_type === 'audio');
  assert.equal(video?.codec_name, 'h264');
  assert.equal(video?.width, 1920, 'The 8x8 startup placeholder must not define the output raster');
  assert.equal(video?.height, 1080, 'Source format changes must preserve the session output raster');
  assert.equal(video?.r_frame_rate, '30/1', 'The prototype output timestamp cadence stays capped at 30 fps');
  assert.equal(audio?.codec_name, 'aac'); assert.equal(audio?.channels, 2); assert.equal(audio?.sample_rate, '48000');
  const { packets } = JSON.parse(execFileSync(probe, ['-v', 'error', '-show_packets',
    '-show_entries', 'packet=stream_index,pts_time,duration_time', '-of', 'json', file], { encoding: 'utf8' }));
  const ends = new Map();
  for (const packet of packets) {
    const start = Number(packet.pts_time), duration = Number(packet.duration_time), previous = ends.get(packet.stream_index);
    assert.ok(Number.isFinite(start) && duration > 0, 'Every encoded sample has a timestamp and duration');
    if (previous !== undefined) assert.ok(Math.abs(start - previous) < 0.001,
      `Encoded track ${packet.stream_index} has a timestamp hole/overlap at ${start}: ${start - previous}s`);
    ends.set(packet.stream_index, start + duration);
  }
  assert.equal(ends.size, 2, 'Continuity was checked for both encoded tracks');
}
console.log('Both captures preserve 1920x1080 H.264 and stereo 48 kHz AAC after placeholder/format changes.');
JS
echo "Synthetic NDI capture: ${NDI_TEST_DIR}/program.mp4"
if [[ "${2:-recovery}" == continuous ]]; then
  cd "$NDI_TEST_ROOT"
  SAUCE_NDI_CONTINUOUS_CAPTURE="${NDI_TEST_DIR}/program.mp4" npx playwright test e2e/ndi-input.spec.ts \
    -g 'sustained native' --workers=1 --repeat-each=3
fi
