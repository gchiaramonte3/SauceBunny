#!/usr/bin/env bash
# Shared trust-on-first-use gate for the sidecar fetch scripts. SOURCE this
# file (`. "${SCRIPT_DIR}/sidecar-pin.sh"`); do not execute it.
#
# One function, called at the one moment that matters: after a download has
# landed in a temp file and BEFORE it is made executable or moved into
# src-tauri/binaries/. Until this existed, ffmpeg was fetched by scraping a
# vendor's homepage for a filename and then chmod +x'd and RUN with no
# integrity check of any kind, and yt-dlp came from a mutable "latest"
# pointer - so what ended up inside the signed .dmg was whatever the network
# served that day.
#
# The pin lives in sidecars.lock.json. Accepting a new upstream build is
# deliberate (--accept-new) and rewrites that file, which makes the change a
# reviewable git diff instead of a silent substitution.

# sb_pin_accept_new: set to 1 by sb_pin_parse_args when --accept-new is passed.
SB_PIN_ACCEPT_NEW="${SB_PIN_ACCEPT_NEW:-0}"

# Consume our flag out of "$@" so callers can pass their own args through.
sb_pin_parse_args() {
  for arg in "$@"; do
    case "${arg}" in
      --accept-new) SB_PIN_ACCEPT_NEW=1 ;;
    esac
  done
}

# sb_pin_check <name> <file>
#
# Verifies <file> against the pin for <name>. Exits non-zero on mismatch
# unless --accept-new was passed, in which case it rewrites the pin and tells
# the caller to review the diff. A name with no pin yet is recorded (first
# use) rather than treated as an error, so adding a sidecar does not require
# hand-editing JSON.
sb_pin_check() {
  local name="$1" file="$2"
  local root lock
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  lock="${root}/sidecars.lock.json"

  if [ ! -f "${file}" ]; then
    printf '\033[31m✗ %s: nothing downloaded to verify (%s)\033[0m\n' "${name}" "${file}" >&2
    return 1
  fi

  SB_PIN_NAME="${name}" SB_PIN_FILE="${file}" SB_PIN_LOCK="${lock}" \
  SB_PIN_ACCEPT="${SB_PIN_ACCEPT_NEW}" python3 <<'PY'
import hashlib, json, os, sys

name   = os.environ["SB_PIN_NAME"]
path   = os.environ["SB_PIN_FILE"]
lock_p = os.environ["SB_PIN_LOCK"]
accept = os.environ["SB_PIN_ACCEPT"] == "1"

h = hashlib.sha256()
with open(path, "rb") as f:
    for chunk in iter(lambda: f.read(1 << 20), b""):
        h.update(chunk)
got, size = h.hexdigest(), os.path.getsize(path)

try:
    with open(lock_p) as f:
        lock = json.load(f)
except FileNotFoundError:
    lock = {"schema": 1, "binaries": {}}

entry = lock.setdefault("binaries", {}).get(name)

def write_pin(reason):
    lock["binaries"].setdefault(name, {})
    lock["binaries"][name].update({"sha256": got, "bytes": size})
    with open(lock_p, "w") as f:
        json.dump(lock, f, indent=2)
        f.write("\n")
    print(f"  ✓ {name} pin {reason}: {got}")
    print("    Review before committing:  git diff sidecars.lock.json")

if entry is None or not entry.get("sha256"):
    write_pin("recorded (first use)")
    sys.exit(0)

if entry["sha256"] == got:
    print(f"  ✓ {name} matches its pin ({got[:16]}…)")
    sys.exit(0)

if accept:
    print(f"  ! {name} changed upstream")
    print(f"      was {entry['sha256']} ({entry.get('bytes', 0)} bytes)")
    print(f"      now {got} ({size} bytes)")
    write_pin("updated (--accept-new)")
    sys.exit(0)

sys.stderr.write(
    f"\033[31m✗ {name} does NOT match sidecars.lock.json\033[0m\n"
    f"    expected {entry['sha256']} ({entry.get('bytes', 0)} bytes)\n"
    f"    got      {got} ({size} bytes)\n"
    "\n"
    "    The upstream artifact changed. Nothing has been installed.\n"
    "    This is the check working: decide whether the new build is one you\n"
    "    want to ship, then re-run this script with --accept-new to move the\n"
    "    pin and produce a reviewable diff.\n"
)
sys.exit(1)
PY
}
