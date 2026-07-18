# Claude Code OVERNIGHT pack — punch list 1a-13a

Source: annotated screenshots in _design/refs/punchlist/ (filenames carry the
notes; READ the images before designing — Claude Code can view PNGs).

OVERNIGHT RULES: run prompts 1 → 6 sequentially, unattended. Gate each:
npx tsc --noEmit && npm test && npm run test:e2e, plus cargo check &&
cargo test --lib when Rust changes (then bump BACKEND_BUILD_ID both sides).
COMMIT ONLY IF GREEN. Two fix attempts max per failure, then log to
_design/overnight-notes.md and continue. Anything requiring eyes goes on the
MORNING CHECKLIST at the bottom (append as you go). Voice/color contract:
terse copy, no em dashes, tokens only, cp- prefixes, no new dependencies,
reduced motion respected, and the focus-contract test stays green.

---

## Prompt 1 — Green has two jobs: primary actions and notifications. Nothing else.

```
Refs: punchlist/3c, 3d, 5a (both files), 6a, 7a.

The rule, final form: --ella-green appears ONLY on (1) the single primary
action of a surface (Fetch, Generate transcript, Export, Start session,
Resume) and (2) notification/live signals (badge dots, live session dot,
recording dot). Every other control that currently goes green when active
switches to the neutral grey ladder (active = bg-4/bg-5 fill + fg-1 icon,
hover one step brighter; follow the existing neutral active treatment used
elsewhere and keep it consistent).

Convert to grey-active (green removed):
1. Play/pause transport button (ref 7a: it renders solid green while
   playing). Grey ladder; the icon state change is the signal.
2. Caption/subtitle toggle in the transport (ref 6a: green outline + glow
   when on). Grey-active, no glow.
3. The transcript panel's Text|Speakers segmented control (ref 3c: the
   active segment label is green). Active segment = bg-4 fill, fg-1 text.
4. Follow playback (ref 3d: green pill at the transcript foot). Grey-active
   AND relocate it: it moves out of the floating foot position to sit next
   to the Manage speakers button in the transcript header row (same control
   group, same height). Keep its auto-disengage-on-scroll behavior.
Audit while there: grep --ella-green / accent usage across styles for other
ACTIVE-STATE uses on toggles (not primaries, not notifications) and convert
them with the same ladder; list every conversion in the commit message.

Add green where it now belongs (ref 5a x2): notification badges. The
toolbar's right cluster (panel toggle with its count badge, co-review chip,
notification bell dot) currently shows neutral badges; badge fills and dots
become --ella-green with bg-0 text (the 5a annotation: "this is where the
green should go"). Same for any other count badges using the same badge
class. The badge grammar (size, radius, offset) is unchanged, color only.

Do NOT touch: GenerateButton, StatefulButton success states, live session
dot, scan/export progress fills, marks (prompt 3 owns mark colors), or
focus rings (white, guarded by focus-contract.test.ts).

e2e: update any selector/screenshot assertions on the converted controls.
Commit: `ui: green means primary or notification, active toggles go grey`
```

---

## Prompt 2 — Transcript speakers: color sync bug, header lines, rename popover colors, hover reveal

```
Refs: punchlist/3a, 3b, 4a, 2a.

1. BUG (ref 3a): changing a speaker's color in Manage speakers does not
   recolor that speaker's segments on the player timeline. The speakers-
   changed event exists (saucebunny:speakers-changed, fired as both a Tauri
   event and a window CustomEvent). Find why the timeline's speaker lane
   misses it: likely the lane memoizes colors keyed on turns without
   subscribing to override changes, or reads overrides once at mount.
   Fix by subscribing to the same event the transcript uses; the lane
   recolors immediately, no reload. Add a vitest for the resolver if the
   color-resolution logic is extractable.
2. Ref 3b: the "N SPEAKER(S)" header row inside the transcript Speakers
   view has leftover hairlines above AND below it that read as broken
   framing. Remove the stray rules so the header sits in clean space
   (match the Text view's header treatment; one separator max, and only
   if the Text view has one).
3. Ref 4a: the right-click rename popover (RenamePopover) gains the SAME
   color control that Manage speakers has: reuse SpeakerColorPicker (the
   component and its persistence plumbing, not a copy) as a compact swatch
   row inside the popover, above the Apply-to-every/Only-this-turn radios.
   Picking a color applies through the exact same override path (and so
   fires the same speakers-changed event, which after fix 1 recolors the
   timeline too). Keep the popover under its current width; if the picker
   needs a compact variant, add a `compact` prop to SpeakerColorPicker
   rather than forking it.
4. Ref 2a: the highlighted word-block in a transcript turn currently
   requires a CLICK to reveal/expand. Make hover do it: pointer-over the
   block (~150ms intent delay) reveals it, pointer-out collapses; click
   still works and pins the reveal (Esc or click-away unpins). Keyboard
   focus reveals like hover (focus-visible). No reveal-on-hover under
   prefers-reduced-motion if the reveal animates; instant swap instead.

Commit: `transcript: speaker color sync + popover colors, header lines, hover reveal`
```

---

## Prompt 3 — Timeline marks: queued/succeeded/failed color states + cleaner selection

```
Refs: punchlist/8a, 9a.

1. Ref 8a: queued clip ranges on the timeline get a status color system
   tied to their queue job: YELLOW (--warning or a dedicated queued token
   if warning reads too orange; pick from tokens, do not invent hex) while
   queued/running, GREEN (--ella-green) on success, RED (the app's danger
   token) on failure. The timeline range visuals for queued clips are
   currently dark hatched blocks (see the ref); restyle them: a soft
   status-tinted fill (~18% opacity) + a 2px status-colored baseline bar +
   thin edge ticks, so ranges read at a glance without shouting over the
   filmstrip. State updates live as the queue reports (the queue already
   tracks DONE/FAILED per item; thread that status to the timeline ranges
   by job id). Completed/failed states persist while the source stays
   loaded; a cleared queue item removes its range.
2. Hover a range → tooltip: clip name + status word + time span. Click →
   scrolls/opens that item in the queue drawer.
3. Ref 9a: the helper line "No marks set. Export grabs the whole clip."
   must disappear the moment marks exist (it currently lingers). Render it
   ONLY when no in/out marks are set AND nothing is queued; it returns
   when marks clear. While marks exist, the line's space collapses (no
   reserved empty row).
4. This prompt owns mark/range colors (exempted from prompt 1's sweep).
   The green success fill here is a status signal, consistent with the
   green-notification rule.

e2e: extend the smoke/undo specs: set marks → helper line gone; queue a
mocked export → range renders with the queued class; mock done/failed →
class flips.
Commit: `timeline: status-colored clip ranges, helper line yields to marks`
```

---

## Prompt 4 — Loader v2 + sharp player placeholder icons

```
Refs: punchlist/1a (two files) and punchlist/loader-in-context.png, plus
punchlist/11a.

1. BunnyLoader v2 (refs 1a + 1a_Continued; in-context shot shows the rest):
   - REMOVE the persistent base outline layer entirely (the "pre outline"
     the user does not want to see). The mark should be invisible except
     where the traced segments are passing.
   - LONGER segments: the gradient trace grows from ~30% to ~55% of each
     contour, and the comet tail lengthens proportionally, so at any
     moment most of the bunny is being suggested by light.
   - MORE glow and feathering: widen the blurred underlayer stroke, raise
     the blur radius, and add a second, softer halo pass at very low
     opacity so the trace feathers out instead of stopping. Tune until it
     reads like neon light, not a stroked path. Keep both purple and green
     visible along the gradient.
   - Composition (loader-in-context.png): in the stream-buffering overlay
     the loader sits off-center relative to its text block. Center the
     loader + title + subtitle as one vertical stack, gap tokens, on both
     the prep banner and the buffering overlay.
   - Reduced motion: with no base outline, static mode shows the full
     outline at low opacity (the one place the full outline may appear).
   - Update the path-count DOM test to the new layer structure.
2. Ref 11a: the player's audio/file placeholder (the centered film glyph
   above "Press play to start") is a low-res raster look. Replace with a
   crisp inline SVG at the correct render size: use the bunny outline
   asset (saucebunny-outline.svg) at low opacity as the placeholder mark,
   sized ~96px, fg-4 stroke. Audit the empty/placeholder states in
   Monitor.tsx for any other raster-looking glyphs and swap to Icons.tsx
   dialect SVGs.

Commit: `loader: no base outline, longer glow trace, centered; sharp placeholders`
```

---

## Prompt 5 — Portrait media: 9:16 cards on Home and Library

```
Ref: punchlist/12a (portrait sources squeezed into 16:9 cards).

1. Aspect detection: the thumbnail pipeline knows the poster's natural
   size once the image loads (naturalWidth/Height); cache the aspect
   alongside the thumb (extend the module cache entry in
   use-library-scan.ts: url + aspect). No extra probing.
2. Card behavior (LibraryCard + the browser grid + Home shelves): rows
   keep ONE uniform height per row. Landscape art fills the 16:9 cell as
   today. Portrait art (aspect < 1) renders CONTAINED at full cell height,
   centered, with a blurred, darkened cover-fit copy of the same poster
   filling the letterbox gutters (the standard streaming-app treatment;
   one extra img layer + overflow hidden, reduced-motion irrelevant).
   Never stretch, never crop a portrait poster to landscape.
3. The hero (if the featured item is portrait) keeps its right-anchored
   composition but switches to the blurred-fill treatment behind a
   contained portrait frame.
4. List view rows and the detail panel show portrait posters contained on
   bg-2, no blur needed at small sizes.
5. Hover frame-cycling frames inherit the same aspect handling (they come
   from the same source; reuse one art-layout component or class pair
   rather than duplicating the blur/contain logic per surface).

e2e/vitest: a DOM test for the aspect classification helper (aspect from
dimensions, portrait/landscape/square thresholds).
Commit: `library: portrait-aware cards, blurred-fill letterbox`
```

---

## Prompt 6 — Session invite code + yt-dlp update integrity

```
Refs: punchlist/13a (the invite is a paragraph-sized blob), punchlist/10a.

1. Session invite (Rust, session.rs + lobby UI). Today the join code is
   the full serialized iroh ticket: hundreds of characters (see the ref).
   Investigate the minimum iroh needs on our version:
   a. If the endpoint has discovery enabled (n0 DNS/pkarr), a NodeId-only
      ticket suffices to dial; the invite becomes SAUC- + base32 NodeId
      rendered in dash-separated groups of 4-5, ~55 chars total. Implement
      that if discovery is available on our iroh version and the join path
      resolves it (verify with a loopback join test).
   b. If NodeId-only dialing is NOT reliable on our setup, keep the full
      ticket as the wire payload but STOP displaying it: the lobby shows a
      short display handle (SAUC- + first 2 groups + …) with one primary
      "Copy invite" button carrying the full ticket to the clipboard, and
      the join field accepts a pasted full ticket while showing it
      collapsed. Either way the paragraph blob never renders again.
   Wrap-up: the join field trims whitespace/newlines from pasted invites
   (paragraph-wrapped pastes from chat apps must still parse). Rust unit
   test: invite round-trip parse (with prefix, with dashes, with wrapped
   whitespace).
2. Ref 10a, yt-dlp update integrity ("make sure it ports over correctly").
   Audit update_ytdlp end to end:
   a. The updated binary must be the one actually invoked by EVERY yt-dlp
      call site (resolve, metadata, captions, downloads) including after
      app restart; verify the resolved-path helper prefers the updated
      copy consistently and log which copy ran (path + version) at debug
      level under the yt-dlp tag.
   b. After update, the Settings row's version string reflects the new
      version without reopening Settings (re-query on update completion;
      the ref shows "Updated to 2026.07.04" prose, keep that but make the
      version chip refresh too).
   c. Guard rails: verify the downloaded binary before swapping it in
      (runs --version successfully, output parses as a date-version);
      a failed verification keeps the previous copy and fails loud.
      "Reset to bundled" must also clear any cached resolved path.
   d. Rust unit test for the version-string parse + the prefer-updated
      path resolution order.

Commit: `session: short invite codes; ytdlp: verified update path everywhere`
```

---

## MORNING CHECKLIST (append per-prompt items overnight)

1. Visual pass: play/pause + captions + Speakers tab + Follow playback all
   grey-active; badges green; nothing else gained or lost green.
2. Change a speaker color via Manage speakers AND via right-click popover:
   timeline lane recolors instantly both ways.
3. Queue three exports (one forced failure): yellow → green/red on the
   timeline; helper line disappears when marks set.
4. Loader: no resting outline, long feathered neon trace, centered with
   its text on both overlays; reduced-motion static outline.
5. Portrait video on Home/Library/hero: contained with blurred fill, no
   squeeze.
6. Host a session: invite renders short (or collapsed with Copy invite);
   join from second instance with a chat-wrapped paste.
7. Settings: Update yt-dlp then restart the app; confirm the updated
   version is still the one running (pipeline log shows path + version).

## Appended overnight (all six prompts ran; per-prompt notes)

- P1: converted list is in the commit; kept green: primaries, live dots,
  playing equaliser, progress fills, ghost colors, mark statuses (P3).
- P2: hover-reveal visibility raised per live feedback (10% white fill +
  1px outline + 150ms intent delay).
- P3: done/failed range colors flip from live queue state; e2e covers
  queued class + helper-line collapse (run one real failed export in the
  morning pass for the red flip).
- P4: loader has NO resting outline now; reduced-motion is the only full
  outline. BunnyMark replaced the film glyph in all three players.
- P5: aspect cache lives in lib/art-aspect.ts (measured at img onLoad);
  fingerprint note: none - aspect keys on the thumb URL everywhere.
- P6: invites are SAUC- dressed full tickets (NodeId-only dialing was not
  verifiable without live discovery, so option B); the lobby shows the
  collapsed handle + Copy invite; joins accept chat-wrapped pastes.
  yt-dlp updates verify (--version parses date-shaped) before replacing
  the previous copy; the resolver logs which copy runs on every spawn.

- P7 (added after the first run): lobby buttons hug their labels (88px
  floor, 280px cap, centered); Join arms green only when code + name
  validate and holds its width through "Connecting…"; the devices step
  keeps ONE green (Enable pre-grant, Continue after); End/Leave is a
  quiet text button. Deviation: "Enter theater" no longer exists - the
  session ROOM replaces the in-session lobby automatically, so that face
  has no green primary by design.
