#!/usr/bin/env bash
# Build-time Python only. The installed worker uses its frozen interpreter.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VIDEO_PYTHON="${VIDEO_PYTHON:-python3.12}"
VIDEO_BUILD_DIR="${VIDEO_BUILD_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/saucebunny-video-build.XXXXXX")}"
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo 'Video Intelligence requires Apple Silicon macOS.' >&2
  exit 1
fi
"${VIDEO_PYTHON}" -c 'import sys; assert sys.version_info[:3] == (3,12,14), "The current video runtime is pinned to CPython 3.12.14"'
mkdir -p "${VIDEO_BUILD_DIR}"
"${VIDEO_PYTHON}" -m venv "${VIDEO_BUILD_DIR}/venv"
BUILD_PYTHON="${VIDEO_BUILD_DIR}/venv/bin/python"
export MACOSX_DEPLOYMENT_TARGET=14.0
# pip otherwise chooses the build host's newest Metal wheel (e.g. macOS 26),
# silently raising the installed application's minimum OS. Resolve for 14.
mkdir -p "${VIDEO_BUILD_DIR}/wheels-macos14"
PIP_DISABLE_PIP_VERSION_CHECK=1 "${BUILD_PYTHON}" -m pip download --require-hashes --only-binary=:all: \
  --platform macosx_14_0_arm64 --python-version 3.12 --dest "${VIDEO_BUILD_DIR}/wheels-macos14" \
  -r "${ROOT_DIR}/video-sidecar/requirements-build.txt"
PIP_DISABLE_PIP_VERSION_CHECK=1 "${BUILD_PYTHON}" -m pip install --force-reinstall --no-index \
  --find-links "${VIDEO_BUILD_DIR}/wheels-macos14" --require-hashes --only-binary=:all: \
  -r "${ROOT_DIR}/video-sidecar/requirements-build.txt"
export VIDEO_BUILD_DIR
bash "${ROOT_DIR}/scripts/build-video-decoder.sh"
bash "${ROOT_DIR}/scripts/build-video-pyav.sh"
(cd "${ROOT_DIR}/video-sidecar" && "${BUILD_PYTHON}" -m unittest test_worker)
"${BUILD_PYTHON}" "${ROOT_DIR}/video-sidecar/collect_notices.py" "${VIDEO_BUILD_DIR}/notices"
export PYINSTALLER_CONFIG_DIR="${VIDEO_BUILD_DIR}/pyinstaller-cache"
COMMON=(--noconfirm --clean --console --target-architecture arm64 --onedir --name saucebunny-video
  --collect-submodules mlx_vlm.models.qwen3_vl --collect-submodules mlx_vlm.models.qwen3_vl_embedding
  --collect-submodules mlx_vlm.models.qwen3_5
  --collect-data mlx --collect-binaries mlx --collect-data mlx_vlm
  --hidden-import mlx._reprlib_fix --hidden-import mlx.__array_api_info
  --collect-submodules transformers.models.qwen2 --collect-submodules transformers.models.qwen3_vl
  --recursive-copy-metadata mlx-vlm --copy-metadata usearch --copy-metadata av
  --exclude-module mlx_embeddings --exclude-module torch --exclude-module torchvision
  --exclude-module fastapi --exclude-module uvicorn --exclude-module cv2
  --exclude-module Cython --exclude-module pkgconf
  --add-data "${ROOT_DIR}/video-sidecar/models.json:."
  --add-data "${VIDEO_BUILD_DIR}/notices:licenses/dependencies"
  --add-data "${VIDEO_BUILD_DIR}/decoder/notices:licenses/ffmpeg")
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  COMMON+=(--codesign-identity "${APPLE_SIGNING_IDENTITY}")
fi
"${BUILD_PYTHON}" -m PyInstaller "${COMMON[@]}" \
  --distpath "${VIDEO_BUILD_DIR}/dist" --workpath "${VIDEO_BUILD_DIR}/work" \
  --specpath "${VIDEO_BUILD_DIR}" "${ROOT_DIR}/video-sidecar/worker.py"
BUILT="${VIDEO_BUILD_DIR}/dist/saucebunny-video"
# Tauri dereferences resource aliases. MLX locates its default shader beside
# the loaded libmlx, which may therefore be _internal/libmlx.dylib, not the
# original mlx/lib path. Keep the shader available at both lookup locations.
ln -s mlx/lib/mlx.metallib "${BUILT}/_internal/mlx.metallib"
"${BUILD_PYTHON}" "${ROOT_DIR}/aaf-sidecar/verify_runtime.py" "${BUILT}"
"${BUILD_PYTHON}" "${ROOT_DIR}/video-sidecar/runtime_manifest.py" stamp "${BUILT}" --repo "${ROOT_DIR}"
"${BUILD_PYTHON}" "${ROOT_DIR}/video-sidecar/runtime_manifest.py" verify "${BUILT}" --repo "${ROOT_DIR}"
env PATH=/usr/bin:/bin "${BUILT}/saucebunny-video" --version
# Keep a prior generated runtime recoverable in the isolated build directory.
DESTINATION="${ROOT_DIR}/src-tauri/video-runtime/saucebunny-video"
if [[ -e "${DESTINATION}" ]]; then
  PREVIOUS_DIR="$(mktemp -d "${VIDEO_BUILD_DIR}/previous-runtime.XXXXXX")"
  mv "${DESTINATION}" "${PREVIOUS_DIR}/saucebunny-video"
fi
ditto "${BUILT}" "${DESTINATION}"
echo "Built self-contained video worker: ${DESTINATION}"
echo "Build evidence: ${VIDEO_BUILD_DIR}"
