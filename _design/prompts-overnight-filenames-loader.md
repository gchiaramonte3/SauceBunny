# Claude Code overnight pack — export filenames, new-source reset, bunny loader

Three prompts, run sequentially, unattended. Each ends with the full gate
(npx tsc --noEmit && npm test && npm run test:e2e, plus cargo check &&
cargo test --lib when Rust changes). COMMIT ONLY IF GREEN; if a gate fails
after two fix attempts, write the failure into _design/overnight-notes.md
and move on rather than thrashing.

---

## Prompt 1 — Export filename system: truncate once, unique after, never fail on collision

```
Bug (from field use): exporting queue items from a long YouTube title fails
with "File already exists". Root cause chain to verify and fix:
- src/lib/filename.ts sanitizeFilename caps at 200 CHARS (not bytes);
- src-tauri sanitize_filename (used by create_clip in commands/media.rs ~142
  and download.rs ~548) truncates AGAIN with its own cap, which can chop off
  the queue's "-1"/"-2" uniquing suffix so every queue item collapses to the
  same on-disk name;
- create_clip then HARD-FAILS on an existing file (media.rs ~160) instead of
  uniquing.

Design (single source of truth, applied identically in TS and Rust):
1. One limit, in BYTES: macOS/APFS caps a filename at 255 UTF-8 bytes.
   Define MAX_BASE_BYTES = 180 for the user-visible base name (leaves room
   for uniquing suffixes like "-12", pipeline suffixes, and extensions).
   Add the constant in filename.ts AND as a Rust const, each with a comment
   cross-referencing the other.
2. Truncation is byte-aware and character-safe: truncate the UTF-8 string
   to the byte budget WITHOUT splitting a multi-byte character (Rust:
   char-boundary loop; TS: TextEncoder + back off to a char boundary). For
   SUGGESTED names (seeded from titles), prefer trimming at the last "-"
   boundary within budget so the name ends on a whole word, then strip
   trailing separators. User-typed names truncate exactly at the budget.
3. Uniquing happens LAST, at the final path, in Rust: if <dir>/<base>.<ext>
   exists, try <base>-2, <base>-3, ... (the byte budget already reserved
   room). create_clip NEVER errors on collision; remove the "File already
   exists" error path entirely. The chosen final path flows back in the
   existing done event; verify the frontend notification shows the actual
   name written.
4. Queue export naming: the queue pre-suffixes "-1"/"-2" per item; keep
   that as the SEED name but run it through the same truncate-then-unique
   pipeline, so a chopped suffix can never collide (disk-level uniquing in
   step 3 is the real guarantee).
5. Filename field UX (Sidebar export section):
   - The input keeps the full value; display truncation is visual only
     (CSS ellipsis) with the full name in the title tooltip.
   - Under the field, a live one-line preview of the ACTUAL final name:
     "Saves as <computed>.mp4" (computed via the TS mirror of the
     pipeline; middle-ellipsized for display, full string in its tooltip).
   - Nothing blocks typing; the preview line is how the user sees any
     truncation.
6. Tests, both sides:
   - Rust unit tests: byte-budget truncation on multi-byte input (emoji +
     CJK titles), word-boundary trim, uniquing walks -2/-3 in a tempdir,
     collision never errors.
   - Vitest in filename.test.ts (create if missing): TS/Rust parity cases
     (same inputs, expected same base names, expected strings written
     literally so drift fails the test), char-boundary safety, suffix room.
7. Wiring: changed Rust signatures/structs → ts-rs regen (cargo test
   --lib), bump BACKEND_BUILD_ID in system.rs and src/lib/build-id.ts.

Gate: cargo check && cargo test --lib && npx tsc --noEmit && npm test &&
npm run test:e2e.
Commit: `export: byte-safe filenames, unique-after-truncate, no collision failures`
```

---

## Prompt 2 — New-source reset: loading a URL blows away the previous source

```
Bug (screenshot-verified): load source A (long YouTube title), then paste
source B. The metadata panel updates to B, but the FILENAME field still
shows A's name, and the macOS window title still shows A. Root cause for
the filename: the fetch hydrate in src/App.tsx (~1696-1710) preserves
prev.filename whenever it is non-default, which cannot distinguish "user
typed a custom name" from "seeded from the previous source's title".

1. Filename dirty flag: add state `filenameEdited` that becomes true ONLY
   when the user edits the filename input, and resets to false on every new
   source load (fetch or local). The hydrate rule becomes: if
   !filenameEdited, ALWAYS reseed from the new source's title/URL; if
   filenameEdited, keep the user's name. Delete the old prev.filename
   preservation condition.
2. Centralize source-scoped reset: one function in App.tsx
   (resetForNewSource(kind)) called at the TOP of both handleFetch and
   loadLocalPath, clearing every piece of source-scoped state in one place.
   Audit App.tsx state for what belongs; at minimum: in/out marks, filename
   + filenameEdited, transcript viewer state (loaded transcript, search,
   selection), AI summary/chapters state, snapshot/preview state, export
   selection display, per-source banners/errors, and the undo stack (verify
   it is already cleared on source change per ARCHITECTURE.md). EXPLICITLY
   NOT reset: the export queue and its history (job log spans sources),
   notifications, settings/prefs, review docs (keyed per source; verify
   they swap on their own). Write the kept/cleared lists as a comment block
   on the function and state the invariant: any future source-scoped state
   must be added here.
3. Window title staleness: find where the title is set to
   "Sauce Bunny · <name>" and make it update (or clear) inside
   resetForNewSource, then set to the new source once metadata arrives.
   The title must never show the previous source after a new load.
4. e2e: extend the mocked specs with a two-source sequence: fetch A,
   confirm filename seeds from A; fetch B, assert the filename input shows
   B's seed (not A's); type a custom name, fetch A again, assert the custom
   name SURVIVES (dirty flag). Assert marks cleared between sources.

Gate: npx tsc --noEmit && npm test && npm run test:e2e.
Commit: `app: centralized new-source reset + filename dirty flag`
```

---

## Prompt 3 — Bunny loader: gradient outline draw for every loading screen

```
Replace the circular "line chasing a circle" loading spinners with a
branded bunny-outline loader: the Sauce Bunny mark
(src/assets/saucebunny.svg, three closed paths: two ears + play-triangle
body) drawn as a STROKE animation, a purple-to-green gradient segment
tracing the outline with a soft feathered glow. Loading SCREENS only, not
buttons (StatefulButton/GenerateButton keep their compact spinners).

1. New component src/components/BunnyLoader.tsx:
   - Inline the three paths from saucebunny.svg (embed the path data as
     constants with a comment naming the source of truth; do not fetch at
     runtime). fill="none", stroke only, round caps and joins.
   - Each path gets pathLength="1" so dash math is normalized regardless
     of real path length.
   - Animation (new styles/loader.css imported like the sibling style
     files): a dash segment (~0.30 of each path) cycles via
     stroke-dashoffset keyframes, all three paths in phase so the mark
     reads as one gesture; ~1.6s linear infinite.
   - Gradient: SVG linearGradient from the purple token to the green token
     (SVG gradients cannot read CSS variables; copy the two hex values
     from tokens.css into the gradient stops with a comment naming the
     tokens they mirror, and add a note in tokens.css that these two
     values are mirrored in BunnyLoader).
   - Feather/roll-off: a duplicate path stack underneath with the same
     dash animation, stroke-width ~3x, opacity ~0.25, SVG gaussian blur
     filter (not CSS blur, so it clips correctly). The tail of the chasing
     segment fades via a second overlaid dash ~0.10 long at lower opacity
     trailing the main segment (offset phase) for the comet-tail roll-off.
   - Props: size (px, default 96), label (visually hidden aria text,
     default "Loading"), optional sublabel beneath in fg-4 12px.
     role="status", aria-live="polite".
   - prefers-reduced-motion: no dash animation; the full outline renders
     static at low opacity with at most a gentle 2s opacity pulse.
2. Replace the SCREEN-level spinners (audit first, then swap):
   - Monitor "prep" overlay (cp-prep-spinner, Monitor.tsx ~530) and the
     stream-buffering overlay (cp-stream-spinner) → BunnyLoader size 96,
     keeping their existing text as the sublabel.
   - Library/Home scan-in-progress states, model download overlays,
     transcript generation full-panel waits, and any other full-panel or
     overlay spinner found by grepping cp-spin usages in styles and
     components. Small inline busy indicators (row-level, button-level)
     stay as-is.
   - Delete now-unused spinner CSS blocks (no dead styles).
3. Tests: a vitest DOM test asserting the component renders the three
   paths and the gradient defs; e2e smoke updated if any replaced overlay
   is asserted by selector.
4. Performance note: if the SVG blur underlayer repaints badly on the
   stream-buffering overlay, drop the blur layer on that surface only and
   record it in _design/overnight-notes.md.

Gate: npx tsc --noEmit && npm test && npm run test:e2e.
Commit: `ui: bunny outline loader with gradient trace, replaces circle spinners`
```

---

## Order
1 → 2 → 3. Prompts 1 and 2 both touch App.tsx export state; running 2 after
1 avoids conflicts. Prompt 3 is independent.
