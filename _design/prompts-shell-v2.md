# Claude Code prompt pack v2 — nav rail polish, co-review home, thumbnails, real Library, ambience

Follow-ups to `prompts-app-shell-library.md` after the first feature train landed
(`6fdeff7`…`2b94c0b`). Run in order, commit between. Anchors verified 2026-07-14
on `web-playback-state-machine`; prompts re-verify before editing.

Design decisions encoded here:
- Logo becomes a **brand mark, not a button** (the rail's Home item is the one home affordance).
- Rail items get **tiny labels under the icons** (tvOS/Plex style) — the rail widens slightly.
- **Screening never fully removes the rail**: it becomes an auto-hidden overlay revealed at the left edge.
- **Co-Review becomes a nav destination** with a bespoke lobby; live sessions badge the rail item.
- **Home stays the hero+shelves landing; a NEW "Library" view is the Plex-style detail browser.**
- Thumbnails get representative-frame selection + user-chosen poster via context menu.

---

## Prompt 1 — Nav rail v2: labels, brand mark, screening overlay

```
Three refinements to the app-shell nav rail (src/components/NavRail.tsx,
src/styles/nav.css, src/styles/screening.css). Re-verify current code first.

1. Logo = brand mark, not a second Home button. The rail currently has a
   clickable logo AND a Home item — two home affordances stacked. Change the
   logo to a non-interactive brand mark: replace the <button class="cp-nav-logo">
   with a plain <div> (img keeps alt="Sauce Bunny", add aria-hidden on the
   wrapper, no title, default cursor, no hover effect). The Home nav item and
   its ⌘1 binding are unchanged and become the only home affordance. Remove
   any now-dead logo-click styles.

2. Labels under icons. Each cp-nav-item gains a text label under its icon:
   Home, Clip, Settings (and Co-Review/Library when later prompts add them).
   Tiny type — 9px, font-weight 600, letter-spacing 0.02em, fg-4 default,
   fg-1 when active. Widen the rail to fit (~64–72px; pick what keeps labels
   un-truncated) and re-check the titlebar overlay padding in shell.css since
   the traffic lights sit near this region. Keep the icon+label centered
   stack; tooltips still carry the live shortcut combos. aria-labels now
   duplicate visible text — keep them consistent.

3. Screening: overlay auto-hide instead of display:none. Today
   `.cp-screening .cp-nav { display: none; }` deletes the app's primary nav
   during screening — unacceptable now that the rail IS the main nav. Replace
   with: during screening the rail becomes position:fixed overlay on the left,
   translated off-screen (translateX(-100%)), with a ~16px invisible hover
   hot-zone fixed to the left edge. Pointer entering the hot-zone (or keyboard
   focus landing on any rail item — :focus-within) slides the rail in over the
   video (transition ~200ms, reduced-motion → instant); leaving both rail and
   hot-zone slides it out. While revealed it overlays the screening layout —
   the body must NOT reflow and the player must NOT remount (same constraint
   as the existing cp-screening treatment; verify by toggling during
   playback). Implement with CSS (a wrapper div for the hot-zone in App.tsx is
   fine); no timers, no JS mouse tracking beyond CSS hover/focus.

Constraints: tokens only, cp-nav-* classes, no new deps, frontend-only (no
build-ID bump). Update e2e smoke assertions if they reference the logo button.

Verify: npx tsc --noEmit && npm test && npm run test:e2e; npm run tauri dev —
confirm one home affordance, labels render at both rail states, and in
screening mode the rail is gone until you push the pointer to the left edge,
then overlays without pausing or remounting the player.
```

---

## Prompt 2 — Co-Review as a first-class destination

```
Co-review today is a toolbar popover (CoReviewPopover) inside the Clip view.
Make it a first-class nav destination with a bespoke lobby, while the live
session experience stays in the Clip view.

Read first: src/hooks/use-co-review.ts, src/components/CoReviewPopover.tsx,
src/components/CoReviewJoinForm.tsx, src/App.tsx (AppView type, activeView
switch, the view container render), src/components/NavRail.tsx,
src/bindings/SessionState.ts, src/components/ReviewPanel.tsx (session
awareness), src/lib/tab-state.ts (drawer tab ids).

1. Extend AppView with "coreview". Nav rail gains a Co-Review item (icon: two
   overlapping chat/people bubbles — add to Icons.tsx in house style; label
   "Review" under the icon per the rail's new label pattern), between Clip and
   the spacer, with a ⌘3 binding registered through keybindings.ts +
   commands.ts like Home/Clip.

2. Session-state badge on the rail item: when coSession.role is host or peer,
   render a small live dot (--ella-green, subtle 2s pulse, reduced-motion →
   static) on the Co-Review icon, title includes peer count. Data flows down
   from App (it already owns coSession via use-co-review).

3. New src/components/CoReviewLobby.tsx — the "coreview" view body (kept
   mounted+hidden like the other views). Bespoke, calm layout, two columns on
   wide windows:
   - Host card: session name field (prefilled from saved reviewer identity in
     lib/review loadReviewer), a Start Session button (reuse the StatefulButton
     pattern if it fits, else house button styles), and once hosting: the join
     code with a copy button (existing clipboard plugin pattern), the live
     roster (names + avatar colors via review.ts avatarColor/initialsOf), and
     an End Session button.
   - Join card: the existing join flow (reuse/absorb CoReviewJoinForm — code +
     name), connecting state, error surface via formatError.
   - Below: a short "how it works" line (media never leaves your machine;
     everyone streams their own copy — mirror the language in ARCHITECTURE.md)
     and the current source's eligibility: co-review is web-source-only, so if
     the loaded source is a local file, say so plainly and disable hosting
     (same rule the popover enforces today — reuse that logic, don't fork it).
   All of this calls the SAME handlers use-co-review exposes (startCoReview,
   joinCoReview, leaveCoReview) — no parallel session logic.

4. Flow: starting or joining a session from the lobby auto-switches
   activeView to "clip" (the session lives there: player + review drawer +
   screening). While a session is active, the lobby shows the roster +
   End/Leave controls instead of the start/join cards, so the nav item is
   always a sensible place to return to. Ending the session returns you to
   the lobby only if you're currently viewing it.

5. The toolbar CoReviewPopover: keep the toolbar affordance but reduce it to
   a session status chip (live dot + peer count when active) that, when
   clicked, navigates to the coreview view instead of opening the old popover.
   Delete the popover component if nothing else uses it; keep
   CoReviewJoinForm if the lobby absorbs it wholesale.

Constraints: no session logic changes in use-co-review.ts or session.rs — this
is UI relocation only. Keep components under ~150 lines by splitting sibling
cards (CoReviewHostCard.tsx / CoReviewJoinCard.tsx) if needed. New styles in
review.css or a new coreview.css imported like siblings; cp-corev-* prefix.
Frontend-only; no build-ID bump.

Verify: tsc/vitest/e2e (update the smoke test that opens the old popover —
it should now assert the lobby renders), then npm run tauri dev with two app
instances: host from the lobby, join from the second instance, confirm
auto-switch to Clip, rail badges on both, End Session returns to lobby, local
file loaded → hosting disabled with the explanation.
```

---

## Prompt 3 — Thumbnail intelligence: representative frames + choose-your-own

```
Library thumbnails are broken for dark openings: generate_local_thumbnail
(src-tauri/src/commands/media.rs) seeks to duration*0.10 clamped to 5s ONLY
when duration_seconds is passed, else 0.0 — and the Library never passes
duration, so files like Mr.mp4 whose first frame is black get a black poster.
Fix the default and add user-chosen posters.

Backend (media.rs — re-verify the function first):
1. When duration_seconds is absent, probe it: reuse the existing ffmpeg
   duration parsing that probe_local_file uses (extract a shared helper if
   it's inline there — same file, no new module). Then apply the same 10%
   clamp. If probing fails, fall back to seeking 3.0s with -ss before -i; if
   THAT yields no frame (very short file), retry at 0.
2. Representative-frame selection: after the seek, use ffmpeg's thumbnail
   filter — `-vf thumbnail=90,scale=...` (keep the existing scale) with
   `-frames:v 1`. The thumbnail filter picks the most representative frame
   from the next ~90, which skips black/flash frames without any hand-rolled
   luma math. Verify the exact filter args against the bundled ffmpeg build.
3. New optional arg time_seconds: Option<f64> on LocalThumbnailArgs — an
   explicit user-chosen poster time. When present it wins over all heuristics
   (exact -ss, no thumbnail filter) and MUST be part of the cache key hash
   (today the key is path+mtime; add the requested time, else a chosen poster
   can never replace the heuristic one). Regenerate ts-rs bindings
   (cargo test --lib) and bump BACKEND_BUILD_ID in both places (system.rs +
   src/lib/build-id.ts).
4. Rust unit test for the arg→cache-key behavior if the hashing is extracted
   into a testable fn.

Frontend:
5. Per-path chosen poster times persist in localStorage
   saucebunny.libraryThumbTimes (Record<string, number>) via lib/storage.ts.
   LibraryView's requestThumb loader reads it and passes time_seconds; the
   module cache key must include the chosen time too.
6. Context menu on LibraryCard: onContextMenu (right-click) opens a small
   in-app menu (positioned popover, house style — check how RenamePopover
   portals + anchors and follow that pattern): items "Choose thumbnail…",
   "Reset thumbnail", "Reveal in Finder" (existing reveal_in_finder), "Open in
   Clip". Menu closes on Esc/outside click; focus returns to the card.
7. "Choose thumbnail…" opens a modal (new component ThumbnailPicker.tsx):
   a preview canvas + a simple time slider over the file's duration, decoding
   the frame under the slider via mediabunny (extractFrameAsBlob from
   lib/mediabunny-helpers.ts — latest-wins coalescing via createScrubPump from
   lib/scrub-pump.ts so dragging doesn't queue decodes). Confirm saves the
   time to libraryThumbTimes, invalidates that path's entry in the thumb
   cache, and re-requests. Cancel changes nothing. Modal uses use-modal-focus
   like the other dialogs. If mediabunny can't decode the file
   (canMediabunnyDecode false), fall back to three preset offers (10% / 33% /
   66%) rendered via the Rust command with explicit time_seconds.
8. "Reset thumbnail" deletes the stored time and re-requests the heuristic
   poster.

Constraints: no new deps; AppError only; context menu + modal get cp-lib-*
classes in library.css; keep ThumbnailPicker under ~150 lines (split a
ThumbnailPickerSlider sibling if needed).

Verify: cargo check && cargo test --lib (bindings regenerate), tsc/vitest/e2e,
then npm run tauri dev: Mr.mp4 gets a real (non-black) poster with no stored
override; right-click → choose a frame → poster updates immediately and
survives app restart + rescan; reset returns to the heuristic frame; no
build-ID banner.
```

---

## Prompt 4 — The real Library: Plex-style detail browser

```
Home (hero + shelves) is a landing page, not a library. Add a NEW top-level
"Library" view — a Plex/Finder-hybrid detail browser over the same scanned
roots — while Home stays as-is.

Read first: src/components/LibraryView.tsx (the scan orchestration, roots
persistence, requestThumb loader — REUSE these, do not duplicate scanning),
src/components/LibraryCard.tsx, src/bindings/LibraryFolder.ts, src/App.tsx
(AppView), src/components/NavRail.tsx, src/styles/library.css.

First, a small refactor: extract LibraryView's roots/scan/thumbnail-loader
state into a hook src/hooks/use-library-scan.ts (this satisfies the
constitution's 3+ consumer rule the moment both views use it; the hook owns
roots, scan results, rescan, requestThumb with its concurrency cap + cache).
Home's LibraryView and the new browser both consume it. Scans stay
one-at-a-time; results are shared so switching views never rescans.

New view (AppView "library", nav item between Home and Clip, label "Library",
⌘-binding following the established pattern — this shifts Clip to ⌘3 and
Co-Review to ⌘4 if prompt 2 landed; renumber consistently in keybindings +
commands and let the palette/tooltips pick it up):

Layout — three regions, Plex grammar:
1. Left column (~200px, collapsible): the folder tree. Roots as top-level
   entries with disclosure triangles revealing subfolders (from the already-
   scanned LibraryFolder tree — no extra IPC). Selection drives the main pane.
   An "All" entry at top aggregates every root. Add Folder + rescan live at
   the bottom of this column. Keyboard: ↑↓ moves, ←→ collapses/expands,
   Enter selects (standard tree widget semantics, role="tree").
2. Main pane: header row with breadcrumb (root / sub / subsub — segments
   clickable), search field (client-side, scoped to current selection),
   sort select (Name / Date modified / Size, asc-desc toggle), kind filter
   (All / Video / Audio), and a grid⇄list view toggle (persist all of these in
   one localStorage key saucebunny.libraryBrowser via lib/storage.ts).
   - Grid mode: responsive poster wall reusing LibraryCard (smaller cell
     min-width than Home's shelves; CSS grid auto-fill). Lazy thumbs via the
     shared loader.
   - List mode: a table — tiny poster, name, kind, size, modified. Rows are
     buttons; same right-click context menu as the cards (prompt 3).
3. Detail panel (right, ~280px, appears on selection): large poster, name,
   path (shortenPath from lib/filename.ts), size/date, and actions: Open in
   Clip (primary), Reveal in Finder, Choose thumbnail…, plus a "Has
   transcript" chip when lib/transcript-history findForSource matches the
   path (clicking it opens the source and the transcript through the existing
   history handler). Esc or clicking empty space clears selection.

Selection model: single-select (no marquee/multi in v1). Double-click or
Enter opens in Clip; single click selects + shows detail.

Wiring: Home's shelf drill-in ("open folder") should now navigate to the
Library view with that folder selected (replace the breadcrumb-in-Home
drill-in if one exists — one detail browser, not two). All open actions route
through the same handlers Home uses.

Constraints: reuse LibraryCard/thumbnail infra; new sibling components
(LibraryBrowser.tsx, LibraryTree.tsx, LibraryListRow.tsx, LibraryDetail.tsx)
each under ~150 lines; styles appended to library.css with cp-lib-* prefix;
tokens only; no new deps; frontend-only (no Rust changes — the scan tree
already carries everything needed).

Verify: tsc/vitest/e2e, then npm run tauri dev: tree reflects nested roots,
grid⇄list persists across restart, sort/filter/search compose correctly,
detail panel actions all work, Home shelves still render and drill into the
browser, and switching Home↔Library↔Clip never rescans or interrupts playback.
```

---

## Prompt 5 — Ambient backdrop + shelf-scroll fix

```
Two polish items on Home.

PART A — fix shelf scrolling (bug): the Transcripts shelf (and possibly all
shelves) won't scroll. Diagnose in src/components/LibraryRow.tsx +
src/styles/library.css: likely suspects — .cp-lib-track missing
overflow-x:auto (or a parent forcing overflow hidden), the initial measure()
running before layout so canLeft/canRight stay false and the arrows never
mount, or the track not actually exceeding clientWidth because cells shrink
(missing flex-shrink:0 / min-width on .cp-lib-cell). Fix the real cause;
then: arrows should also appear on :focus-within (not just hover), and add a
one-frame requestAnimationFrame re-measure after mount so edge state is
correct before any scroll event. Confirm trackpad horizontal scroll, arrow
paging, and ←/→ roving focus all work on a shelf with 20+ items (temporarily
seed extra transcript-history entries in dev if needed).

PART B — ambient backdrop. Fill Home's negative space with a slow
cross-dissolving montage of the user's own frames, Apple-TV-screensaver
quiet, never loud:
- New component src/components/AmbientBackdrop.tsx rendered behind Home's
  content (position:absolute inset:0, z-index below content, pointer-events
  none, aria-hidden).
- Source images: the thumbnail object-URLs already materialized by the shared
  thumbnail loader/cache (expose a listThumbs(): string[] accessor from the
  loader hook — do NOT trigger new decodes or scans for the backdrop; if
  fewer than 3 thumbs exist, render nothing).
- Mechanics: two stacked full-bleed layers; every ~14s the hidden layer gets
  the next image (shuffled order, no immediate repeats) and cross-fades in
  over ~2.5s (CSS opacity transition; the interval timer is animation, which
  is fine — but clear it on unmount/hidden). Layers are blurred (~24px),
  scaled ~1.1 with a very slow Ken Burns drift (CSS keyframes), and capped at
  low opacity (~0.22) beneath a radial + linear feather to --bg-0 so edges
  dissolve into the page (gradient mask or an overlay gradient — match the
  hero's existing gradient language).
- Discipline: prefers-reduced-motion → single static frame, no dissolve, no
  drift. Pause cycling (clear interval) when document.hidden or the Home view
  itself is hidden (it stays mounted — accept a prop). Text contrast on
  cards/hero must survive: verify fg-3 detail text still reads; raise the
  feather if not.

Constraints: tokens; cp-lib-ambient-* classes in library.css; no new deps; no
canvas — plain <img> layers; frontend-only.

Verify: tsc/vitest/e2e, then npm run tauri dev: shelves scroll every way
(trackpad, arrows, keyboard); backdrop dissolves gently behind Home, pauses
when the window is hidden and when Reduce Motion is on, disappears gracefully
in a fresh library with <3 thumbs.
```

---

## Commit points
1. `ui: nav rail v2 — labels, brand mark, screening overlay reveal`
2. `co-review: first-class lobby view + rail presence badge`
3. `media: representative thumbnails + user-chosen posters`
4. `library: plex-style browser — tree, grid/list, detail panel`
5. `home: ambient backdrop + shelf scroll fixes`
