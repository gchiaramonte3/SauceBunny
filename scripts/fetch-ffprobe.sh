#!/usr/bin/env bash
#
# Fetch a relocatable, statically-linked ffprobe for macOS arm64 and
# place it at src-tauri/binaries/ffprobe-aarch64-apple-darwin.
#
# Why this exists (r81):
#   yt-dlp needs ffprobe — NOT just ffmpeg — to correctly fix up HLS
#   downloads. Past LIVE broadcasts (and some other sources) are served
#   as HLS only; yt-dlp's native downloader pulls MPEG-TS fragments and
#   then runs FixupM3u8 to rewrap them as MP4. Without ffprobe it CANNOT
#   detect that the AAC needs the `aac_adtstoasc` bitstream filter, so it
#   ships an MP4 whose audio is still raw ADTS — WKWebView refuses to
#   decode it and the player stays black. With ffprobe present the fixup
#   produces a clean avc1/mp4a faststart MP4 (verified). yt-dlp finds it
#   automatically as a sibling of the ffmpeg binary we pass via
#   `--ffmpeg-location` (it derives `ffprobe-<triple>` from `ffmpeg-<triple>`).
#
#   We can't reuse scripts/fetch-ffmpeg.sh's source: osxexperts.net ships
#   ffmpeg ONLY. martin-riedl.de publishes a separate static arm64 ffprobe.
#
# Distribution rule (CLAUDE.md): the binary MUST be self-contained — no
# /opt/homebrew, /usr/local, or /Users dylib references. This script
# enforces that with an otool -L guard and refuses to install a leaky one.
#
# Usage:
#   bash scripts/fetch-ffprobe.sh   (or: npm run refresh:ffprobe)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BIN_DIR="${ROOT_DIR}/src-tauri/binaries"
VERSIONS_FILE="${ROOT_DIR}/SIDECAR-VERSIONS.md"
DST="${BIN_DIR}/ffprobe-aarch64-apple-darwin"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

mkdir -p "${BIN_DIR}"

# martin-riedl.de keeps a stable "latest" redirect for each platform/tool.
FFPROBE_URL="https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffprobe.zip"

echo "→ Fetching ${FFPROBE_URL}"
ZIP_PATH="${TMP_DIR}/ffprobe.zip"
curl -fL --progress-bar -o "${ZIP_PATH}" "${FFPROBE_URL}"

echo "→ Extracting…"
unzip -q "${ZIP_PATH}" -d "${TMP_DIR}"
FFPROBE_TMP="${TMP_DIR}/ffprobe"
if [ ! -x "${FFPROBE_TMP}" ]; then
  echo "✗ unzip didn't produce ${FFPROBE_TMP} — archive shape changed?"
  exit 1
fi
chmod +x "${FFPROBE_TMP}"

# ── Arch check — must be native arm64, not x86_64 (Rosetta) ──────────
echo "→ Verifying arch (must be arm64):"
ARCH_LINE="$(file "${FFPROBE_TMP}")"
echo "  ${ARCH_LINE}"
if ! echo "${ARCH_LINE}" | grep -q "arm64"; then
  echo "✗ FATAL: not an arm64 binary — refusing (we target Apple Silicon only)."
  exit 1
fi

# ── Guard rails — refuse to install a Homebrew / user-dir-tied binary ──
echo "→ Verifying no Homebrew / user-dir dylib deps:"
DEPS="$(otool -L "${FFPROBE_TMP}" | tail -n +2 || true)"
echo "${DEPS}"
LEAKED="$(echo "${DEPS}" | grep -E '/opt/homebrew/|/usr/local/|/Users/' || true)"
if [ -n "${LEAKED}" ]; then
  echo
  echo "✗ FATAL: the new ffprobe has non-system dylib dependencies:"
  echo "${LEAKED}"
  echo "  Refusing to install it (would crash on a clean Mac)."
  exit 1
fi
echo "✓ only system frameworks / @rpath references"

# ── Smoke test ──────────────────────────────────────────────────────
echo "→ Smoke test (ffprobe -version):"
NEW_VERSION_LINE="$("${FFPROBE_TMP}" -version 2>&1 | head -1)"
echo "  ${NEW_VERSION_LINE}"
NEW_VERSION="$(echo "${NEW_VERSION_LINE}" | awk '{print $3}' | cut -d- -f1)"
if [ -z "${NEW_VERSION}" ]; then
  echo "✗ couldn't parse version from output — install aborted"
  exit 1
fi

# ── Atomic replace ──────────────────────────────────────────────────
mv -f "${FFPROBE_TMP}" "${DST}"
chmod +x "${DST}"
echo "✓ Installed ffprobe ${NEW_VERSION} → ${DST}"

# ── Update SIDECAR-VERSIONS.md ──────────────────────────────────────
TODAY="$(date -u +%Y-%m-%d)"
if [ ! -f "${VERSIONS_FILE}" ]; then
  cat > "${VERSIONS_FILE}" <<'EOF'
# Bundled sidecar versions

This file tracks the version of every binary we ship under
`src-tauri/binaries/`. Updated by the refresh scripts; do not edit by hand.

EOF
fi
# Idempotent in-place update: drop any previous "## ffprobe" block, append fresh.
python3 - "${VERSIONS_FILE}" "${NEW_VERSION}" "${TODAY}" <<'PY'
import sys, re
path, version, date = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path).read()
text = re.sub(r'## ffprobe\b.*?(?=\n## |\Z)', '', text, flags=re.DOTALL)
text = text.rstrip() + '\n\n## ffprobe\n'
text += f'- version: {version}\n'
text += f'- source: https://ffmpeg.martin-riedl.de/ (static arm64 build)\n'
text += f'- refreshed: {date}\n'
open(path, 'w').write(text)
PY
echo "✓ Updated ${VERSIONS_FILE}"

echo
echo "Done. Restart \`npm run tauri dev\` for the change to take effect."
