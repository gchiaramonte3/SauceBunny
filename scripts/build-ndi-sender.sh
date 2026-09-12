#!/usr/bin/env bash
# Compile the private NDI-only consumer. Does not load the runtime or broadcast,
# install into an app, sign, notarize, or add a release resource declaration.
set -euo pipefail
if [[ $# != 2 ]]; then
  echo 'usage: build-ndi-sender.sh <NDI-SDK-include-directory> <new-absolute-output-directory>' >&2
  exit 2
fi
project_root="$(cd "$(dirname "$0")/.." && pwd -P)"
sdk_include="$1"
output_dir="$2"
[[ -f "$sdk_include/Processing.NDI.Lib.h" ]] || { echo 'NDI SDK headers are required to compile.' >&2; exit 2; }
[[ "$output_dir" = /* && ! -e "$output_dir" && ! -L "$output_dir" ]] || { echo 'Output must be a new absolute directory.' >&2; exit 2; }
mkdir "$output_dir"
mkdir -p "$output_dir/source/src-tauri/native" "$output_dir/source/obs-sidecar" "$output_dir/source/scripts" "$output_dir/MacOS"
# Compile frozen original sources; the pure MIT wire header is the only input
# from obs-sidecar. The GPL helper and libobs are never linked into this process.
for leaf in ndi_sender.hpp ndi_sender.cpp ndi_sender_sdk.hpp ndi_sender_sdk.cpp ndi_sender_main.cpp; do
  cp "$project_root/src-tauri/native/$leaf" "$output_dir/source/src-tauri/native/$leaf"
done
cp "$project_root/obs-sidecar/raw-frame.hpp" "$output_dir/source/obs-sidecar/raw-frame.hpp"
cp "$project_root/LICENSE" "$output_dir/source/LICENSE"
cp "$project_root/scripts/build-ndi-sender.sh" "$output_dir/source/scripts/build-ndi-sender.sh"
cp "$project_root/scripts/ndi-sender-artifact.mjs" "$output_dir/source/scripts/ndi-sender-artifact.mjs"
(
  cd "$output_dir/source"
  shasum -a 256 src-tauri/native/* obs-sidecar/raw-frame.hpp LICENSE scripts/build-ndi-sender.sh scripts/ndi-sender-artifact.mjs
) > "$output_dir/source-sha256.txt"
(
  cd "$sdk_include"
  shasum -a 256 Processing.NDI*.h
) > "$output_dir/sdk-headers-sha256.txt"
clang++ -std=c++17 -Wall -Wextra -Werror -pthread -target arm64-apple-macos14.0 \
  -I "$sdk_include" "$output_dir/source/src-tauri/native/ndi_sender.cpp" \
  "$output_dir/source/src-tauri/native/ndi_sender_sdk.cpp" \
  "$output_dir/source/src-tauri/native/ndi_sender_main.cpp" \
  -o "$output_dir/MacOS/saucebunny-ndi-sender"
(
  cd "$output_dir/source"
  shasum -a 256 -c "$output_dir/source-sha256.txt"
)
(
  cd "$sdk_include"
  shasum -a 256 -c "$output_dir/sdk-headers-sha256.txt"
)
dependencies="$(otool -L "$output_dir/MacOS/saucebunny-ndi-sender")"
printf '%s\n' "$dependencies"
while IFS= read -r dependency; do
  case "$dependency" in
    /usr/lib/*|/System/Library/*) ;;
    *) echo 'Unexpected non-system sender linkage.' >&2; exit 3 ;;
  esac
done < <(printf '%s\n' "$dependencies" | awk 'NR > 1 { print $1 }')
node "$output_dir/source/scripts/ndi-sender-artifact.mjs" record "$output_dir"
echo 'Private unsigned build only. No SDK was loaded and no broadcast was created.'
echo 'Internal staging/signing and distribution review are separate actions.'
