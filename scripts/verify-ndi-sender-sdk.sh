#!/usr/bin/env bash
# Optional installed-header ABI gate. No vendor runtime is loaded or broadcast.
set -euo pipefail
[[ $# == 1 && -f "$1/Processing.NDI.Lib.h" ]] || { echo 'usage: verify-ndi-sender-sdk.sh <NDI-SDK-include-directory>' >&2; exit 2; }
project_root="$(cd "$(dirname "$0")/.." && pwd -P)"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/sauce-ndi-sender-sdk.XXXXXX")"
clang++ -std=c++17 -Wall -Wextra -Werror -dynamiclib -I "$1" \
  "$project_root/src-tauri/native/ndi_sender_sdk_fixture.test.cpp" \
  -o "$test_dir/fake-ndi.dylib"
clang++ -std=c++17 -Wall -Wextra -Werror -I "$1" \
  "$project_root/src-tauri/native/ndi_sender_sdk.cpp" \
  "$project_root/src-tauri/native/ndi_sender_sdk.test.cpp" \
  -o "$test_dir/sdk-adapter-tests"
"$test_dir/sdk-adapter-tests" "$test_dir/fake-ndi.dylib"
