# Claude Code prompt pack — App shell, Library ("local streaming platform"), stateful buttons

Run these in order, one per Claude Code session, committing between phases.
Each prompt assumes CLAUDE.md is auto-loaded (it is). Line anchors below were
verified on branch `web-playback-state-machine` on 2026-07-13 — prompts tell
Claude Code to re-verify before editing.

**Design intent (shared context, paste nowhere — this is for us):**
- Home = the Library: a Netflix-style landing over user-added folders (Plex model).
- Clicking the Sauce Bunny logo always returns Home.
- The current entire UI becomes the "Clip" view. Screening stays a *mode* of Clip, not a nav destination.
- Nav rail contents (v1): Logo→Home, Home/Library (⌘1), Clip (⌘2), spacer, Settings gear (opens existing modal). Search lives inside the Library header, not the rail.
- Stateful morph buttons: Fetch URL, Export clip. GenerateButton (transcription) gains success/error resolution states instead of being replaced.

---

## Prompt 1 — App shell: nav rail, view switching, logo home button

```
We're restructuring the app shell. Today App.tsx renders one layout (toolbar +
sidebar + monitor + drawer). That entire existing layout becomes the "Clip"
view, and we're adding a second top-level view, "Home" (a Library — built in a
later phase; stub it for now), plus a persistent left navigation rail.

Read first: src/App.tsx (the render tree at the bottom, around the cp-body
div near line ~4145 — re-verify all line numbers, the file moves), src/main.tsx,
src/components/Toolbar.tsx, src/styles/shell.css, src/styles/tokens.css,
src/styles/screening.css, src/hooks/use-co-review.ts.

Requirements:

1. View state, not a router. Add `type AppView = "home" | "clip"` and a single
   `activeView` useState in App.tsx, persisted to localStorage key
   `saucebunny.activeView` (namespace convention). The constitution forbids
   routers — this stays a state switch. The floating panel window
   (?window=panel) is untouched.

2. KEEP THE CLIP VIEW MOUNTED AT ALL TIMES. When activeView is "home", the
   Clip view is hidden with a `hidden` attribute + CSS (same keep-alive pattern
   QueueDrawer uses for its tabs), NOT unmounted. Playback, running export/
   transcript jobs, co-review sessions, and all listeners must survive
   switching views. Audio should keep playing when you browse Home (streaming-
   platform behavior); if that feels wrong later we'll add a pause-on-leave
   preference — do not add one now.

3. NavRail component (new file src/components/NavRail.tsx, sibling CSS section
   in a new src/styles/nav.css imported from index.css alongside the other
   style files). Slim vertical icon rail, fixed to the left edge, full height,
   using tokens (bg-1 background, line-1 hairline right border). Contents top
   to bottom:
   - Sauce Bunny logo button (use src-tauri/icons/128x128.png copied to
     src/assets/ or imported via Vite; alt "Home"). Clicking it sets
     activeView "home". Subtle hover scale (respect prefers-reduced-motion).
   - Home item (house icon, add to src/components/Icons.tsx following its
     existing style) — activeView "home", shortcut ⌘1.
   - Clip item (scissors/film icon) — activeView "clip", shortcut ⌘2.
   - flexible spacer
   - Settings gear — calls the existing onOpenSettings (moves here FROM the
     toolbar; remove the toolbar's settings button and its prop if no longer
     used there).
   Active item gets a filled background (bg-3) + accent left edge
   (--ella-green). Every item: aria-label, title with shortcut, focus-visible
   ring. Class prefix cp-nav-*.

4. Keyboard: register ⌘1/⌘2 through the existing data-driven keybinding system
   (src/lib/keybindings.ts KEY_ACTIONS + the runAction switch in App.tsx +
   src/lib/commands.ts buildCommands so they appear in the ⌘K palette and
   Settings→Shortcuts). Do not add a raw keydown listener.

5. Screening mode: when `screening` is true (see use-co-review.ts and the
   cp-screening class on cp-body), the nav rail hides completely (CSS, same
   reflow spirit as the existing screening treatment — the player must not
   remount). Leaving screening restores it.

6. Home stub: new file src/components/LibraryView.tsx rendering an empty-state
   panel ("Your library" headline + "Add a folder" button that is disabled
   with title "Coming in the next build") using tokens. It will be replaced in
   phase 3.

7. Layout: cp-body becomes a flex row of [NavRail | view container]. The
   toolbar remains part of the CLIP view only (Home gets its own header in
   phase 3). Verify the traffic-light/titlebar overlay (titleBarStyle Overlay)
   still clears the rail — check padding in shell.css.

Constraints: no new dependencies. No Tailwind, no CSS-in-JS, no inline styles.
cp- class prefix, tokens for every color/space. One component per file. Do not
touch use-co-review.ts logic. No Rust changes (frontend-only phase — build ID
stays).

Verify: npx tsc --noEmit && npm test, then npm run test:e2e (fix the smoke
spec if the new rail changes boot assertions), then npm run tauri dev — click
between Home and Clip while a video is playing and confirm playback never
stops, jobs keep reporting progress, screening mode hides the rail, and ⌘1/⌘2
appear in the command palette.
```

---

## Prompt 2 — Rust backend: library folder scanning

```
We're building a Library view (Netflix-style browser over user-added local
folders). This phase is backend only: the scan commands. Frontend persists the
list of root folders in localStorage (saucebunny.libraryRoots) and passes
paths in — Rust owns no root-list state.

Read first: src-tauri/src/commands/mod.rs (helpers + registration pattern),
src-tauri/src/commands/media.rs (probe_local_file, generate_local_thumbnail —
we reuse both), src-tauri/src/error.rs, src-tauri/src/lib.rs (command
registry), src/lib/import-extensions.ts (the accepted media extensions — the
Rust scan must match this list exactly; duplicate the list in Rust with a
comment cross-referencing the TS file), CLAUDE.md sections on ts-rs bindings
and the build-ID handshake.

Add a new file src-tauri/src/commands/library.rs with:

1. `scan_library_folder(path: String, max_depth: u32) -> Result<LibraryFolder, AppError>`
   - Validates path exists and is a directory (AppError::not_found /
     AppError::invalid).
   - Walks recursively to max_depth (frontend will pass 3). Skips hidden
     entries (dot-prefixed), symlinks, and package-like bundles (.app).
   - Returns a tree: LibraryFolder { name, path, folders: Vec<LibraryFolder>,
     items: Vec<LibraryItem> }, LibraryItem { name, path, size_bytes, modified_ms,
     kind: "video" | "audio" } — kind decided by extension against the list
     mirrored from import-extensions.ts.
   - Both structs derive serde + ts_rs::TS with #[ts(export, export_to =
     "../../src/bindings/")] like the existing cross-boundary structs.
   - Sort folders and items by name, case-insensitive.
   - This is a fast metadata walk: DO NOT probe duration or spawn ffmpeg here.
     Duration/thumbnails are fetched lazily per-visible-card by the frontend
     via the existing probe_local_file and generate_local_thumbnail commands.

2. `pick_library_folder() -> Result<Option<String>, AppError>` — native folder
   picker via the existing tauri-plugin-dialog (blocking pick_folder), None on
   cancel. Check how other commands use the dialog plugin first; if the
   frontend can call the dialog plugin directly (it already does for import),
   prefer that and SKIP this command entirely — don't add a command that
   duplicates a plugin capability.

Wire-up: mod declaration in commands/mod.rs, register in lib.rs's
generate_handler list, run `cargo test --lib` from src-tauri/ to emit the new
TS bindings, and bump BACKEND_BUILD_ID in src-tauri/src/commands/system.rs
AND src/lib/build-id.ts (same new string — this is the handshake).

Add Rust unit tests in library.rs: extension classification, hidden-entry
skipping, depth limiting (build a temp dir tree with std::fs in the test).

Errors: Result<T, AppError> only — no Result<T, String> (that migration is
done; don't regress it).

Verify: cargo check && cargo test --lib from src-tauri/, confirm
src/bindings/LibraryFolder.ts and LibraryItem.ts exist, npx tsc --noEmit still
passes, and the app boots (npm run tauri dev) with no build-ID banner.
```

---

## Prompt 3 — Library UI: the streaming-platform home

```
Replace the LibraryView stub with the real Library — a dark, cinematic,
Netflix-style home over user-added folders. This is the app's Home view
(phase 1 shell) backed by scan_library_folder (phase 2).

Read first: src/components/LibraryView.tsx (stub), src/bindings/LibraryFolder.ts,
src/bindings/LibraryItem.ts, src/lib/recent-sources.ts, src/lib/transcript-history.ts,
src/lib/mediabunny-helpers.ts (extractFrameAsBlob), src/components/RecentSources.tsx,
src/styles/tokens.css, src/styles/monitor.css (for the app's existing card/
overlay aesthetic), src/lib/storage.ts, src/lib/validation.ts
(youTubeThumbnailUrl for web-source cards).

Structure (sibling components, each its own file):
- LibraryView.tsx — orchestrator. Owns roots (localStorage
  saucebunny.libraryRoots via lib/storage.ts helpers), scan results, loading/
  error state per root, and the search query. Scans all roots on mount and on
  root add/remove; rescan button in the header. Sequential scans, not
  Promise.all over many roots at once.
- LibraryHero.tsx — full-width hero for the most recent entry in
  recentSources: thumbnail as blurred/darkened backdrop (gradient overlay from
  bg-0, like Netflix), title, host/date line, and two buttons: "Resume"
  (primary, green accent) and "Open in Clip". Both call an onOpen(source)
  callback. If no recents: an inviting empty hero with "Add a folder" +
  "Paste a URL" (the latter switches to Clip view and focuses the URL field).
- LibraryRow.tsx — one horizontal scroll row: title, count, edge-fade mask,
  horizontal scroll (native touch/trackpad) + left/right arrow buttons that
  appear on row hover and scrollBy one viewport. scroll-smooth honoring
  prefers-reduced-motion.
- LibraryCard.tsx — 16:9 poster card. Lazy thumbnail: IntersectionObserver;
  when visible, request via invoke("generate_local_thumbnail") (falls back to
  a tokens-styled placeholder with the filename). Hover: scale ~1.04 +
  elevated shadow + reveal a play glyph and the file's size/date line (CSS
  transition, ~180ms, reduced-motion aware). Click → onOpen(item).
- LibraryFolderCard.tsx — a collection card for subfolders (stacked-poster
  look using up to 3 item thumbnails, folder name, item count). Click drills
  in: LibraryView pushes a breadcrumb ("Library / Footage / Interviews") and
  shows that folder's rows. Breadcrumb segments are buttons; logo/Home always
  returns to the top level.

Rows on the top level, in order:
1. "Continue" — recentSources entries (both web URLs and local files; web
   cards use youTubeThumbnailUrl). Opening one switches to Clip view and
   routes through the EXACT same handlers the URL bar / recents popover uses
   (App passes down onOpenRecentSource — no parallel load path).
2. One row per root folder (row title = folder name, with a remove-root "×"
   affordance in the row header behind a hover reveal; confirm before remove;
   removal only forgets the root, never touches disk).
3. "Transcripts" — transcript-history entries; opening one loads its source
   through the existing history handler.

Header: "Library" title, search input (filters items and folders across all
roots, client-side, case-insensitive, debounced 150ms), Add Folder button
(dialog plugin folder picker), rescan. Search results render as a flat grid
replacing rows while the query is non-empty; Esc clears.

Wiring in App.tsx: LibraryView receives props: onOpenLocalPath (routes to the
same loadLocalPath flow as drag-drop/import), onOpenRecentSource,
onOpenTranscriptHistory, onSwitchToClip. Opening any item sets activeView to
"clip". Keep App's additions minimal — the Library owns its own state; do NOT
lift scan state into App.

Styling: new src/styles/library.css imported like the other section files.
cp-lib-* classes, tokens only (bg-0 page, bg-2 cards, line-1 hairlines,
fg-1/fg-3 text, --ella-green accent). Match the app's existing radius/spacing
tokens. It should read as the same product as the Clip view — dark, quiet,
Nunito Sans — not a different site. Scrollbars hidden on rows but keyboard
accessible: cards are buttons, rows are role="list", arrow keys move focus
within a row (roving tabindex).

Performance guards: thumbnails only on intersection; cap concurrent thumbnail
invokes at 3 with a tiny queue inside LibraryView (module-scope Map cache
path→objectURL, revoke on eviction; keep it simple); duration probing is OUT
of scope for v1 (size + date is enough on cards).

No new dependencies. No timers as sync mechanisms — scan on mount/action only.
Fail loud: a root that fails to scan shows an inline error row with the
AppError message via formatError, not a silent skip.

Verify: npx tsc --noEmit && npm test && npm run test:e2e, then npm run tauri
dev: add a folder with nested subfolders of mixed video/audio, confirm lazy
thumbs, drill-in breadcrumbs, search, remove-root, hero resume → Clip view
loads and plays, and switching Home↔Clip mid-playback never interrupts audio.
```

---

## Prompt 4 — Stateful action buttons (idle → spinner → ✓/✕ morph)

```
Add an animated stateful-button treatment to the app's three big async
actions: Fetch URL (toolbar), Export clip (sidebar), and Generate transcript.
The inspiration is the framer-motion "StatefulButton" pattern (label slides
up/out, spinner in, then check/cross morphs in) — but this codebase forbids
framer-motion, Tailwind, react-icons, and shadcn. Rebuild the pattern with
hand-rolled CSS transitions/keyframes and our tokens.

Read first: src/components/GenerateButton.tsx and its cp-gen-* styles in
src/styles/buttons.css (the house style for premium buttons — match its
quality bar), src/components/Toolbar.tsx (fetch button + status prop),
src/components/Sidebar.tsx (export button and its busy/progress wiring),
src/components/Icons.tsx, src/lib/motion.ts (reduced-motion helper),
src/styles/tokens.css (--success, --warning, --danger if present — check).

1. New component src/components/StatefulButton.tsx:
   - Props: phase: "idle" | "loading" | "success" | "error"; idleContent
     (ReactNode); loadingLabel?; onClick; disabled?; title?; className?;
     resolveMs? (default 1600).
   - PARENT owns the phase (App already knows when a fetch/export starts,
     succeeds, fails — wire to real state, no internal fake timers for the
     async part). The ONLY internal timer: after entering success/error the
     component calls an onResolved callback after resolveMs so the parent can
     return phase to idle; skip the animation entirely under
     prefers-reduced-motion (instant swap, still call onResolved).
   - Markup: a fixed-size button (width locked via CSS min-width per usage,
     not JS measurement) containing three stacked layers (idle label /
     spinner / result icon), cross-faded + translateY(±10px) via CSS
     transitions keyed on a data-phase attribute. Spinner: a stroked SVG arc
     with a CSS rotate keyframe. Success: circle-check SVG whose path draws in
     via stroke-dashoffset transition. Error: circle-x, same technique, using
     the app's danger/red token (check tokens.css for the existing red; do not
     hardcode hex). Add the three SVGs to Icons.tsx following its conventions.
   - a11y: aria-busy while loading, aria-live="polite" visually-hidden status
     text ("Loading", "Done", "Failed"), disabled during loading.
   - Styles: cp-sbtn-* block in styles/buttons.css. No inline styles except
     the existing progress-width pattern if needed.

2. Wire it up:
   - Toolbar Fetch: phase derives from status ("fetching" → loading) plus a
     short success flash when metadata hydrates and error on fetch failure.
     Toolbar is presentational — App passes a fetchPhase prop down. Keep the
     button's current dimensions so the toolbar doesn't reflow.
   - Sidebar Export (web + local single export): loading while the export job
     runs (existing busy/progress state), success on clip-done success, error
     on failure/cancel(→ error only on failure; cancel returns straight to
     idle). If the button currently shows progress percent, keep the percent
     INSIDE the loading layer next to the spinner.
   - GenerateButton (transcription): do NOT replace it — extend it. Add an
     optional resolution prop ("success" | "error" | null): on success the
     sparkle/label crossfades to a drawn check + "Done", on error to the cross
     + a short label, auto-reverting via the same onResolved pattern. Reuse
     the exact SVG icons and dash-draw CSS from StatefulButton (shared
     keyframes in buttons.css, not duplicated).

3. Do not attach this to any other buttons in this pass (queue rows, copy
   buttons, settings saves are out of scope).

No new dependencies. Respect prefers-reduced-motion everywhere (lib/motion.ts
and the existing CSS pattern GenerateButton uses). Keep each new file under
~150 lines; split sibling pieces if needed.

Verify: npx tsc --noEmit && npm test && npm run test:e2e, then npm run tauri
dev: paste a good URL (fetch → spinner → check → idle), paste a garbage URL
(→ cross), export a short clip (spinner+percent → check), cancel an export
(→ straight back to idle), run a transcript to completion (GenerateButton
resolves with the drawn check), and toggle macOS Reduce Motion to confirm
instant swaps.
```

---

## Suggested commit points
1. `ui: app shell — nav rail, home/clip views, logo home button`
2. `library: folder scan commands (LibraryFolder/LibraryItem bindings)`
3. `library: netflix-style home — hero, rows, lazy thumbs, search`
4. `ui: stateful morph buttons for fetch/export + GenerateButton resolution`
