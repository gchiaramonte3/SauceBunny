#!/usr/bin/env bash
# Verify every installed sidecar against sidecars.lock.json.
#
# WHY THIS EXISTS
# Everything in src-tauri/binaries/ ends up inside a signed, notarized .dmg
# that other people run. Until now the fetch scripts trusted the network on
# every single run: fetch-ffmpeg.sh scraped a vendor's HOMEPAGE for a filename,
# downloaded whatever it found, chmod +x'd it and EXECUTED it (`ffmpeg
# -version`) with no integrity check anywhere in between. The runtime yt-dlp
# updater in src-tauri/src/commands/download.rs already did this properly -
# resolve an immutable release, fetch its checksum manifest, verify BEFORE
# chmod - so the app held its own downloads to a standard the build did not.
#
# The model here is trust-on-first-use. sidecars.lock.json records the exact
# bytes we have decided to ship. Every fetch and every release verifies against
# it. Accepting a new upstream version is a deliberate act (--accept-new) that
# rewrites the lock file, so the change arrives as a reviewable git diff rather
# than as a silent substitution nobody sees.
#
# Publisher checksums are cross-checked where they exist (yt-dlp publishes
# SHA2-256SUMS per release), but they are served by the same host as the
# artifact - so they prove the download was not corrupted in transit, not that
# the artifact is what we reviewed. Only the committed lock file does that.
#
# Usage:
#   scripts/verify-sidecars.sh            # verify; non-zero exit on mismatch
#   scripts/verify-sidecars.sh --quiet    # only print problems
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="${ROOT_DIR}/sidecars.lock.json"
BIN_DIR="${ROOT_DIR}/src-tauri/binaries"
TRIPLE="aarch64-apple-darwin"
QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

say() { [ "${QUIET}" -eq 1 ] || printf '%s\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; }

[ -f "${LOCK}" ] || { fail "sidecars.lock.json is missing. Run a fetch script with --accept-new to create it."; exit 1; }

# Read the manifest with python (already required by the fetch scripts) rather
# than adding a jq dependency to a repo that does not have one.
NAMES="$(python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    lock = json.load(f)
if lock.get("schema") != 1:
    sys.stderr.write("unsupported lock schema\n"); sys.exit(1)
for name in sorted(lock.get("binaries", {})):
    print(name)
' "${LOCK}")"

problems=0
missing=0
checked=0

for name in ${NAMES}; do
  path="${BIN_DIR}/${name}-${TRIPLE}"
  read -r want_sha want_bytes kind <<EOF
$(python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    e = json.load(f)["binaries"][sys.argv[2]]
print(e["sha256"], e["bytes"], e.get("kind", "unknown"))
' "${LOCK}" "${name}")
EOF

  if [ ! -f "${path}" ]; then
    # Not an error by itself: a fresh clone has no binaries until `npm run
    # setup`, and CI deliberately stubs them. Report and keep going.
    say "  ○ ${name} not installed"
    missing=$((missing + 1))
    continue
  fi

  got_bytes="$(wc -c < "${path}" | tr -d ' ')"
  got_sha="$(shasum -a 256 "${path}" | cut -d' ' -f1)"
  checked=$((checked + 1))

  if [ "${got_sha}" = "${want_sha}" ]; then
    say "  ✓ ${name} (${kind})"
    continue
  fi

  problems=$((problems + 1))
  fail "${name}: does not match the pin in sidecars.lock.json"
  printf '    expected %s (%s bytes)\n' "${want_sha}" "${want_bytes}" >&2
  printf '    found    %s (%s bytes)\n' "${got_sha}" "${got_bytes}" >&2
  if [ "${kind}" = "source" ]; then
    printf '    This one is built locally, so a rebuild explains it. If that was you,\n' >&2
    printf '    re-pin deliberately: scripts/repin-sidecar.sh %s\n' "${name}" >&2
  else
    printf '    This one is DOWNLOADED. A changed hash means the upstream artifact moved.\n' >&2
    printf '    Do not ship it until you know why. To accept it, re-run its fetch script\n' >&2
    printf '    with --accept-new and review the sidecars.lock.json diff.\n' >&2
  fi
done

say ""
if [ "${problems}" -gt 0 ]; then
  fail "${problems} sidecar(s) do not match their pin."
  exit 1
fi
say "✓ ${checked} sidecar(s) match their pins${missing:+, ${missing} not installed}"
