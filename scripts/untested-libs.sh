#!/usr/bin/env bash
#
# List pure modules in src/lib/ that export behaviour but have no sibling
# test file. Empty output is the goal.
#
# "Pure" is the point. Three kinds of module are deliberately NOT reported,
# because a test file for them would be theatre rather than coverage:
#
#   1. Type-only modules — every export is a `type`/`interface`, so there is
#      no runtime behaviour to assert. tsc already checks these.
#   2. Thin invoke wrappers — the module only forwards to `invoke(...)`, so a
#      test could assert nothing except that the mock was called with the
#      arguments the test itself supplied. That is mock theatre.
#   3. Modules with no exports at all (side-effect-only registration).
#
# Anything else exporting a function or const is fair game.
#
# NOTE on grep and exit codes: `grep -c` exits 1 when the count is zero, so
# every count here is taken with `|| true`. A bare `count=$(... | grep -c x)`
# under `set -e` aborts the script precisely when the answer is "none", which
# is the common case. This bit an earlier loop in this repo.

set -uo pipefail
cd "$(dirname "$0")/.."

report=0

for f in src/lib/*.ts; do
  base="$(basename "$f" .ts)"
  case "$base" in
    *.test) continue ;;
  esac

  # Already covered? A sibling .test.ts or .test.tsx counts.
  if [ -f "src/lib/${base}.test.ts" ] || [ -f "src/lib/${base}.test.tsx" ]; then
    continue
  fi

  # Runtime exports: functions, consts, classes, enums. `export type` and
  # `export interface` are excluded by the pattern, as is `export type {`.
  runtime=$(grep -cE '^export (async )?(function|const|class|enum|let) ' "$f" || true)
  if [ "$runtime" -eq 0 ]; then
    continue    # type-only or side-effect-only
  fi

  # Thin invoke wrapper: every runtime export is a one-liner forwarding to
  # invoke(). Heuristic — if the file imports invoke and has no branching or
  # arithmetic of its own, there is nothing to assert that is not the mock.
  invokes=$(grep -cE '\binvoke[<(]' "$f" || true)
  logic=$(grep -cE '\b(if|for|while|switch|\?\?|\|\||&&|\.map\(|\.filter\(|\.reduce\(|Math\.)' "$f" || true)
  if [ "$invokes" -gt 0 ] && [ "$logic" -lt 3 ]; then
    continue
  fi

  echo "$f  (${runtime} runtime exports)"
  report=$((report + 1))
done

# The script's own canary: if the loop above stops matching files at all, the
# empty output would read as "fully covered" rather than "scan broke".
total=$(ls src/lib/*.ts 2>/dev/null | grep -vc '\.test\.ts$' || true)
if [ "$total" -lt 20 ]; then
  echo "untested-libs.sh: only found $total modules in src/lib — the scan is broken" >&2
  exit 2
fi

exit 0
