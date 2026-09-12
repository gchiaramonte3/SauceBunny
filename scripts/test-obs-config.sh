#!/usr/bin/env bash
# Pure geometry/identity tests: no OBS installation, capture permission or media.
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/sauce-obs-config.XXXXXX")"
c++ -std=c++17 -Wall -Wextra -Werror "$project_root/obs-sidecar/capture-config.test.cpp" \
  -o "$test_dir/capture-config-tests"
"$test_dir/capture-config-tests"
c++ -std=c++17 -Wall -Wextra -Werror "$project_root/obs-sidecar/application-discovery.test.cpp" \
  -o "$test_dir/application-discovery-tests"
"$test_dir/application-discovery-tests"
c++ -std=c++17 -Wall -Wextra -Werror "$project_root/obs-sidecar/raw-frame.test.cpp" \
  -o "$test_dir/raw-frame-tests"
"$test_dir/raw-frame-tests"
c++ -std=c++17 -Wall -Wextra -Werror "$project_root/obs-sidecar/raw-control.mm" \
  "$project_root/obs-sidecar/raw-control.test.mm" -o "$test_dir/raw-control-tests"
"$test_dir/raw-control-tests"
node --test "$project_root/scripts/obs-discovery.test.mjs"
node --test "$project_root/scripts/inspect-obs-runtime.test.mjs"
node --test "$project_root/scripts/obs-av-sync.test.mjs"
