#!/usr/bin/env bash
# Real GPU readback of generated textures only; no OBS capture sources, windows,
# permission APIs, audio, network, installed applications or shared build outputs.
set -euo pipefail
if [[ $# != 1 && $# != 2 ]]; then
  echo 'usage: verify-obs-stagesurface.sh <pinned-core-build> [private-runtime]' >&2
  exit 2
fi
project_root="$(cd "$(dirname "$0")/.." && pwd -P)"
core_build="$1"
if [[ $# == 2 ]]; then
  [[ "$2" = /* ]] || { echo 'Runtime must be absolute.' >&2; exit 2; }
  frameworks="$2/Frameworks"
  renderer="$frameworks/libobs-opengl.dylib"
else
  frameworks="$core_build/build/libobs/Release"
  renderer="$core_build/build/libobs-opengl/Release/libobs-opengl.dylib"
fi
[[ "$core_build" = /* && -f "$renderer" && \
  -f "$core_build/source/libobs/graphics/graphics.h" ]] || { echo 'Missing private renderer or pinned headers.' >&2; exit 2; }
test_dir="$(mktemp -d /private/tmp/sauce-obs-stagesurface.XXXXXX)"
echo "Generated GPU row-stride evidence: $test_dir"
xcrun clang++ -std=c++17 -fobjc-arc -target arm64-apple-macos14.0 \
  -I "$project_root/obs-sidecar/include" -I "$core_build/source/libobs" \
  -I "$core_build/source/.deps/obs-deps-2026-07-15-universal/include" \
  -F "$frameworks" -framework libobs -framework AppKit \
  -Wl,-rpath,"$frameworks" \
  -Wl,-rpath,"$core_build/source/.deps/obs-deps-2026-07-15-universal/lib" \
  "$project_root/obs-sidecar/stagesurface-stride.test.mm" -o "$test_dir/stagesurface-stride-tests"
# Bound driver waits as well as test work. No subprocess/capture lifetime can
# outlive this runner if a graphics driver stalls during readback.
node --input-type=module - "$test_dir/stagesurface-stride-tests" "$renderer" <<'JS' 2>&1 | tee "$test_dir/result.log"
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.argv[2], [process.argv[3]], {
  timeout: 20000, killSignal: 'SIGKILL', stdio: 'inherit',
});
if (result.error || result.signal) console.error('Generated GPU row-stride check did not complete normally.');
process.exit(result.status === 0 ? 0 : 1);
JS
