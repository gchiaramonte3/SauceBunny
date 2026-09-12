#!/usr/bin/env bash
# Stage a private embedded libobs runtime from our pinned source build. This
# does not launch OBS, install anything, or add these workers to releases.
set -euo pipefail
if [[ $# != 2 ]]; then
  echo 'usage: build-obs-probe.sh <private-obs-core-build> <new-output-dir>' >&2
  exit 2
fi
original_project_root="$(cd "$(dirname "$0")/.." && pwd -P)"
original_build_script="$(cd "$(dirname "$0")" && pwd -P)/$(basename "$0")"
core_build="$1"
obs_source="$core_build/source"
deps_root="$obs_source/.deps/obs-deps-2026-07-15-universal"
simde_source="$deps_root/include"
output_dir="$2"
[[ "$output_dir" = /* && ! -e "$output_dir" && ! -L "$output_dir" ]] || { echo 'Output must be a new absolute directory.' >&2; exit 2; }
[[ -f "$obs_source/libobs/obs.h" && -f "$simde_source/simde/x86/sse2.h" ]] || { echo 'Missing upstream headers.' >&2; exit 2; }
core_framework="$core_build/build/libobs/Release/libobs.framework"
[[ -f "$core_framework/Versions/A/libobs" ]] || { echo 'Build the pinned private OBS core first.' >&2; exit 2; }
# Freeze all helper-owned inputs before any check, patch comparison or compile.
# Keep core_build relative to the caller's working directory, as before.
node "$original_project_root/scripts/snapshot-obs-source.mjs" validate-destination \
  "$original_project_root" "$output_dir" >/dev/null
mkdir "$output_dir"
mkdir "$output_dir/source"
node "$original_project_root/scripts/snapshot-obs-source.mjs" snapshot \
  "$original_project_root" "$output_dir/source/helper" >/dev/null
project_root="$output_dir/source/helper"
cmp "$original_build_script" "$project_root/scripts/build-obs-probe.sh"
node "$project_root/scripts/obs-source-inputs.mjs" --verify-core "$core_build" >/dev/null
ditto "$core_build/core-build-inputs.json" "$output_dir/source/core-build-inputs.json"
for patch_name in macos-no-global-input macos-core-dependencies macos-helper-module; do
  cmp "$project_root/obs-sidecar/patches/$patch_name.patch" "$core_build/patches/$patch_name.patch"
done
bash "$project_root/scripts/check-obs-core.sh" "$core_framework/Versions/A/libobs"
mkdir -p "$output_dir/Frameworks" "$output_dir/PlugIns" "$output_dir/MacOS" "$output_dir/licenses"

# Copy only the transitive dynamic-library closure of the chosen modules.
# Their @rpath references stay relative to the private helper bundle. Never
# copy the OBS UI, Qt, CEF, browser plugin, user plugins or user settings.
copy_dependencies() {
  local binary="$1" dependency relative component destination listing
  # Check otool before process substitution; otherwise its failure is hidden.
  listing="$(otool -arch arm64 -L "$binary")"
  while IFS= read -r dependency; do
    case "$dependency" in
      /System/Library/*|/usr/lib/*) continue ;;
      @rpath/*)
        relative="${dependency#@rpath/}"
        case "$relative" in
          *../*|/*) echo "Unsafe dependency: $dependency" >&2; exit 3 ;;
          *.framework/*) component="${relative%%.framework/*}.framework" ;;
          *) component="$relative" ;;
        esac
        case "$component" in Qt*|*Chromium*|*Helper*) echo "Unexpected UI dependency: $component" >&2; exit 3 ;; esac
        destination="$output_dir/Frameworks/$component"
        if [[ ! -e "$destination" ]]; then
          [[ -e "$deps_root/lib/$component" ]] || { echo "Missing dependency: $component" >&2; exit 3; }
          ditto "$deps_root/lib/$component" "$destination"
          copy_dependencies "$output_dir/Frameworks/$relative"
        fi
        ;;
      *) echo "Unexpected non-system dependency: $dependency" >&2; exit 3 ;;
    esac
  done < <(printf '%s\n' "$listing" | awk 'NR > 1 { print $1 }')
}
ditto "$core_framework" "$output_dir/Frameworks/libobs.framework"
ditto "$core_build/build/libobs-opengl/Release/libobs-opengl.dylib" "$output_dir/Frameworks/libobs-opengl.dylib"
copy_dependencies "$output_dir/Frameworks/libobs.framework/Versions/A/libobs"
copy_dependencies "$output_dir/Frameworks/libobs-opengl.dylib"
for module in obs-ffmpeg; do
  ditto "$core_build/build/plugins/$module/Release/$module.plugin" "$output_dir/PlugIns/$module.plugin"
  copy_dependencies "$output_dir/PlugIns/$module.plugin/Contents/MacOS/$module"
done
# Build only OBS's ScreenCaptureKit source with the recorded privacy patch.
# Preserve the corresponding source and patch in this private developer bundle.
capture_source="$output_dir/source/mac-capture"
capture_module="$output_dir/PlugIns/sauce-obs-capture.plugin/Contents"
mkdir -p "$capture_source" "$capture_module/MacOS"
ditto "$project_root/obs-sidecar/capture-Info.plist" "$capture_module/Info.plist"
(cd "$obs_source/plugins/mac-capture" && shasum -a 256 -c "$project_root/obs-sidecar/capture-sources.sha256")
for source_file in mac-sck-video-capture.m mac-sck-common.m mac-sck-common.h window-utils.m window-utils.h; do
  ditto "$obs_source/plugins/mac-capture/$source_file" "$capture_source/$source_file"
done
for patch_name in macos-window-privacy macos-capture-health macos-frame-status; do
  ditto "$project_root/obs-sidecar/patches/$patch_name.patch" "$output_dir/source/$patch_name.patch"
  patch --batch --fuzz=0 -p1 -d "$capture_source" < "$output_dir/source/$patch_name.patch"
done
ditto "$obs_source/plugins/mac-capture/data" "$capture_module/Resources"
node "$project_root/scripts/snapshot-obs-source.mjs" prepare-build "$output_dir" >/dev/null
clang -bundle -fno-objc-arc -target arm64-apple-macos14.0 \
  -I "$project_root/obs-sidecar/include" -I "$obs_source/libobs" -I "$simde_source" \
  -F "$output_dir/Frameworks" -framework libobs -framework Cocoa -framework CoreMedia \
  -framework CoreVideo -framework IOSurface -framework ScreenCaptureKit \
  -Wl,-rpath,@loader_path/../../../../Frameworks \
  "$project_root/obs-sidecar/capture-module.c" "$capture_source/mac-sck-video-capture.m" \
  "$capture_source/mac-sck-common.m" "$capture_source/window-utils.m" \
  -o "$capture_module/MacOS/sauce-obs-capture"
ditto "$obs_source/COPYING" "$output_dir/licenses/OBS-COPYING"
ditto "$deps_root/licenses" "$output_dir/licenses/obs-deps"
ditto "$core_build/patches" "$output_dir/source/core-patches"
compile_probe() {
  local probe="$1"
  local executable="$2"
  shift
  shift
  clang++ -std=c++17 -fobjc-arc -target arm64-apple-macos14.0 \
    -I "$project_root/obs-sidecar/include" -I "$obs_source/libobs" -I "$simde_source" \
    -F "$output_dir/Frameworks" -framework libobs -framework AppKit -framework ScreenCaptureKit \
    -Wl,-rpath,@loader_path/../Frameworks \
    "$project_root/obs-sidecar/engine.mm" "$@" "$project_root/obs-sidecar/$probe.mm" \
    -o "$output_dir/MacOS/saucebunny-obs-$executable"
}
compile_probe probe probe
compile_probe audio-buffer.test audio-buffer-tests
program_sources=("$project_root/obs-sidecar/proof-output.mm" "$project_root/obs-sidecar/raw-output.mm")
compile_probe media-probe media-probe "${program_sources[@]}"
compile_probe window-probe window-probe "$project_root/obs-sidecar/window-discovery.mm" "$project_root/obs-sidecar/application-discovery.mm"
compile_probe capture-probe capture-probe "${program_sources[@]}" "$project_root/obs-sidecar/window-discovery.mm"
compile_probe capture-overlap-probe capture-overlap-probe "${program_sources[@]}" "$project_root/obs-sidecar/window-discovery.mm"
compile_probe capture-service capture-service "$project_root/obs-sidecar/service-control.mm" "$project_root/obs-sidecar/raw-control.mm" "${program_sources[@]}" "$project_root/obs-sidecar/window-discovery.mm"
compile_probe media-probe media-worker -DSAUCE_OBS_SUPERVISED "${program_sources[@]}"
compile_probe capture-probe capture-worker -DSAUCE_OBS_SUPERVISED "${program_sources[@]}" "$project_root/obs-sidecar/window-discovery.mm"
compile_probe capture-health.test capture-health-tests -I "$capture_source" -framework CoreMedia -framework CoreVideo -framework IOSurface
clang++ -std=c++17 -Wall -Wextra -Werror "$project_root/obs-sidecar/capture-config.test.cpp" \
  -o "$output_dir/MacOS/obs-capture-config-tests"
"$output_dir/MacOS/obs-capture-config-tests"
"$output_dir/MacOS/saucebunny-obs-capture-health-tests" "$output_dir"
node "$project_root/scripts/snapshot-obs-source.mjs" verify "$project_root" >/dev/null
# Bash began in the checkout: reject recipe edits even though compiler inputs
# now come solely from the frozen snapshot.
cmp "$original_build_script" "$project_root/scripts/build-obs-probe.sh"
node "$project_root/scripts/snapshot-obs-source.mjs" record-build "$output_dir" >/dev/null
node "$project_root/scripts/inspect-obs-runtime.mjs" "$output_dir" > "$output_dir/runtime-inventory.json"
node "$project_root/scripts/snapshot-obs-source.mjs" verify "$project_root" >/dev/null
cmp "$original_build_script" "$project_root/scripts/build-obs-probe.sh"
echo "Built probes in: $output_dir/MacOS"
echo 'Not a distributable bundle: complete corresponding-source/dependency packaging is a separate gate.'
