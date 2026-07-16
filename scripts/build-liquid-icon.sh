#!/bin/bash
# Compiles the macOS 26 "Liquid Glass" app icon:
#   src-tauri/icons/AppIcon.icon  (source: icon.json + Assets/bunny.svg)
#     └─ actool ─▶ src-tauri/icons/Assets.car  (bundled into Contents/Resources
#                  via tauri.conf.json bundle.resources; macOS 26+ reads it via
#                  Info.plist CFBundleIconName=AppIcon)
#     └─ actool ─▶ src-tauri/icons/icon.icns   (Apple's own backward-compatible
#                  render of the same icon, used by macOS 14–25)
#
# Rerun after editing AppIcon.icon (Icon Composer or by hand — the icon.json
# schema mirrors what Icon Composer writes; see the file for the layer setup).
#
# Requires FULL Xcode (actool lives in Xcode, not the Command Line Tools).
# xcode-select may point at the CLT — we route through Xcode explicitly.
set -euo pipefail
cd "$(dirname "$0")/.."

XCODE_DEV="/Applications/Xcode.app/Contents/Developer"
if [ ! -x "$XCODE_DEV/usr/bin/actool" ]; then
  echo "error: actool not found — install Xcode (Command Line Tools are not enough)." >&2
  exit 1
fi

ICON="src-tauri/icons/AppIcon.icon"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

DEVELOPER_DIR="$XCODE_DEV" xcrun actool "$ICON" --compile "$OUT" \
  --output-format human-readable-text --notices --warnings --errors \
  --output-partial-info-plist "$OUT/AppIcon-partial.plist" \
  --app-icon AppIcon --include-all-app-icons \
  --enable-on-demand-resources NO \
  --development-region en \
  --target-device mac \
  --minimum-deployment-target 26.0 \
  --platform macosx

[ -s "$OUT/Assets.car" ] || { echo "error: actool produced no Assets.car" >&2; exit 1; }
[ -s "$OUT/AppIcon.icns" ] || { echo "error: actool produced no AppIcon.icns" >&2; exit 1; }

cp "$OUT/Assets.car"   src-tauri/icons/Assets.car
cp "$OUT/AppIcon.icns" src-tauri/icons/icon.icns

# Refresh the small PNGs tauri.conf.json references from Apple's render so
# every surface shows the same art. (Apple's icns tops out at 256px; the
# 1024 masters icon.png/source.png stay on the classic grid for dev embeds.)
rm -rf "$OUT/iconset" && iconutil -c iconset src-tauri/icons/icon.icns -o "$OUT/iconset"
BIG="$(ls "$OUT/iconset" | sort -t_ -k2 -n | tail -1)"
sips -z 32 32   "$OUT/iconset/$BIG" --out src-tauri/icons/32x32.png      >/dev/null
sips -z 128 128 "$OUT/iconset/$BIG" --out src-tauri/icons/128x128.png    >/dev/null
sips -z 256 256 "$OUT/iconset/$BIG" --out src-tauri/icons/128x128@2x.png >/dev/null
rm -rf src-tauri/icons/icon.iconset && mkdir src-tauri/icons/icon.iconset
cp "$OUT/iconset/"* src-tauri/icons/icon.iconset/

echo "ok: Assets.car + icon.icns rebuilt from $ICON"
