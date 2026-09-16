#!/usr/bin/env bash
# CPU/index/decoder regressions only. No weights, GPU, or media library access.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VIDEO_TEST_PYTHON="${VIDEO_TEST_PYTHON:-${VIDEO_PYTHON:-${AAF_PYTHON:-python3}}}"
if ! "${VIDEO_TEST_PYTHON}" -c 'import sys; assert sys.version_info >= (3,12)' 2>/dev/null; then
  echo 'Video worker tests need Python 3.12+. Set VIDEO_TEST_PYTHON=/path/to/python3.12 (build/test only; the app bundles its interpreter).' >&2
  exit 1
fi
TEST_ABI="$("${VIDEO_TEST_PYTHON}" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
VIDEO_TEST_ENV="${VIDEO_TEST_ENV:-${ROOT_DIR}/node_modules/.cache/video-tests-${TEST_ABI}}"
if ! "${VIDEO_TEST_PYTHON}" -c 'import av, numpy, PIL, usearch; from importlib.metadata import version; assert version("av") == "16.1.0" and version("usearch") == "2.26.2"' 2>/dev/null; then
  if [[ ! -x "${VIDEO_TEST_ENV}/bin/python" ]]; then "${VIDEO_TEST_PYTHON}" -m venv "${VIDEO_TEST_ENV}"; fi
  VIDEO_TEST_PYTHON="${VIDEO_TEST_ENV}/bin/python"
  PIP_DISABLE_PIP_VERSION_CHECK=1 "${VIDEO_TEST_PYTHON}" -m pip install --require-hashes --only-binary=:all: --no-deps -r "${ROOT_DIR}/video-sidecar/requirements-test.txt"
fi
PYTHONDONTWRITEBYTECODE=1 "${VIDEO_TEST_PYTHON}" -m unittest discover -s "${ROOT_DIR}/video-sidecar" -p 'test_*.py'
