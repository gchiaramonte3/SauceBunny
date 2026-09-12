#!/usr/bin/env bash
# Read-only gate: the private core must not import global keyboard/mouse APIs.
set -euo pipefail
[[ $# = 1 && -f "$1" ]] || { echo 'usage: check-obs-core.sh <libobs-binary>' >&2; exit 2; }
undefined_symbols="$(/usr/bin/nm -u "$1")"
# A shell match avoids an early-exiting grep/rg causing SIGPIPE under pipefail.
case "$undefined_symbols" in
  *CGEventTapCreate*|*CGPreflightListenEventAccess*|*CGRequestListenEventAccess*|*CGEventSourceKeyState*|*CGEventSourceButtonState*)
    echo 'Global input API remains in the embedded core.' >&2
    exit 4
    ;;
esac
