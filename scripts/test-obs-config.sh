#!/usr/bin/env bash
# Pure geometry/identity tests: no OBS installation, capture permission or media.
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/sauce-obs-config.XXXXXX")"
c++ -std=c++17 -Wall -Wextra -Werror "$project_root/obs-sidecar/capture-config.test.cpp" \
  -o "$test_dir/capture-config-tests"
"$test_dir/capture-config-tests"
c++ -std=c++17 -Wall -Wextra -Werror "$project_root/obs-sidecar/capture-start-failure.test.cpp" \
  -o "$test_dir/capture-start-failure-tests"
"$test_dir/capture-start-failure-tests"
c++ -std=c++17 -Wall -Wextra -Werror "$project_root/obs-sidecar/region-overlay-policy.test.cpp" \
  -o "$test_dir/region-overlay-policy-tests"
"$test_dir/region-overlay-policy-tests"
clang++ -std=c++17 -Wall -Wextra -Werror -fobjc-arc -framework AppKit \
  "$project_root/obs-sidecar/region-window-snapshot.test.mm" \
  -o "$test_dir/region-window-snapshot-tests"
"$test_dir/region-window-snapshot-tests"
clang++ -std=c++17 -Wall -Wextra -Werror -fobjc-arc -framework AppKit \
  "$project_root/obs-sidecar/region-overlay-controls.test.mm" \
  -o "$test_dir/region-overlay-controls-tests"
"$test_dir/region-overlay-controls-tests"
c++ -std=c++17 -Wall -Wextra -Werror "$project_root/obs-sidecar/application-discovery.test.cpp" \
  -o "$test_dir/application-discovery-tests"
"$test_dir/application-discovery-tests"
c++ -std=c++17 -Wall -Wextra -Werror "$project_root/obs-sidecar/raw-frame.test.cpp" \
  -o "$test_dir/raw-frame-tests"
"$test_dir/raw-frame-tests"
c++ -std=c++17 -Wall -Wextra -Werror "$project_root/obs-sidecar/raw-control.mm" \
  "$project_root/obs-sidecar/raw-control.test.mm" -o "$test_dir/raw-control-tests"
"$test_dir/raw-control-tests"
clang++ -std=c++17 -Wall -Wextra -Werror -fobjc-arc -framework Foundation \
  "$project_root/obs-sidecar/service-control.mm" "$project_root/obs-sidecar/service-control.test.mm" \
  -o "$test_dir/service-control-tests"
"$test_dir/service-control-tests"
node --test "$project_root/scripts/obs-discovery.test.mjs"
node --test "$project_root/scripts/inspect-obs-runtime.test.mjs"
node --test "$project_root/scripts/obs-av-sync.test.mjs"
