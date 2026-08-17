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

  # Deliberate skips, each with its reason. NOT a convenience list — anything
  # here was read first and judged untestable without a harness bigger and less
  # trustworthy than the code it tests. Every claim below was checked, and two
  # candidates that LOOKED like they belonged here (mediabunny-source,
  # mediabunny-audio) turned out to contain real testable logic and were
  # covered instead. Adding a line here needs the same standard: read it, and
  # say what a test would have to fake.
  case "$base" in
    asset-url)
      # One line: `return convertFileSrc(path)`. No branch, no arithmetic. A
      # test could only assert that the Tauri function was called with the
      # argument the test just passed. The invariant that MATTERS here is the
      # asset-protocol scope, and asset-scope-contract.test.ts already guards
      # it.
      continue ;;
    mediabunny-decoders)
      # Registers a WASM Opus decoder and the ProRes decoder into mediabunny's
      # global registry. Faking it means faking registerDecoder, OpusDecoder
      # and WebCodecs — at which point the test asserts the fakes ran. The
      # capability GATE in front of it (platform-capabilities) is tested, and
      # its blobWorker/wasm answers are what decide whether this runs at all.
      continue ;;
    mediabunny-export)
      # A full demux → encode → mux pipeline (Input/Output/Conversion). A test
      # needs a real container in and a real encoder out; anything less is
      # asserting a stub. Covered end to end by the export hand-tests, and its
      # caller's decision logic lives in use-clip-export, which IS tested.
      continue ;;
    mediabunny-helpers)
      # Frame grabs, posters and filmstrips: every export needs a real decoder
      # and a canvas with real pixels. `canvasLooksBlank` is the one pure
      # function in here and is worth a test the day jsdom gets a canvas with
      # getImageData; today that means shipping the `canvas` native module for
      # one assertion.
      continue ;;
    motion)
      # `window.matchMedia("(prefers-reduced-motion: reduce)").matches` at
      # module scope, one ternary. The behaviour that matters — that reduced
      # motion is honoured across the app — is covered where it is observable,
      # in reduced-motion-contract.test.ts and the e2e reduced-motion spec.
      continue ;;
  esac

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

# ── The script's own canaries ────────────────────────────────────────────────
# Empty output is the goal, which makes every way of being wrongly empty a
# hazard. Two of them are checked here.

# 1. The scan still finds files. If the glob or the loop breaks, silence would
#    read as "fully covered" rather than "measured nothing".
total=$(ls src/lib/*.ts 2>/dev/null | grep -vc '\.test\.ts$' || true)
if [ "$total" -lt 20 ]; then
  echo "untested-libs.sh: only found $total modules in src/lib — the scan is broken" >&2
  exit 2
fi

# 2. Every documented skip still names a module that EXISTS. A skip for a
#    deleted file is dead weight that quietly grants cover to the next module
#    someone names the same thing.
stale=0
for skipped in asset-url mediabunny-decoders mediabunny-export mediabunny-helpers motion; do
  if [ ! -f "src/lib/${skipped}.ts" ]; then
    echo "untested-libs.sh: skip list names src/lib/${skipped}.ts, which no longer exists" >&2
    stale=1
  fi
done
[ "$stale" -eq 0 ] || exit 2

exit 0
