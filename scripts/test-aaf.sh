#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AAF_PYTHON="${AAF_PYTHON:-python3}"
if ! "${AAF_PYTHON}" -c 'import aaf2; assert aaf2.__version__ == "1.7.1"' 2>/dev/null; then
  # Developer test setup only; never install into system/site Python.
  AAF_TEST_ENV="${AAF_TEST_ENV:-${ROOT_DIR}/node_modules/.cache/aaf-tests}"
  if [[ ! -x "${AAF_TEST_ENV}/bin/python" ]]; then
    "${AAF_PYTHON}" -m venv "${AAF_TEST_ENV}"
  fi
  AAF_PYTHON="${AAF_TEST_ENV}/bin/python"
  if ! "${AAF_PYTHON}" -c 'import aaf2; assert aaf2.__version__ == "1.7.1"' 2>/dev/null; then
    PIP_DISABLE_PIP_VERSION_CHECK=1 "${AAF_PYTHON}" -m pip install --require-hashes --only-binary=:all: --no-deps -r "${ROOT_DIR}/aaf-sidecar/requirements.txt"
  fi
fi
PYTHONDONTWRITEBYTECODE=1 "${AAF_PYTHON}" "${ROOT_DIR}/aaf-sidecar/test_reader.py"
PYTHONDONTWRITEBYTECODE=1 "${AAF_PYTHON}" "${ROOT_DIR}/aaf-sidecar/test_graph.py"
PYTHONDONTWRITEBYTECODE=1 "${AAF_PYTHON}" "${ROOT_DIR}/aaf-sidecar/test_mxf.py"
