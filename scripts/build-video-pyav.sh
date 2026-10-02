#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${VIDEO_BUILD_DIR:?Use the isolated video build directory}"
BUILD_PYTHON="${VIDEO_BUILD_DIR}/venv/bin/python"
PIP_DISABLE_PIP_VERSION_CHECK=1 "${BUILD_PYTHON}" -m pip install --require-hashes --only-binary=:all: -r "${ROOT_DIR}/video-sidecar/requirements-compiler.txt"
export PATH="${VIDEO_BUILD_DIR}/venv/bin:/usr/bin:/bin:/usr/sbin"
export PKG_CONFIG_PATH="${VIDEO_BUILD_DIR}/decoder/installed/lib/pkgconfig"
# pkgconf-pypi 3.0.1's vanilla wrapper returns no flags when PATH is supplied.
# Its Python-aware entry point invokes the bundled executable correctly.
export FORCE_PKGCONF_PYPI=1
export CFLAGS="-I${VIDEO_BUILD_DIR}/decoder/installed/include"
export LDFLAGS="-L${VIDEO_BUILD_DIR}/decoder/installed/lib"
FLAGS="$(pkg-config --cflags --libs libavcodec libavformat libavutil libavdevice libavfilter libswresample libswscale)"
[[ "${FLAGS}" == *-lavcodec* && "${FLAGS}" == *-lavutil* ]] || { echo 'Decoder link flags are missing.' >&2; exit 1; }
# Source hash is pinned too. No build-isolation resolver or cached vendor wheel.
PIP_DISABLE_PIP_VERSION_CHECK=1 "${BUILD_PYTHON}" -m pip install --force-reinstall --no-cache-dir --no-deps --no-build-isolation --no-binary=av --require-hashes -r "${ROOT_DIR}/video-sidecar/requirements-pyav.txt"
"${BUILD_PYTHON}" "${ROOT_DIR}/video-sidecar/relink_decoder.py" "${VIDEO_BUILD_DIR}/decoder/installed" "${VIDEO_BUILD_DIR}/original-wheel-libraries"
