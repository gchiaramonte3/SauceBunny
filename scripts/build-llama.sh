#!/usr/bin/env bash
#
# Build llama.cpp's `llama-server` from source as a STATIC binary and drop it
# at src-tauri/binaries/llama-server-aarch64-apple-darwin.
#
# Why llama-server (and not llama-cli): the AI Summary tab is a CHAT — the
# model must load once and stay resident (a 2.5 GB GGUF takes seconds to map +
# warm). llama-server keeps the model + KV cache in memory and exposes an
# OpenAI-compatible /v1/chat/completions on 127.0.0.1, which the webview
# streams from directly. One-shot llama-cli would reload the model per message.
#
# Same recipe as build-whisper.sh (whisper.cpp and llama.cpp are sibling
# ggml projects): static link, Metal embedded, otool guard rail, atomic
# install, SIDECAR-VERSIONS.md record.
#
# Requirements: cmake, Xcode Command Line Tools.
# Usage: bash scripts/build-llama.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BIN_DIR="${ROOT_DIR}/src-tauri/binaries"
VERSIONS_FILE="${ROOT_DIR}/SIDECAR-VERSIONS.md"
DST="${BIN_DIR}/llama-server-aarch64-apple-darwin"

# Build cache outside the repo so `cargo clean` / git status stay tidy.
LLAMA_DIR="${LLAMA_DIR:-${HOME}/.cache/sauce-bunny/llama.cpp}"

mkdir -p "${BIN_DIR}" "$(dirname "${LLAMA_DIR}")"

if ! command -v cmake >/dev/null 2>&1; then
  echo "✗ cmake not found — install with: brew install cmake"
  exit 1
fi

# ── Fetch / update source ──────────────────────────────────────────
if [ -d "${LLAMA_DIR}/.git" ]; then
  echo "→ Updating existing llama.cpp checkout at ${LLAMA_DIR}"
  git -C "${LLAMA_DIR}" fetch --depth=1 origin master
  git -C "${LLAMA_DIR}" reset --hard FETCH_HEAD
else
  echo "→ Cloning llama.cpp into ${LLAMA_DIR}"
  git clone --depth=1 https://github.com/ggml-org/llama.cpp.git "${LLAMA_DIR}"
fi

LLAMA_COMMIT="$(git -C "${LLAMA_DIR}" rev-parse --short HEAD)"
LLAMA_VERSION="$(git -C "${LLAMA_DIR}" describe --tags --always --abbrev=0 2>/dev/null || echo "${LLAMA_COMMIT}")"
echo "  commit: ${LLAMA_COMMIT} (${LLAMA_VERSION})"

# ── Configure + build ──────────────────────────────────────────────
BUILD_DIR="${LLAMA_DIR}/build-static"
echo "→ Configuring with static linking"
# BUILD_SHARED_LIBS=OFF       → libggml/libllama statically linked
# GGML_METAL(+EMBED)          → Metal accel, shader embedded in the binary
# LLAMA_CURL=OFF              → no libcurl (we download models ourselves)
# DISABLE_FIND_PACKAGE_OpenSSL → cpp-httplib auto-links Homebrew OpenSSL if it
#   finds it, which the otool guard (rightly) rejects. We serve loopback HTTP
#   only, so no TLS is needed — force the find to fail so httplib builds plain.
# LLAMA_BUILD_SERVER=ON       → the one target we need
rm -rf "${BUILD_DIR}"
cmake -B "${BUILD_DIR}" -S "${LLAMA_DIR}" \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DLLAMA_CURL=OFF \
  -DLLAMA_SERVER_SSL=OFF \
  -DCMAKE_DISABLE_FIND_PACKAGE_OpenSSL=ON \
  -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_SERVER=ON \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
  >/tmp/sb-llama-cmake.log 2>&1 || {
    echo "✗ cmake configure failed — see /tmp/sb-llama-cmake.log"
    tail -30 /tmp/sb-llama-cmake.log
    exit 1
  }

echo "→ Building llama-server (a few minutes)…"
cmake --build "${BUILD_DIR}" --config Release -j --target llama-server \
  >/tmp/sb-llama-build.log 2>&1 || {
    echo "✗ cmake build failed — see /tmp/sb-llama-build.log"
    tail -30 /tmp/sb-llama-build.log
    exit 1
  }

BUILT="${BUILD_DIR}/bin/llama-server"
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
  echo "✗ FATAL: the built llama-server has non-system dylib dependencies:"
  echo "${LEAKED}"
  echo "  Refusing to install it. Clear ${BUILD_DIR} and ensure no"
  echo "  Homebrew BLAS/curl got picked up."
  exit 1
fi
echo "✓ only system frameworks / @rpath references"

# ── Smoke test ──────────────────────────────────────────────────────
echo "→ Smoke test (llama-server --version):"
"${BUILT}" --version 2>&1 | head -2 || true

# ── Atomic replace ──────────────────────────────────────────────────
mv -f "${BUILT}" "${DST}"
chmod +x "${DST}"
SIZE_MB="$(du -m "${DST}" | awk '{print $1}')"
echo "✓ Installed llama.cpp ${LLAMA_VERSION} (commit ${LLAMA_COMMIT}, ${SIZE_MB}MB) → ${DST}"

# ── Update SIDECAR-VERSIONS.md ──────────────────────────────────────
TODAY="$(date -u +%Y-%m-%d)"
if [ ! -f "${VERSIONS_FILE}" ]; then
  cat > "${VERSIONS_FILE}" <<'EOF'
# Bundled sidecar versions

This file tracks the version of every binary we ship under
`src-tauri/binaries/`. Updated by the scripts; do not edit by hand.

EOF
fi
python3 - "${VERSIONS_FILE}" "${LLAMA_VERSION}" "${LLAMA_COMMIT}" "${TODAY}" <<'PY'
import sys, re
path, version, commit, date = sys.argv[1:]
text = open(path).read()
text = re.sub(r'## llama-server\b.*?(?=\n## |\Z)', '', text, flags=re.DOTALL)
text = text.rstrip() + '\n\n## llama-server\n'
text += f'- version: {version} (commit {commit})\n'
text += f'- source: https://github.com/ggml-org/llama.cpp (built from source, static)\n'
text += f'- refreshed: {date}\n'
open(path, 'w').write(text)
PY
