#!/usr/bin/env bash
# Pinned official runtime; never execute an unverified downloaded binary.
set -euo pipefail
TASK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASK_TMP="$(mktemp -d -t sauce-deno)"
VERSION=2.8.0
ARCHIVE_SHA=dba813b8b69d6218cffb11252b9e4e6036ca2c9d79843cde367b4b369aaf9634
BINARY_SHA=eeb555a6cb902f5a08c0e3a629e011fa9da21d74b5a686939b5e119c1f0f7323
curl --fail --location --proto '=https' --tlsv1.2 "https://github.com/denoland/deno/releases/download/v${VERSION}/deno-aarch64-apple-darwin.zip" -o "${TASK_TMP}/deno.zip"
test "$(shasum -a 256 "${TASK_TMP}/deno.zip" | cut -d' ' -f1)" = "${ARCHIVE_SHA}"
unzip -q "${TASK_TMP}/deno.zip" -d "${TASK_TMP}/unpacked"
test "$(shasum -a 256 "${TASK_TMP}/unpacked/deno" | cut -d' ' -f1)" = "${BINARY_SHA}"
install -m 755 "${TASK_TMP}/unpacked/deno" "${TASK_ROOT}/src-tauri/binaries/deno-aarch64-apple-darwin"
"${TASK_ROOT}/src-tauri/binaries/deno-aarch64-apple-darwin" --version
printf 'Verified archive retained at %s\n' "${TASK_TMP}"
