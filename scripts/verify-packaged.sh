#!/usr/bin/env bash
# Checks that ONLY hold in a packaged build.
#
# `tauri dev` serves with no CSP and loads modules straight off the Vite server,
# so two classes of bug are invisible there and appear only in the .app:
#   * a WASM chunk the shipped CSP refuses to instantiate — r150, which showed
#     up as perfect video with no audio and no error anywhere
#   * a lazily-imported chunk that never got bundled, which throws at the exact
#     moment the user asks for the file
#
# Tauri EMBEDS the frontend in the binary rather than shipping loose files, so
# the asset checks below read the binary. Note what that can and cannot prove:
# `strings` finding a name is proof it shipped, but NOT finding one proves
# nothing (the embedded assets may be compressed). So every "must be absent"
# check runs against dist/ instead, where it is honest.
set -euo pipefail

APP="${1:-src-tauri/target/release/bundle/macos/Sauce Bunny.app}"
[ -d "$APP" ] || { echo "✗ no app bundle at: $APP"; echo "  run: npm run tauri build"; exit 1; }
BIN="$APP/Contents/MacOS/sauce-bunny"
fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=1; }
skip() { printf '  \033[33m–\033[0m %s\n' "$1"; }
# Slurped ONCE, for speed and for correctness. `strings ... | grep -q` under
# `set -o pipefail` returns 141: grep exits on first match, strings takes
# SIGPIPE, and the pipeline reports failure on SUCCESS. That trap has bitten
# this repo before; a variable sidesteps it entirely.
BIN_STRINGS=$(strings "$BIN" 2>/dev/null || true)
has()  { case "$BIN_STRINGS" in *"$1"*) return 0;; *) return 1;; esac; }

echo "Packaged checks — $APP"
echo
echo "In the shipped binary:"

# The lazy MP3 encoder must have been bundled. It loads via `await import()` on
# the first audio-MP3 export, so a chunk that failed to bundle fails at exactly
# the wrong moment.
has 'mediabunny-mp3-encoder' \
  && ok "MP3 encoder chunk shipped" \
  || bad "MP3 encoder chunk MISSING — audio-MP3 export will fail on first use"

# navigator.clipboard.readText() raises macOS's "Paste from clipboard?" modal;
# reading through Rust does not, which is the whole reason this command exists.
has 'read_clipboard_text' \
  && ok "read_clipboard_text present — paste stays modal-free" \
  || bad "read_clipboard_text MISSING — paste will raise the macOS modal"

# Without this the WASM decoders do not fail, they HANG: mediabunny queues work
# behind an init promise that never settles and the feature goes silent.
has 'wasm-unsafe-eval' \
  && ok "CSP permits WebAssembly instantiation" \
  || bad "no wasm-unsafe-eval in the CSP — WASM decoders will hang SILENTLY"

# Ejected in r152. A stale grant for a plugin that is gone should have failed
# the build, but checking the artefact costs nothing.
has 'clipboard-manager:' \
  && bad "clipboard-manager grant survives in the bundle" \
  || ok "no clipboard-manager plugin grants"

echo
echo "In dist/ (where absence is provable):"
entry=$(find dist/assets -name 'index-*.js' 2>/dev/null | head -1 || true)
if [ -z "$entry" ]; then
  skip "no dist/ — run 'npm run build' to check the lazy split"
else
  # Grep for the PAYLOAD, and for a marker that can actually FIRE.
  #
  # Two wrong markers were tried first and both are worth recording.
  # `registerMp3Encoder` is the call site, which correctly lives in the entry
  # chunk, so it false-POSITIVES. `LAME` is inside the compiled WASM and never
  # appears as a literal in either file, so it false-NEGATIVES — a check that
  # always passes is worse than no check.
  #
  # `AGFzbQEAAAA` is base64 for the WASM magic number (\0asm\1\0\0\0), i.e.
  # the first bytes of the inlined module. It is present in the encoder chunk
  # and absent from the entry chunk, which is exactly the invariant.
  if grep -q 'AGFzbQEAAAA' "$entry" 2>/dev/null; then
    bad "MP3 encoder INLINED in the entry chunk — the lazy split regressed"
  else
    ok "entry chunk free of the encoder ($(du -h "$entry" | cut -f1))"
  fi
  # NO PIPELINE. `find ... | grep -q .` is the trap this file's own header
  # warns about, twenty lines up: grep exits on the first match, find takes
  # SIGPIPE, and under `set -o pipefail` the pipeline reports FAILURE on a
  # successful match. Here that inverts the answer in the reassuring
  # direction - it would print "woff2 only" while 30 .woff files ship.
  # Whether it misfires is a race with 30 files to write, which is exactly
  # the kind of check you do not want deciding by timing.
  if [ -n "$(find dist/assets -name '*.woff' -print -quit 2>/dev/null)" ]; then
    skip "legacy .woff fonts still shipping (audit item E2: 432K of woff \
beside 360K of woff2; WKWebView has read woff2 since Safari 10, so the \
legacy copies are never loaded. Not removed: @fontsource ships no \
woff2-only stylesheet, so dropping them means hand-rolling @font-face for \
the app's only typeface, or a Vite plugin - and CLAUDE.md forbids bundler \
config. 432K of a 103MB local bundle, with no per-visit download, does not \
buy that risk.)"
  else
    ok "woff2 only"
  fi
fi

echo
echo "Sidecars:"
for s in yt-dlp ffmpeg ffprobe whisper-cli saucebunny-diarize llama-server; do
  b="$APP/Contents/MacOS/$s"
  [ -x "$b" ] || { bad "missing: $s"; continue; }
  otool -L "$b" 2>/dev/null | grep -qE '/opt/homebrew/|/usr/local/|/Users/' \
    && bad "$s links a non-system dylib — crashes on another Mac" \
    || ok "$s self-contained"
done

echo
[ "$fail" -eq 0 ] || { printf '\033[31m✗ packaged checks failed\033[0m\n'; exit 1; }
printf '\033[32m✓ automated packaged checks passed\033[0m\n'
cat <<'MANUAL'

Two things nothing can automate. Both take under a minute:

  1. PASTE — copy any URL, press the paste button in the toolbar.
     PASS: the URL fills in.
     FAIL: macOS asks to allow clipboard access.
     A prompt means paste regressed to navigator.clipboard.readText().

  2. COLD MP3 EXPORT — relaunch, then export an audio-MP3 clip as the very
     first export of the session.
     PASS: bytes come out.
     FAIL: it hangs or errors — the lazy chunk did not load under the CSP.
     Must be the FIRST export: that is the only run that loads the chunk.
MANUAL
