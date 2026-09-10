#!/usr/bin/env bash
# Source from local build entry points. A code-changing ad-hoc identity loses
# macOS privacy continuity; never silently fall back to it for an internal app.
if [ "${APPLE_SIGNING_IDENTITY:-}" = "-" ]; then
  echo "Ad-hoc signing is not supported for permission-validation builds." >&2
  exit 1
fi
if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  SAUCE_SIGNING_CANDIDATES="$(security find-identity -v -p codesigning | sed -n -E 's/.* ([A-F0-9]{40}) "Apple Development:.*"/\1/p')"
  if [ -z "$SAUCE_SIGNING_CANDIDATES" ] || [ "$(printf '%s\n' "$SAUCE_SIGNING_CANDIDATES" | wc -l | tr -d ' ')" -ne 1 ]; then
    echo "Set APPLE_SIGNING_IDENTITY to a valid Apple Development identity (internal) or Developer ID Application identity (distribution). No ad-hoc fallback." >&2
    exit 1
  fi
  export APPLE_SIGNING_IDENTITY="$SAUCE_SIGNING_CANDIDATES"
fi
