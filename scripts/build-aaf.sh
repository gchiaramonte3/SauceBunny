#!/usr/bin/env bash
# Build-time Python only: the installed sidecar carries its own interpreter.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AAF_PYTHON="${AAF_PYTHON:-python3.12}"
AAF_BUILD_DIR="${AAF_BUILD_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/saucebunny-aaf-build.XXXXXX")}"
DESTINATION="${ROOT_DIR}/src-tauri/binaries/saucebunny-aaf-aarch64-apple-darwin"
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo 'AAF sidecar builds require Apple Silicon macOS.' >&2
  exit 1
fi
"${AAF_PYTHON}" -c 'import sys; assert sys.version_info[:3] == (3,12,14), "Use CPython 3.12.14 for the pinned AAF build"'
mkdir -p "${AAF_BUILD_DIR}" "$(dirname "${DESTINATION}")"
"${AAF_PYTHON}" -m venv "${AAF_BUILD_DIR}/venv"
BUILD_PYTHON="${AAF_BUILD_DIR}/venv/bin/python"
PIP_DISABLE_PIP_VERSION_CHECK=1 "${BUILD_PYTHON}" -m pip install --require-hashes --only-binary=:all: -r "${ROOT_DIR}/aaf-sidecar/requirements-build.txt"
AAF_PYTHON="${BUILD_PYTHON}" bash "${ROOT_DIR}/scripts/test-aaf.sh"
export MACOSX_DEPLOYMENT_TARGET=14.0
export PYINSTALLER_CONFIG_DIR="${AAF_BUILD_DIR}/pyinstaller-cache"
COMMON=(--noconfirm --clean --console --target-architecture arm64 --collect-submodules aaf2
  --copy-metadata pyaaf2 --name saucebunny-aaf
  --add-data "${ROOT_DIR}/aaf-sidecar/THIRD-PARTY-LICENSES.txt:licenses")
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  COMMON+=(--codesign-identity "${APPLE_SIGNING_IDENTITY}")
fi
"${BUILD_PYTHON}" -m PyInstaller "${COMMON[@]}" --onedir \
  --distpath "${AAF_BUILD_DIR}/folder" --workpath "${AAF_BUILD_DIR}/work-folder" \
  --specpath "${AAF_BUILD_DIR}" "${ROOT_DIR}/aaf-sidecar/reader.py"
# Inspect every collected Mach-O, not just the outer bootloader.
"${BUILD_PYTHON}" "${ROOT_DIR}/aaf-sidecar/verify_runtime.py" "${AAF_BUILD_DIR}/folder/saucebunny-aaf"
env PATH=/usr/bin:/bin "${AAF_BUILD_DIR}/folder/saucebunny-aaf/saucebunny-aaf" --version
"${BUILD_PYTHON}" -m PyInstaller "${COMMON[@]}" --onefile \
  --distpath "${AAF_BUILD_DIR}/single" --workpath "${AAF_BUILD_DIR}/work-single" \
  --specpath "${AAF_BUILD_DIR}" "${ROOT_DIR}/aaf-sidecar/reader.py"
BUILT="${AAF_BUILD_DIR}/single/saucebunny-aaf"
env PATH=/usr/bin:/bin "${BUILT}" --version
codesign --verify --strict "${BUILT}"
install -m 755 "${BUILT}" "${DESTINATION}.new"
mv -f "${DESTINATION}.new" "${DESTINATION}"
echo "Built self-contained AAF sidecar: ${DESTINATION}"
echo "Build evidence: ${AAF_BUILD_DIR}"
