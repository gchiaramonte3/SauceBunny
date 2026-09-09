#!/bin/bash
# Read-only gate for the Premiere 2026 -> NDI -> Sauce Bunny proof.
set -u

failures=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; failures=$((failures + 1)); }

SDK='/Library/NDI SDK for Apple'
PREMIERE='/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app'
MEDIA_CORE='/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore'

echo 'Premiere NDI preflight'
if sdk_info=$(pkgutil --pkg-info com.newtek.NDI.SDK 2>/dev/null); then
  sdk_version=$(printf '%s\n' "$sdk_info" | awk '/^version:/ {print $2}')
  [ "$sdk_version" = '6.3.2.0.260413' ] && pass "NDI SDK 6.3.2 installed" || fail "NDI SDK version is ${sdk_version:-unknown}; expected 6.3.2.0.260413"
else
  fail 'NDI SDK receipt missing'
fi
[ -f "$SDK/include/Processing.NDI.Lib.h" ] && pass 'NDI SDK headers available for compilation' || fail "NDI headers missing at $SDK"
if tools_info=$(pkgutil --pkg-info com.newtek.NDI-Tools 2>/dev/null); then
  tools_version=$(printf '%s\n' "$tools_info" | awk '/^version:/ {print $2}')
  [ "$tools_version" = '6.3.2.0.260413' ] && pass 'NDI Tools 6.3.2 installed' || fail "NDI Tools version is ${tools_version:-unknown}; expected 6.3.2.0.260413"
else
  fail 'NDI Tools receipt missing; the SDK alone does not provide the Premiere output plugin'
fi

if [ -d "$PREMIERE" ]; then
  premiere_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PREMIERE/Contents/Info.plist" 2>/dev/null || true)
  [ "$premiere_version" = '26.3.2' ] && pass 'Premiere Pro 2026 version 26.3.2 installed' || fail "Premiere Pro 2026 is ${premiere_version:-unknown}; expected 26.3.2"
else
  fail 'Premiere Pro 2026 is not installed'
fi

plugin=''
for root in "$MEDIA_CORE" "$PREMIERE/Contents/Plug-Ins"; do
  if [ -d "$root" ]; then
    plugin=$(find "$root" -maxdepth 5 \( -iname '*ndi*.plugin' -o -iname '*ndi*.bundle' -o -iname '*ndi*.framework' \) -print -quit 2>/dev/null)
    [ -n "$plugin" ] && break
  fi
done
[ -n "$plugin" ] && pass "Premiere NDI output plugin found: $plugin" || fail 'Premiere NDI output plugin missing; install official NDI Tools 6.3.2 before testing'
TOOLS_RUNTIME="$MEDIA_CORE/NDI_Transmit_AdobeCC.bundle/Contents/Frameworks/libndi.dylib"
[ -f "$TOOLS_RUNTIME" ] && pass 'Installed NDI Tools host runtime available independently of the SDK' || fail "NDI Tools host runtime missing at $TOOLS_RUNTIME"

monitor=$(find /Applications -maxdepth 4 -type d -iname '*NDI*Video*Monitor*.app' -print -quit 2>/dev/null)
[ -n "$monitor" ] && pass "NDI Video Monitor found: $monitor" || fail 'NDI Video Monitor missing; install official NDI Tools 6.3.2 before testing'

PLIST="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/src-tauri/Info.plist"
[ "$(/usr/libexec/PlistBuddy -c 'Print :NSBonjourServices:0' "$PLIST" 2>/dev/null)" = '_ndi._tcp' ] \
  && pass 'Sauce Bunny declares _ndi._tcp discovery' || fail 'Sauce Bunny is missing the _ndi._tcp Bonjour declaration'
[ -n "$(/usr/libexec/PlistBuddy -c 'Print :NSLocalNetworkUsageDescription' "$PLIST" 2>/dev/null)" ] \
  && pass 'Sauce Bunny declares Local Network usage' || fail 'Sauce Bunny is missing its Local Network purpose string'

if [ "$failures" -ne 0 ]; then
  printf '\nPreflight blocked by %s item(s). Do not build the test DMG yet.\n' "$failures"
  exit 1
fi
printf '\nStatic preflight passed. Confirm the Premiere source in NDI Video Monitor before starting Sauce Bunny validation.\n'
