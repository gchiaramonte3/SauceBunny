#!/usr/bin/env bash
#
# Build the Preview source capture helper (swift-sidecar's
# saucebunny-program-capture) as `Sauce Bunny Capture.app`, the nested app
# Tauri copies to Contents/Helpers (docs/PROGRAM-CAPTURE.md).
#
# It is an app, not a bare sidecar binary, because macOS's sharing picker is
# shown for an application and the filter it returns lives only in the process
# that showed it. Tauri copies it through bundle.macOS.files and never signs
# such files, so it is signed here: with APPLE_SIGNING_IDENTITY when set
# (hardened runtime, plus a secure timestamp for Developer ID), otherwise
# ad-hoc for local development.
#
# Output (not in git): src-tauri/helpers/Sauce Bunny Capture.app

set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SWIFT_DIR="${ROOT_DIR}/swift-sidecar"
OUT_DIR="${ROOT_DIR}/src-tauri/helpers"
APP="${OUT_DIR}/Sauce Bunny Capture.app"
PRODUCT="saucebunny-program-capture"

command -v swift >/dev/null 2>&1 || { echo "error: 'swift' not found on PATH. Install Xcode or the command-line tools." >&2; exit 1; }

cd "${SWIFT_DIR}"
swift build --product "${PRODUCT}" -c release --arch arm64
BIN="$(swift build --product "${PRODUCT}" -c release --arch arm64 --show-bin-path)/${PRODUCT}"
[[ -f "${BIN}" ]] || { echo "error: ${PRODUCT} was not built" >&2; exit 1; }

# Self-contained: system frameworks only. Refuse a Homebrew or user-dir dylib.
if otool -L "${BIN}" | tail -n +2 | awk '{print $1}' | grep -vE '^(/System/Library/|/usr/lib/)' | grep -q .; then
  echo "error: ${PRODUCT} links a library outside the system:" >&2
  otool -L "${BIN}" >&2
  exit 1
fi

VERSION="$(node -p "require('${ROOT_DIR}/src-tauri/tauri.conf.json').version")"
BUILD="$(node -p "require('${ROOT_DIR}/src-tauri/tauri.conf.json').bundle.macOS.bundleVersion || '1'")"

rm -rf "${APP:?}"
mkdir -p "${APP}/Contents/MacOS"
cp "${BIN}" "${APP}/Contents/MacOS/${PRODUCT}"
cat > "${APP}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.saucebunny.desktop.capture</string>
  <key>CFBundleName</key><string>Sauce Bunny Capture</string>
  <key>CFBundleDisplayName</key><string>Sauce Bunny</string>
  <key>CFBundleExecutable</key><string>${PRODUCT}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${BUILD}</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSAudioCaptureUsageDescription</key><string>Sauce Bunny records the system or app audio you choose for a Preview source. Its own playback is left out.</string>
</dict>
</plist>
PLIST

IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
if [[ -n "${IDENTITY}" && "${IDENTITY}" != "-" ]]; then
  TIMESTAMP=(--timestamp=none)
  [[ "${IDENTITY}" == *"Developer ID"* ]] && TIMESTAMP=(--timestamp)
  codesign --force --options runtime "${TIMESTAMP[@]}" --sign "${IDENTITY}" "${APP}"
else
  codesign --force --options runtime --sign - "${APP}"
fi
codesign --verify --strict "${APP}"
echo "Built ${APP}"
