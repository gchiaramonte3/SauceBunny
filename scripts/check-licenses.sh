#!/usr/bin/env bash
#
# Refuse a dependency whose licence would reach Sauce Bunny's own MIT source.
#
# CLAUDE.md's rule: permissive is the default, weak copyleft is fine while the
# dependency stays a separate library or binary (the app already ships MPL-2.0
# mediabunny, LGPL inside the ffmpeg build, OFL-1.1 Nunito Sans), and strong
# copyleft — GPL, AGPL — is out, because it would relicense the whole app.
#
# That rule was written down and never checked. A transitive crate is one
# `cargo update` away from arriving under GPL, nothing would fail, and the
# first anyone would know is a licence audit after release. Both graphs are
# clean today: 751 crates and 253 npm packages, zero strong copyleft.
#
# The bundled ffmpeg/ffprobe ARE GPLv3 and are deliberately exempt — they are
# separate subprocesses, never linked, and THIRD-PARTY-LICENSES.md carries the
# §6 written offer that redistribution requires.

set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

echo "→ Rust crates"
cargo metadata --format-version 1 --manifest-path src-tauri/Cargo.toml 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
bad = []
for p in d["packages"]:
    lic = (p.get("license") or "").upper()
    # LGPL is weak copyleft and allowed; "GPL" alone or AGPL is not.
    if "AGPL" in lic or ("GPL" in lic and "LGPL" not in lic):
        bad.append((p["name"], p.get("license")))
pkgs = d["packages"]
print("   %d crates in the graph" % len(pkgs))
for n, l in bad:
    print(f"   ✗ {n}: {l}")
sys.exit(1 if bad else 0)
' || fail=1

echo "→ npm packages"
python3 - <<'PY' || fail=1
import json, pathlib, sys
bad = []
n = 0
root = pathlib.Path("node_modules")
# EVERY package root, not just the unscoped top level. `glob("*/package.json")`
# matched 148 of 253 and silently skipped all 101 @scope/name packages - which is
# precisely where the shipped runtime deps live (@mediabunny/*, @fontsource/*,
# @tauri-apps/*). It printed a confident count and passed, and CI leaned on it for
# the claim that a strong-copyleft arrival would fail the build. It would not have.
# An explicit union rather than rglob("package.json"), which also sweeps ~28
# internal sub-manifests (test fixtures, dist folders) and inflates the number.
roots = (list(root.glob("*/package.json")) + list(root.glob("@*/*/package.json"))
         + list(root.glob("*/node_modules/*/package.json"))
         + list(root.glob("*/node_modules/@*/*/package.json")))
for pj in roots:
    try: d = json.loads(pj.read_text())
    except Exception: continue
    n += 1
    lic = str(d.get("license") or "").upper()
    if "AGPL" in lic or ("GPL" in lic and "LGPL" not in lic):
        bad.append((d.get("name"), d.get("license")))
print(f"   {n} packages scanned")
for name, lic in bad:
    print(f"   ✗ {name}: {lic}")
sys.exit(1 if bad else 0)
PY

if [ "$fail" -ne 0 ]; then
  echo
  echo "✗ a dependency carries strong copyleft — it would reach the app's own MIT source." >&2
  echo "  Replace it, or argue the case in CLAUDE.md's dependency rule first." >&2
  exit 1
fi
echo
echo "✓ no strong-copyleft dependencies"
