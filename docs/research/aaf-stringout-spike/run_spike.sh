#!/usr/bin/env bash
# End-to-end spike: fixture -> cuts -> string-outs A/B/C -> verification.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${REPO:-$(cd "$HERE/../../.." && pwd)}"
PY="${PY:-$HERE/venv/bin/python}"
cd "$HERE" && mkdir -p out
"$PY" make_source_fixture.py --output out/source_group.aaf
"$PY" make_cuts.py out/source_group.aaf.json out/cuts.json
SEQ=$("$PY" -c "import json;print(json.load(open('out/source_group.aaf.json'))['sequence_id'])")
GRP=$("$PY" -c "import json;print(json.load(open('out/source_group.aaf.json'))['group_id'])")
for A in A B C; do
  rm -f "out/stringout_$A.aaf"
  "$PY" write_stringout.py --source out/source_group.aaf --sequence-id "$SEQ" --group-id "$GRP" \
    --cuts out/cuts.json --approach "$A" --query "arguments about dishes" --output "out/stringout_$A.aaf" > /dev/null
done
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$REPO/aaf-sidecar" "$PY" verify_stringout.py out/source_group.aaf out/cuts.json \
  out/stringout_A.aaf out/stringout_B.aaf out/stringout_C.aaf > out/verify.json
echo "verification written to out/verify.json"
