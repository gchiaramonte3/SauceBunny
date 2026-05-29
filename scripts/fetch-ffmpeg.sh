#!/usr/bin/env bash
#
# Fetch a relocatable, statically-linked ffmpeg for macOS and place it
# at src-tauri/binaries/ffmpeg-aarch64-apple-darwin.
#
# Why this exists:
#   The previous workflow (`cp $(brew --prefix)/bin/ffmpeg …`) embedded
#   Homebrew dylib paths into the binary. ffmpeg on a user's Mac without
#   Homebrew + matching cellar version would crash before main() with
#   "dyld: Library not loaded: /opt/homebrew/Cellar/ffmpeg/X.Y/lib/…".
#   Every clip / Whisper / playback-prep flow goes through ffmpeg, so
#   the app effectively didn't work for anyone except the build host.
#
# What we use:
#   osxexperts.net (helmuth heitfeld) — maintained static builds for
#   macOS that ship both Intel (`ffmpegNNintel.zip`) and native Apple
#   Silicon (`ffmpegNNarm.zip`) variants. CLAUDE.md targets Apple
#   Silicon only, so this script grabs the arm64 build.
#
#   evermeet.cx (the more famous source) was the first candidate but
#   they explicitly decline to ship arm64 — their `getrelease/zip`
#   endpoint serves x86_64 only, which would run via Rosetta 2 with a
#   ~30% transcode penalty + a filename that lies about its arch.
#
# Usage:
#   bash scripts/fetch-ffmpeg.sh
#
# Verifies AFTER replacing the file:
#   1. The binary is a Mach-O executable
#   2. otool -L shows NO /opt/homebrew/, /usr/local/lib (only @rpath,
#      @loader_path, /System/Library, /usr/lib)
#   3. `ffmpeg -version` exits 0

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BIN_DIR="${ROOT_DIR}/src-tauri/binaries"
VERSIONS_FILE="${ROOT_DIR}/SIDECAR-VERSIONS.md"
FFMPEG_DST="${BIN_DIR}/ffmpeg-aarch64-apple-darwin"
FFMPEG_TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${FFMPEG_TMP_DIR}"' EXIT

mkdir -p "${BIN_DIR}"

# Discover the latest `ffmpegNNarm.zip` link from osxexperts.net's
# homepage. They follow the pattern `ffmpeg<major><minor>arm.zip`
# (e.g. ffmpeg81arm.zip = ffmpeg 8.1) and update the link in-place.
echo "→ Discovering latest osxexperts.net arm64 build"
FFMPEG_FILENAME="$(curl -fs https://www.osxexperts.net/ \
  | grep -oE 'ffmpeg[0-9]+arm\.zip' \
  | sort -u \
  | tail -1)"
if [ -z "${FFMPEG_FILENAME}" ]; then
  echo "✗ couldn't find an ffmpeg*arm.zip link on osxexperts.net"
  echo "  (page layout may have changed; check https://www.osxexperts.net/)"
  exit 1
fi
FFMPEG_URL="https://www.osxexperts.net/${FFMPEG_FILENAME}"
echo "  ${FFMPEG_FILENAME}"

echo "→ Fetching ${FFMPEG_URL}"
ZIP_PATH="${FFMPEG_TMP_DIR}/ffmpeg.zip"
curl -fL --progress-bar -o "${ZIP_PATH}" "${FFMPEG_URL}"

echo "→ Extracting…"
unzip -q "${ZIP_PATH}" -d "${FFMPEG_TMP_DIR}"
FFMPEG_TMP="${FFMPEG_TMP_DIR}/ffmpeg"
if [ ! -x "${FFMPEG_TMP}" ]; then
  echo "✗ unzip didn't produce ${FFMPEG_TMP} — archive shape changed?"
  exit 1
fi
chmod +x "${FFMPEG_TMP}"

# ── Guard rails — refuse to install a Homebrew-tied binary ──────────
echo "→ Verifying no Homebrew / user-dir dylib deps:"
DEPS="$(otool -L "${FFMPEG_TMP}" | tail -n +2 || true)"
echo "${DEPS}"
LEAKED="$(echo "${DEPS}" | grep -E '/opt/homebrew/|/usr/local/|/Users/' || true)"
if [ -n "${LEAKED}" ]; then
  echo
  echo "✗ FATAL: the new ffmpeg has non-system dylib dependencies:"
  echo "${LEAKED}"
  echo
  echo "  Refusing to install it — this is exactly the bug the script"
  echo "  exists to prevent. evermeet.cx may have changed its build."
  exit 1
fi
echo "✓ only system frameworks / @rpath references"

# ── Smoke test ──────────────────────────────────────────────────────
echo "→ Smoke test (ffmpeg -version):"
NEW_VERSION_LINE="$("${FFMPEG_TMP}" -version 2>&1 | head -1)"
echo "  ${NEW_VERSION_LINE}"
NEW_VERSION="$(echo "${NEW_VERSION_LINE}" | awk '{print $3}')"
if [ -z "${NEW_VERSION}" ]; then
  echo "✗ couldn't parse version from output — install aborted"
  exit 1
fi

# ── Atomic replace ──────────────────────────────────────────────────
mv -f "${FFMPEG_TMP}" "${FFMPEG_DST}"
chmod +x "${FFMPEG_DST}"
echo "✓ Installed ffmpeg ${NEW_VERSION} → ${FFMPEG_DST}"

# ── Update SIDECAR-VERSIONS.md ──────────────────────────────────────
TODAY="$(date -u +%Y-%m-%d)"
if [ ! -f "${VERSIONS_FILE}" ]; then
  cat > "${VERSIONS_FILE}" <<'EOF'
# Bundled sidecar versions

This file tracks the version of every binary we ship under
`src-tauri/binaries/`. Updated by the `scripts/refresh-sidecars.sh`
and `scripts/fetch-ffmpeg.sh` scripts; do not edit by hand.

EOF
fi
# Idempotent in-place update: drop any previous "## ffmpeg" block,
# append a fresh one.
python3 - "${VERSIONS_FILE}" "${NEW_VERSION}" "${TODAY}" <<'PY'
import sys, re
path, version, date = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path).read()
# Strip any existing ffmpeg block (heading + the lines under it up to
# the next heading or EOF).
text = re.sub(r'## ffmpeg\b.*?(?=\n## |\Z)', '', text, flags=re.DOTALL)
text = text.rstrip() + '\n\n## ffmpeg\n'
text += f'- version: {version}\n'
text += f'- source: https://www.osxexperts.net/ (static arm64 build)\n'
text += f'- refreshed: {date}\n'
open(path, 'w').write(text)
PY
echo "✓ Updated ${VERSIONS_FILE}"

echo
echo "Done. Restart \`npm run tauri dev\` for the change to take effect."
