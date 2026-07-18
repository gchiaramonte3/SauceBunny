# Claude Code prompt pack v3 — UI polish pass

Seven prompts. Run in order, commit between. This pass is about design quality,
not features: voice, chrome, familiarity, and finish.

Reference screenshots live in `_design/refs/` — the prompts tell Claude Code to
READ them (it can view images). Current-state screenshots of our own app are in
there too (`Different UI_Top-1/2/3.png`) so it can see what "before" looks like.

**PREAMBLE — paste this block at the top of EVERY prompt below** (each session
is fresh and needs the design contract):

```
DESIGN CONTRACT for this session (in addition to CLAUDE.md):

Voice: product copy is terse and plain. No em dashes anywhere in user-facing
strings, ever. No marketing enumerations ("YouTube, Vimeo, TikTok, Twitter,
etc."). No exclamation points. Sentence case. An empty state is one short line,
centered, plus at most one secondary line or a keycap hint. Model:
_design/refs/Simplistic no verbose centered writing.png (the Lore app).

Color: green (--ella-green) is an accent, not a theme. It marks the primary
action and live states only. Navigation icons, chrome, and secondary buttons
are neutral (fg-3/fg-4 on bg tokens). See the note in
_design/refs/Less green icons.png: our rail currently over-uses green.

Craft bar: aligned optical centers, consistent paddings from tokens, one
hairline weight, no orphaned styles. If a screen looks like a default-styled
form, it is not done. Before finishing, take stock: would this screen look at
home next to Lore (refs above) or Spotify's desktop app? 

Never hardcode colors; tokens only. cp- class prefix. No new dependencies.
Reduced motion respected on every animation. After changes:
npx tsc --noEmit && npm test && npm run test:e2e must pass.
```

---

## Prompt 1 — App-wide copy pass

```
[PREAMBLE]

Audit and rewrite every user-facing string in src/ for the voice contract.
This is a copy-only pass: no layout or behavior changes beyond what the text
swap requires.

Method: grep the codebase for em dashes and en dashes (— and –) in TSX/TS
string literals and eliminate every user-facing one (code comments may keep
them). Then walk the major surfaces and tighten:

1. Clip empty state (Monitor.tsx empty branch): currently a headline plus a
   site list plus a resume chip. Target: "Paste a URL or drop a file." as the
   single line, the resume chip below it reduced to "Resume" + the truncated
   title (drop the words "last session"), and the site list deleted. If a
   keycap hint is useful, style ⌘V as a keycap chip like the Lore ref, not
   prose.
2. URL field placeholder (Toolbar.tsx): currently "paste any video URL —
   youtube, vimeo, tiktok, twitter, reddit, ..." (contains an em dash and an
   enumeration). Replace with "Paste a video URL". The supported-sites detail
   can live in the field's title tooltip if anywhere.
3. Home/Library/Review headers, empty states, buttons, hints, notification
   toasts, settings descriptions, onboarding checklist, co-review footnotes:
   apply the same surgery. Shorten anything over ~8 words that isn't an error
   message. Error messages stay informative but lose filler.
4. The keyboard hint line under the timeline ("Press ⌘/ for keyboard
   shortcuts.") becomes a keycap chip ⌘/ with the word "Shortcuts".
5. Check ARIA labels still make sense after the rewrites (they may be MORE
   verbose than visible text; that is correct, leave them descriptive).

Also grep for "Sauce Bunny" inside UI strings: the product name should almost
never appear inside the app (users know what app they are in). Window title
stays.

Deliverable: the copy changes plus a short list in the commit message of the
surfaces touched. Update e2e assertions that match old strings.
```

---

## Prompt 2 — Clip view chrome: wordmark, panel defaults, icon sizing

```
[PREAMBLE]

Read _design/refs/Remove Sauce bunny text.png (annotated current state) and
_design/refs/Simplistic no verbose centered writing.png (Lore, the model:
logo mark, then the panel-toggle button immediately to its right, no text
wordmark). Also read the current-state shot _design/refs/Different UI_Top-3.png.

1. Remove the "sauce bunny" text wordmark from the Clip toolbar entirely
   (Toolbar.tsx; also delete its gradient CSS). The nav rail's bunny mark is
   the only brand presence. The LEFT PANEL TOGGLE moves to where the wordmark
   was: first item in the toolbar, immediately right of the rail, exactly like
   the Lore ref. The right panel toggle stays on the right edge.
2. Both side panels open by default. The left source/export sidebar and the
   right drawer currently boot closed for a fresh user, which hides what the
   Clip view even is. Change the persisted defaults (check how sidebarOpen and
   queueOpen initialize in App.tsx) so a user with NO saved preference gets
   both open; a user who has toggled them keeps their choice. Verify the
   default window size still gives the monitor a sane aspect with both open;
   if the default width is too tight, widen the default window size in
   tauri.conf.json accordingly.
3. Icon-size bug: in the URL field, the paste icon (inside the field, right
   edge) and the history icon (button next to it) are visibly different sizes;
   the history icon is larger. Normalize both to the same size prop from
   Icons.tsx (match the paste icon's current size) and confirm their hit
   targets stay >= 24px via padding, not icon size.
4. While in Toolbar.tsx: sweep the whole top bar for the color contract.
   Fetch stays the primary (green when armed); Import, panel toggles, bell,
   co-review chip are neutral.

Verify with npm run tauri dev at the default window size: fresh profile
(clear localStorage) boots with both panels open, no wordmark, toggle sits
next to the rail, paste/history icons identical size.
```

---

## Prompt 3 — Mark In/Out: NLE-standard iconography

```
[PREAMBLE]

Our mark in/out buttons do not read as marks to an editor. Every NLE uses
bracket iconography: Mark In is an opening brace/bracket with the bar on the
LEFT (Premiere Pro uses a "{" style glyph, Avid and Resolve use a "[" style
flag), Mark Out is the mirror image with the bar on the RIGHT. Editors'
muscle memory expects these shapes. Do not invent new metaphors.

1. In src/components/Icons.tsx, replace the current mark-in/mark-out icons
   with bracket-pair glyphs drawn in the file's existing stroke style:
   - IconMarkIn: a vertical bar with a short top and bottom arm opening to
     the RIGHT (reads as "[" ), optically weighted to match siblings.
   - IconMarkOut: exact mirror ("]").
   Keep 24px viewBox conventions used by the other icons. The pair must be
   pixel-mirrored, not two freehand drawings.
2. Use them in Transport.tsx (mark in/out buttons) and anywhere else the old
   icons appear (grep the old icon names; check CommandPalette entries and
   the shortcut sheet use the same vocabulary "Mark in"/"Mark out").
3. Timeline (Timeline.tsx): the in/out selection edge handles should echo the
   same language: the in edge renders a small "[" bracket cap and the out
   edge a "]" cap (CSS or tiny inline SVG on the existing handles), so the
   buttons, the marks, and the timeline all speak one dialect.
4. Clear-marks button keeps its position; relabel/title to "Clear in/out" if
   it says anything longer.

Verify: icons mirror perfectly at 1x and 2x, titles carry the I / O
shortcuts, timeline caps show at both marks, and the shortcut sheet (⌘/) rows
still match.
```

---

## Prompt 4 — Home v2: cinematic hero + mixed-size rows + hover frame cycling

```
[PREAMBLE]

Read these refs in order: _design/refs/Home Screen Ref 2.png (the model: an
Apple TV style home; sharp hero still anchored right with a heavy vignette
bleeding left and bottom into the page color; a large landscape featured row;
a smaller row beneath), _design/refs/Home Screen Reference.png (Plex, second
opinion), and our current state _design/refs/Different UI_Top-2.png plus
_design/refs/Library should not be here, this is the home page.png (note the
header confusion and the black thumbnail).

1. Hero rebuild (LibraryHero.tsx): the current hero backdrop is a blurred,
   barely-visible smear. Replace with the ref's grammar: the SHARP poster
   frame of the hero item, anchored to the RIGHT edge of the hero band
   (object-fit cover, right-weighted), with a strong two-axis gradient: from
   bg-0 on the left (fully opaque behind the text block) and from bg-0 at the
   bottom, so the art dissolves into the page. No blur. Eyebrow (small caps,
   fg-3), title, one metadata line, Resume (primary) + Open in Clip
   (neutral). The AmbientBackdrop stays but becomes much subtler beneath the
   rows only, never behind the hero (or remove it from Home if it fights the
   hero; judge by eye and say what you chose).
2. Header cleanup: the Home header currently says "Library"/"Home"
   inconsistently and carries Add Folder + rescan (see the refs). Home's
   header is just the search field, right-aligned. Add Folder and rescan
   belong to the Library view only (they already exist there; delete them
   from Home's header).
3. Mixed-size rows, new names, this order:
   - "Continue": large landscape cards (roughly 2x the current card width,
     like the ref's featured row) built from recentSources. Cap 8.
   - One row per library root folder (folder name as title): standard size.
   - "Transcribed": standard size, from transcript history (rename from
     "Transcripts"; row shows the source poster, SRT badge stays).
   No em dashes, no clever names. Row titles are one word or two.
4. Hover frame cycling on cards (the Game Scoop idea): when a LOCAL video
   card is hovered/focused for 600ms, cross-dissolve its poster through up to
   3 additional frames sampled at 25%/50%/75% of duration, cycling every
   1.2s; leaving hover snaps back to the poster. Implementation constraints:
   decode via the existing thumbnail infrastructure ONLY (extend the module
   cache in use-library-scan.ts with a requestHoverFrames(path) that decodes
   the extra frames lazily, same 3-way concurrency gate, cached like posters,
   evicted with them). Never decode on render, only on hover intent. Skip
   entirely for remote/audio cards and under prefers-reduced-motion. Kill the
   cycle when the card unmounts or the tab hides.
5. The black thumbnail in the refs is the known Mr.mp4 case; verify the
   representative-frame pipeline covers the Continue row (it uses
   recentSources thumbs; route local entries through the same requestThumb
   path the folder rows use, not a separate legacy path, if they diverge).

Verify visually against the ref side by side; then tsc/vitest/e2e.
```

---

## Prompt 5 — Library v2: denser, warmer, Spotify-informed

```
[PREAMBLE]

Read _design/refs/Less green icons.png (Spotify desktop: left library panel
with filter chips, dense tile grid, restrained color) and our current state
_design/refs/Different UI_Top-1.png (flat, sparse, over-green). Do not clone
Spotify; borrow its density and hierarchy.

1. Left column becomes a proper library panel: keep the tree, but give it
   Spotify-style presence: panel header "Library" with the collapse toggle,
   kind filter CHIPS under it (All / Video / Audio) replacing the kind
   <select> in the top bar, and the root folders as rows with small folder
   art (first item's poster) instead of bare disclosure text. Add Folder +
   rescan stay pinned at the panel bottom.
2. Main pane density: tighten the grid (smaller gutter, smaller title type,
   detail line only on hover like Home cards), so a folder of 30 files feels
   like a wall of media, not a sparse table. List view rows get zebra-free
   hairline separation and column headers in fg-4 small caps.
3. Hover frame cycling from Prompt 4 applies to grid cards here too (same
   shared mechanism; do not duplicate it).
4. Color contract sweep: active tree row, chip states, and view toggles are
   neutral (bg-3 fills, fg-1 text); green appears ONLY on the primary Add
   Folder button and live scan progress. The rail's green active treatment
   gets one notch quieter (accent edge stays, drop any green icon fills).
5. Empty library state: one centered line "Add a folder to build your
   library." + the primary button. Nothing else.
6. Detail panel: keep, but align its type scale with the new grid (title,
   metadata line, actions; no key-value table look).

Verify against both refs at 1280px and full-screen widths; tsc/vitest/e2e.
```

---

## Prompt 6 — Review lobby redesign

```
[PREAMBLE]

The co-review lobby (CoReviewLobby.tsx + coreview.css) is the weakest screen
in the app: off-center, form-like, no hierarchy. Redesign it as a calm,
centered "green room". Read _design/refs/Simplistic no verbose centered
writing.png for the voice and centering model.

Layout (idle state):
- A single centered column, max-width ~560px, vertically centered in the
  view with generous top space.
- At top: a quiet header: "Review together" (title) + one line: "Watch the
  same source and comment in sync. Media never leaves each machine." (two
  sentences, no em dash).
- Two cards STACKED (not side by side): Host and Join. Host card: name field
  + Start session (primary green). Join card: code field + name field + Join
  (neutral until fields are valid, then primary). One field style, one
  button height, consistent paddings. The two cards visually identical in
  width and radius.
- Local-source warning becomes a single quiet line under the Host card, only
  when relevant.

Active state (hosting/joined):
- Same centered column: live badge + "In session", the join code as a large
  click-to-copy keycap-styled chip (host only), the roster as a horizontal
  row of avatars with names beneath, then two buttons: Enter theater
  (primary) and End/Leave session (quiet danger text-button, not a big red
  slab).

Craft details: use the app's radius/spacing tokens; hairline card borders
(line-1) with bg-2 fills; focus rings on every interactive; the live dot
pulses subtly (static under reduced motion). No layout jumps between idle
and active: same column, content swaps.

Verify with two instances (host + join) and window widths down to 900px;
tsc/vitest/e2e (update smoke assertions on lobby text).
```

---

## Prompt 7 — Brand + green audit

```
[PREAMBLE]

Final sweep of the pass.

1. Logo audit: the canonical mark is src/assets/saucebunny.svg (bunny with
   play-triangle) and the app icon set in src-tauri/icons/ (AppIcon.icon /
   Assets.car / icon.icns). Grep the entire repo for every brand rendering:
   rail logo, any about/settings header art, dmg/installer config, README,
   e2e fixtures, _design mockups excluded. Anything still showing the old
   orange-circle placeholder or the old 128px raster gets swapped to the
   current assets. Confirm the rail renders the bunny (not a fallback) in a
   clean dev boot.
2. Green audit: list every use of --ella-green (and raw greens) in
   src/styles/*.css. Classify each as: primary action, live/recording state,
   or decoration. Keep the first two, strip the third to neutral tokens.
   Expected survivors: Fetch/primary buttons, GenerateButton, live session
   dot, scan/export progress fills, active-item accent edges. Expected
   removals: green icon fills in the rail, green text labels that are not
   states, green borders used as decoration.
3. Em-dash regression guard: add a vitest unit test that greps src/**/*.tsx
   string literals for em/en dashes in user-facing strings (allow comments
   and test files) so the voice contract survives future sessions. Keep the
   implementation simple: a test that reads the source files with fs and
   fails with the offending file/line list.
4. Take final screenshots of Home, Library, Clip (both panels open), and the
   Review lobby via npm run tauri dev for a before/after record; drop them in
   _design/refs/after/ (gitignore that folder if large).

tsc/vitest/e2e; then npm run tauri dev for the visual pass.
```

---

## Commit points
1. `copy: terse voice pass, kill em dashes and enumerations`
2. `clip: drop wordmark, panels open by default, icon sizing`
3. `transport: NLE bracket icons for mark in/out + timeline caps`
4. `home: cinematic hero, mixed rows, hover frame cycling`
5. `library: density + chips + color restraint`
6. `co-review: green room lobby redesign`
7. `brand: logo + green audit, em dash guard`
