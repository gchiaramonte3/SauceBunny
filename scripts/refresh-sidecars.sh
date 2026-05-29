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

# yt-dlp publishes a single-file macOS executable on every release.
# The latest-release alias always 302s to the most recent stable.
YT_DLP_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"
YT_DLP_DST="${BIN_DIR}/yt-dlp-aarch64-apple-darwin"
YT_DLP_TMP="${YT_DLP_DST}.new"

echo "→ Fetching latest yt-dlp from ${YT_DLP_URL}"
curl -fL --progress-bar -o "${YT_DLP_TMP}" "${YT_DLP_URL}"
chmod +x "${YT_DLP_TMP}"

# Quick smoke before atomically replacing the existing binary.
echo "→ Smoke test:"
NEW_VERSION="$("${YT_DLP_TMP}" --version)"
echo "  yt-dlp ${NEW_VERSION}"

mv "${YT_DLP_TMP}" "${YT_DLP_DST}"
echo "✓ ${YT_DLP_DST}"

# Record the refresh so we have a trail of what versions shipped when.
# First row gets a header; subsequent runs append below it.
if [[ ! -f "${VERSIONS_FILE}" ]]; then
  cat > "${VERSIONS_FILE}" <<'EOF'
# Bundled sidecar versions

Append a row here every time you refresh a sidecar binary. Newest at top.

| Date (UTC) | Sidecar | Version | Notes |
|---|---|---|---|
EOF
fi

DATE_UTC="$(date -u +%Y-%m-%d)"
# Insert AFTER the table header (line 7) so newest sits at the top.
TMP_VERSIONS="$(mktemp)"
awk -v row="| ${DATE_UTC} | yt-dlp | ${NEW_VERSION} | refresh-sidecars.sh |" '
  NR==7 { print; print row; next }
  { print }
' "${VERSIONS_FILE}" > "${TMP_VERSIONS}"
mv "${TMP_VERSIONS}" "${VERSIONS_FILE}"

echo "→ Recorded refresh in ${VERSIONS_FILE}"
echo
echo "Next steps:"
echo "  - git diff src-tauri/binaries/yt-dlp-aarch64-apple-darwin"
echo "  - npm run tauri dev   # smoke a real fetch"
echo "  - git add -A && git commit -m \"chore: refresh yt-dlp to ${NEW_VERSION}\""
