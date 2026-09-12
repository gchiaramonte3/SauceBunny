#!/usr/bin/env bash
# No SDK runtime, network sender, capture permission or user media is used.
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd -P)"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/sauce-ndi-sender.XXXXXX")"
clang++ -std=c++17 -Wall -Wextra -Werror -pthread \
  "$project_root/src-tauri/native/ndi_sender.cpp" \
  "$project_root/src-tauri/native/ndi_sender.test.cpp" \
  -o "$test_dir/reader-tests"
"$test_dir/reader-tests"
clang++ -std=c++17 -Wall -Wextra -Werror -pthread \
  "$project_root/src-tauri/native/ndi_sender.cpp" \
  "$project_root/src-tauri/native/ndi_sender_main.cpp" \
  "$project_root/src-tauri/native/ndi_sender_fake_sdk.cpp" \
  -o "$test_dir/fake-sdk-sender"
SAUCE_NDI_SENDER_TEST_BINARY="$test_dir/fake-sdk-sender" \
  node --test "$project_root/scripts/ndi-sender-process.test.mjs"
bash "$project_root/scripts/test-ndi-sender-owner.sh"
