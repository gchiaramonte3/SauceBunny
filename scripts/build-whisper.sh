#!/usr/bin/env bash
#
# Build whisper.cpp from source as a STATIC binary and drop it at
# src-tauri/binaries/whisper-cli-aarch64-apple-darwin.
#
# Why this exists:
#   The previous workflow (`cp $(brew --prefix)/bin/whisper-cli …`)
#   embedded references to Homebrew's separate `ggml` formula:
#
#     /opt/homebrew/opt/ggml/lib/libggml.0.dylib       (compatibility 0.0.0)
#     /opt/homebrew/opt/ggml/lib/libggml-base.0.dylib  (compatibility 0.0.0)
#
#   On a user's Mac without `brew install ggml` (or with a different
#   ggml version), whisper-cli crashed at process start with dyld:
#   "Library not loaded". Every Whisper transcription failed.
#
#   The pre-existing `patch-whisper-rpath.sh` made this WORSE for
#   distribution — it added `/opt/homebrew/lib` as an rpath, which
#   only helps users who happen to have Homebrew. It was a dev-host
#   workaround disguised as a fix.
#
# What this script does:
#   1. Clones (or updates) ggerganov/whisper.cpp into a build cache
#      directory.
#   2. Configures CMake with `-DBUILD_SHARED_LIBS=OFF` so ggml gets
#      statically linked into the binary. Metal acceleration stays on
#      (it uses Apple's always-present Metal framework, not a dylib).
#   3. Builds with the platform compiler.
#   4. Runs the otool-L guard rail — refuses to install if any
#      non-system dylib reference survived.
#   5. Atomic-replaces the binary in src-tauri/binaries/.
#   6. Records the version + commit SHA in SIDECAR-VERSIONS.md.
#
# Requirements:
#   - cmake (brew install cmake)
#   - Xcode Command Line Tools (for clang + Metal headers)
#
# Usage:
#   bash scripts/build-whisper.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BIN_DIR="${ROOT_DIR}/src-tauri/binaries"
VERSIONS_FILE="${ROOT_DIR}/SIDECAR-VERSIONS.md"
DST="${BIN_DIR}/whisper-cli-aarch64-apple-darwin"

# Build cache outside the repo so `cargo clean` / git status stay tidy.
# Re-uses the same checkout across runs; pulls latest before building.
WHISPER_DIR="${WHISPER_DIR:-${HOME}/.cache/sauce-bunny/whisper.cpp}"

mkdir -p "${BIN_DIR}" "$(dirname "${WHISPER_DIR}")"

if ! command -v cmake >/dev/null 2>&1; then
  echo "✗ cmake not found — install with: brew install cmake"
  exit 1
fi

# ── Fetch / update source ──────────────────────────────────────────
if [ -d "${WHISPER_DIR}/.git" ]; then
  echo "→ Updating existing whisper.cpp checkout at ${WHISPER_DIR}"
  git -C "${WHISPER_DIR}" fetch --depth=1 origin master
  git -C "${WHISPER_DIR}" reset --hard FETCH_HEAD
else
  echo "→ Cloning whisper.cpp into ${WHISPER_DIR}"
  git clone --depth=1 https://github.com/ggerganov/whisper.cpp.git "${WHISPER_DIR}"
fi

WHISPER_COMMIT="$(git -C "${WHISPER_DIR}" rev-parse --short HEAD)"
WHISPER_VERSION="$(git -C "${WHISPER_DIR}" describe --tags --always --abbrev=0 2>/dev/null || echo "${WHISPER_COMMIT}")"
echo "  commit: ${WHISPER_COMMIT} (${WHISPER_VERSION})"

# ── Configure + build ──────────────────────────────────────────────
BUILD_DIR="${WHISPER_DIR}/build-static"
echo "→ Configuring with static linking"
# BUILD_SHARED_LIBS=OFF       → produce libggml.a not libggml.dylib
# GGML_METAL=ON               → keep Metal accel (uses /System/Library Metal.framework)
# CMAKE_OSX_DEPLOYMENT_TARGET → match the app's minimum (CLAUDE.md: macOS 13+)
# CMAKE_BUILD_TYPE=Release    → enable optimizations
rm -rf "${BUILD_DIR}"
cmake -B "${BUILD_DIR}" -S "${WHISPER_DIR}" \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
  >/tmp/sb-whisper-cmake.log 2>&1 || {
    echo "✗ cmake configure failed — see /tmp/sb-whisper-cmake.log"
    tail -30 /tmp/sb-whisper-cmake.log
    exit 1
  }

echo "→ Building (this takes a minute)…"
# Build just the whisper-cli target to skip the other examples.
cmake --build "${BUILD_DIR}" --config Release -j --target whisper-cli \
  >/tmp/sb-whisper-build.log 2>&1 || {
    echo "✗ cmake build failed — see /tmp/sb-whisper-build.log"
    tail -30 /tmp/sb-whisper-build.log
    exit 1
  }

BUILT="${BUILD_DIR}/bin/whisper-cli"
if [ ! -x "${BUILT}" ]; then
  echo "✗ build succeeded but ${BUILT} is missing"
  exit 1
fi

# ── Guard rail — refuse to install a Homebrew-tied binary ──────────
echo "→ Verifying no Homebrew / user-dir dylib deps:"
DEPS="$(otool -L "${BUILT}" | tail -n +2 || true)"
echo "${DEPS}"
LEAKED="$(echo "${DEPS}" | grep -E '/opt/homebrew/|/usr/local/|/Users/' || true)"
if [ -n "${LEAKED}" ]; then
  echo
  echo "✗ FATAL: the built whisper-cli has non-system dylib dependencies:"
  echo "${LEAKED}"
  echo
  echo "  Refusing to install it. cmake config may have picked up a"
  echo "  Homebrew-installed dependency — try clearing ${BUILD_DIR}"
  echo "  and ensure GGML_BLAS / GGML_OPENBLAS are OFF."
  exit 1
fi
echo "✓ only system frameworks / @rpath references"

# ── Smoke test ──────────────────────────────────────────────────────
echo "→ Smoke test (whisper-cli --version):"
NEW_VERSION_LINE="$("${BUILT}" --help 2>&1 | head -1)"
echo "  ${NEW_VERSION_LINE}"

# ── Atomic replace ──────────────────────────────────────────────────
mv -f "${BUILT}" "${DST}"
chmod +x "${DST}"
SIZE_MB="$(du -m "${DST}" | awk '{print $1}')"
echo "✓ Installed whisper.cpp ${WHISPER_VERSION} (commit ${WHISPER_COMMIT}, ${SIZE_MB}MB) → ${DST}"

# ── Update SIDECAR-VERSIONS.md ──────────────────────────────────────
TODAY="$(date -u +%Y-%m-%d)"
if [ ! -f "${VERSIONS_FILE}" ]; then
  cat > "${VERSIONS_FILE}" <<'EOF'
# Bundled sidecar versions

This file tracks the version of every binary we ship under
`src-tauri/binaries/`. Updated by the scripts; do not edit by hand.

EOF
fi
python3 - "${VERSIONS_FILE}" "${WHISPER_VERSION}" "${WHISPER_COMMIT}" "${TODAY}" <<'PY'
import sys, re
path, version, commit, date = sys.argv[1:]
text = open(path).read()
text = re.sub(r'## whisper-cli\b.*?(?=\n## |\Z)', '', text, flags=re.DOTALL)
text = text.rstrip() + '\n\n## whisper-cli\n'
text += f'- version: {version} (commit {commit})\n'
text += f'- source: https://github.com/ggerganov/whisper.cpp (built from source, static)\n'
text += f'- refreshed: {date}\n'
open(path, 'w').write(text)
PY
echo "✓ Updated ${VERSIONS_FILE}"

echo
echo "Done. Restart \`npm run tauri dev\` for the change to take effect."
