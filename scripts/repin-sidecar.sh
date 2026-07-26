#!/usr/bin/env bash
# Move a sidecar's pin in sidecars.lock.json to whatever is installed now.
#
# This is the deliberate half of trust-on-first-use. Verification refuses to
# ship bytes that do not match the lock; this is how a new version becomes the
# new expectation - explicitly, by a human, producing a git diff that a reviewer
# can see. Never call it from another script, and never call it to "make the
# error go away": for a DOWNLOADED sidecar a changed hash means the upstream
# artifact moved, and that is exactly the event this whole mechanism exists to
# make visible.
#
# Usage:
#   scripts/repin-sidecar.sh whisper-cli          # re-pin one
#   scripts/repin-sidecar.sh --all                # re-pin everything installed
#   scripts/repin-sidecar.sh whisper-cli --note "rebuilt against whisper.cpp v1.8.2"
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="${ROOT_DIR}/sidecars.lock.json"
BIN_DIR="${ROOT_DIR}/src-tauri/binaries"
TRIPLE="aarch64-apple-darwin"

[ -f "${LOCK}" ] || { printf '✗ sidecars.lock.json is missing\n' >&2; exit 1; }
[ "$#" -ge 1 ] || {
  printf 'usage: %s <sidecar-name|--all> [--note "why"]\n' "$0" >&2
  printf 'known: ' >&2
  python3 -c 'import json,sys; print(" ".join(sorted(json.load(open(sys.argv[1]))["binaries"])))' "${LOCK}" >&2
  exit 2
}

TARGET="$1"; shift
NOTE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --note) NOTE="${2:-}"; shift 2 ;;
    *) printf '✗ unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

python3 - "${LOCK}" "${BIN_DIR}" "${TRIPLE}" "${TARGET}" "${NOTE}" <<'PY'
import hashlib, json, os, sys

lock_path, bin_dir, triple, target, note = sys.argv[1:6]
with open(lock_path) as f:
    lock = json.load(f)

binaries = lock.get("binaries", {})
names = sorted(binaries) if target == "--all" else [target]
if target != "--all" and target not in binaries:
    sys.exit(f"unknown sidecar '{target}'. Known: {', '.join(sorted(binaries))}")

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

changed = []
for name in names:
    path = os.path.join(bin_dir, f"{name}-{triple}")
    if not os.path.isfile(path):
        print(f"  ○ {name} is not installed, skipping")
        continue
    entry = binaries[name]
    new_sha, new_bytes = sha256(path), os.path.getsize(path)
    if entry.get("sha256") == new_sha:
        print(f"  = {name} already pinned to these bytes")
        continue
    print(f"  → {name}")
    print(f"      was {entry.get('sha256', '(none)')} ({entry.get('bytes', 0)} bytes)")
    print(f"      now {new_sha} ({new_bytes} bytes)")
    entry["sha256"], entry["bytes"] = new_sha, new_bytes
    if note:
        entry["note"] = note
    changed.append(name)

if not changed:
    print("\nNothing to re-pin.")
    sys.exit(0)

with open(lock_path, "w") as f:
    json.dump(lock, f, indent=2)
    f.write("\n")
print(f"\n✓ Re-pinned: {', '.join(changed)}")
print("  Review the diff before committing - for a downloaded sidecar this is")
print("  the moment to confirm the upstream change was expected:")
print("      git diff sidecars.lock.json")
PY
