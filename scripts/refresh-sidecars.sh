#!/usr/bin/env bash
#
# Refresh the bundled yt-dlp binary. YouTube extractors rot on a near-
# weekly cadence — this script grabs the latest official static build
# and records the version we used in SIDECAR-VERSIONS.md.
#
# Usage:
#   bash scripts/refresh-sidecars.sh
#
# What it does NOT touch:
#   - ffmpeg: use `bash scripts/fetch-ffmpeg.sh` — that pulls a
#     statically-linked, native arm64 build from osxexperts.net.
#     DO NOT `cp $(brew --prefix)/bin/ffmpeg …`: the Homebrew binary
#     embeds absolute /opt/homebrew/Cellar/ffmpeg/X.Y/lib/ dylib paths
#     and crashes on any user's Mac without that exact install.
#   - whisper-cli: build whisper.cpp from source
#     (https://github.com/ggerganov/whisper.cpp) and copy the binary
#     into src-tauri/binaries/whisper-cli-aarch64-apple-darwin. Same
#     guard rail applies — check `otool -L` shows no /opt/homebrew/ or
#     /usr/local/ entries before committing.
#   - saucebunny-diarize: we own that one; rebuild with `npm run build:diarizer`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BIN_DIR="${ROOT_DIR}/src-tauri/binaries"
VERSIONS_FILE="${ROOT_DIR}/SIDECAR-VERSIONS.md"

mkdir -p "${BIN_DIR}"

# shellcheck source=scripts/sidecar-pin.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sidecar-pin.sh"
sb_pin_parse_args "$@"

# yt-dlp publishes a single-file macOS executable on every release.
# The latest-release alias always 302s to the most recent stable.
YT_DLP_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"
YT_DLP_DST="${BIN_DIR}/yt-dlp-aarch64-apple-darwin"
YT_DLP_TMP="${YT_DLP_DST}.new"

echo "→ Fetching latest yt-dlp from ${YT_DLP_URL}"
curl -fL --progress-bar -o "${YT_DLP_TMP}" "${YT_DLP_URL}"

# Verify BEFORE the file can be executed. The order matters: the smoke test
# below runs this binary, and "it runs" is not evidence that it is the artifact
# we reviewed. This URL is the MUTABLE latest-release alias, so what arrives
# changes without warning - which is the whole reason for the pin.
echo "→ Verifying against sidecars.lock.json:"
sb_pin_check "yt-dlp" "${YT_DLP_TMP}" || { rm -f "${YT_DLP_TMP}"; exit 1; }
chmod +x "${YT_DLP_TMP}"

# Quick smoke before atomically replacing the existing binary.
echo "→ Smoke test:"
NEW_VERSION="$("${YT_DLP_TMP}" --version)"
echo "  yt-dlp ${NEW_VERSION}"

mv "${YT_DLP_TMP}" "${YT_DLP_DST}"
echo "✓ ${YT_DLP_DST}"

# Record the refresh so we have a trail of what versions shipped when.
# SIDECAR-VERSIONS.md uses the `## section` format shared with
# fetch-ffmpeg.sh / fetch-ffprobe.sh / build-whisper.sh — the old
# line-7 table insert corrupted that file (its line 7 is prose now).
DATE_UTC="$(date -u +%Y-%m-%d)"
if [[ ! -f "${VERSIONS_FILE}" ]]; then
  cat > "${VERSIONS_FILE}" <<'EOF'
# Bundled sidecar versions

This file tracks the version of every binary we ship under
`src-tauri/binaries/`. Updated by the refresh scripts; do not edit by hand.

EOF
fi
# Idempotent in-place update: drop any previous "## yt-dlp" block, append fresh.
python3 - "${VERSIONS_FILE}" "${NEW_VERSION}" "${DATE_UTC}" <<'PY'
import sys, re
path, version, date = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path).read()
text = re.sub(r'## yt-dlp\b.*?(?=\n## |\Z)', '', text, flags=re.DOTALL)
text = text.rstrip() + '\n\n## yt-dlp\n'
text += f'- version: {version}\n'
text += f'- source: https://github.com/yt-dlp/yt-dlp (official single-file macOS static build)\n'
text += f'- refreshed: {date}\n'
open(path, 'w').write(text)
PY

echo "→ Recorded refresh in ${VERSIONS_FILE}"
echo
echo "Next steps:"
echo "  - git diff src-tauri/binaries/yt-dlp-aarch64-apple-darwin"
echo "  - npm run tauri dev   # smoke a real fetch"
echo "  - git add -A && git commit -m \"chore: refresh yt-dlp to ${NEW_VERSION}\""
