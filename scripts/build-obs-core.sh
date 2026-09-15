#!/usr/bin/env bash
# Build a private, input-monitoring-free libobs from checksum-pinned archives.
# No OBS UI, arbitrary plugins, network downloads, installs or permission changes.
set -euo pipefail
if [[ $# != 3 ]]; then
  echo 'usage: build-obs-core.sh <pinned-obs-source.tar.gz> <pinned-obs-deps.tar.xz> <new-output-dir>' >&2
  exit 2
fi
project_root="$(cd "$(dirname "$0")/.." && pwd -P)"
source_archive="$1"
deps_archive="$2"
output_dir="$3"
[[ "$output_dir" = /* && ! -e "$output_dir" && ! -L "$output_dir" ]] || { echo 'Output must be a new absolute directory.' >&2; exit 2; }
command -v cmake >/dev/null || { echo 'CMake 3.28 or later is required at build time.' >&2; exit 2; }
mkdir "$output_dir"
# Freeze the checked recipe and patches before extraction/configuration. The
# final recorder rejects drift; an existing core cannot acquire a fresh recipe.
node "$project_root/scripts/obs-source-inputs.mjs" --prepare-core "$output_dir" "$source_archive" "$deps_archive" >/dev/null
recipe_root="$output_dir/core-build-source"
cmp "$project_root/scripts/build-obs-core.sh" "$recipe_root/scripts/build-obs-core.sh"
mkdir "$output_dir/source" "$output_dir/patches"
tar -xzf "$source_archive" --strip-components=1 -C "$output_dir/source"
deps_root="$output_dir/source/.deps/obs-deps-2026-07-15-universal"
mkdir -p "$deps_root"
tar -xf "$deps_archive" -C "$deps_root"
# The helper-only patch disables OBS's downloader; all inputs were verified
# above. Configure from this exact dependency tree, with no Qt/CEF bootstrap.
for patch_name in macos-no-global-input macos-core-dependencies macos-helper-module macos-stagesurface-stride; do
  ditto "$recipe_root/obs-sidecar/patches/$patch_name.patch" "$output_dir/patches/$patch_name.patch"
  patch --batch --fuzz=0 -p1 -d "$output_dir/source" < "$output_dir/patches/$patch_name.patch"
done
cmake -S "$output_dir/source" -B "$output_dir/build" -G Xcode \
  -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=14.0 \
  -DCMAKE_PREFIX_PATH="$deps_root" -DCMAKE_COMPILE_WARNING_AS_ERROR=OFF \
  -DOBS_VERSION_OVERRIDE=32.2.2-sauce-capture1 -DOBS_BUILD_NUMBER=1 \
  -DENABLE_FRONTEND=OFF -DENABLE_PLUGINS=OFF -DENABLE_BROWSER=OFF -DENABLE_SCRIPTING=OFF \
  -DSAUCE_OBS_CAPTURE_HELPER=ON -DENABLE_NEW_MPEGTS_OUTPUT=OFF \
  -DCMAKE_C_FLAGS=-DSAUCE_OBS_NO_GLOBAL_INPUT=1
cmake --build "$output_dir/build" --config Release --target libobs libobs-opengl obs-ffmpeg --parallel 4
core="$output_dir/build/libobs/Release/libobs.framework/Versions/A/libobs"
[[ -f "$core" ]] || { echo 'Built libobs not found.' >&2; exit 4; }
# Inspect the linked binary, not just the source patch or a version label.
# This also catches a future patch/build regression that reintroduces a listener.
bash "$recipe_root/scripts/check-obs-core.sh" "$core"
# Generated textures only: catch padded NV12 rows before recording a core as
# usable. This creates an offscreen graphics context, not a capture source.
bash "$recipe_root/scripts/verify-obs-stagesurface.sh" "$output_dir"
node "$project_root/scripts/obs-source-inputs.mjs" --record-core "$output_dir" "$source_archive" "$deps_archive" >/dev/null
echo "Built private libobs without global input: $output_dir"
echo 'Developer build only; release signing and complete corresponding-source packaging remain separate gates.'
