#!/usr/bin/env bash
# Fake-SDK only: actual parent death, blocked foreign calls and process EOF.
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd -P)"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/sauce-ndi-owner.XXXXXX")"
clang++ -std=c++17 -Wall -Wextra -Werror -pthread \
  "$project_root/src-tauri/native/ndi_sender.cpp" \
  "$project_root/src-tauri/native/ndi_sender_main.cpp" \
  "$project_root/src-tauri/native/ndi_sender_fake_sdk.cpp" \
  -o "$test_dir/fake-sdk-sender"
clang++ -std=c++17 -Wall -Wextra -Werror \
  "$project_root/src-tauri/native/ndi_sender_owner.test.cpp" \
  -o "$test_dir/owner-tests"
"$test_dir/owner-tests" "$test_dir/fake-sdk-sender"
