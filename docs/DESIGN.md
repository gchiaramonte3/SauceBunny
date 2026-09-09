# Sauce Bunny — the design system

The current application rulebook. Source contracts enforce many of these
rules, but cannot prove rendered geometry, dynamic names or complete keyboard
behavior. Use the catalog and browser checks alongside those contracts.

Tokens live in `src/styles/tokens.css`. Component styles live in
`src/styles/<area>.css`. There is no CSS framework and no component library,
on purpose — see CLAUDE.md.

The [design catalog](DESIGN-CATALOG.md) records current component families
and proposed recipes for user review. This page remains the application's
current rulebook; catalog proposals are not permission to restyle the app.
The [historical audit](DESIGN-AUDIT.md) is retained with a dated reconciliation
at its end. Follow that reconciliation over older unverified worklists, and
do not adopt a catalog recipe in production until the user approves the
corresponding migration.

The [current application comparison](DESIGN-SYSTEM-AUDIT.md) records coverage,
remaining defects and specialty controls. Developers and AI contributors
should start with the repository's `AGENTS.md` and `CLAUDE.md`, then use these
documents and the actual component source together.

### Adopted People and Preview recipes (2026-09-07)

This is a limited production adoption, not approval of every catalog candidate.

- **Participant picture versus chrome:** the picture mask alone clips video
  and avatar content. Presenter, media/attention indicators and device controls
  sit outside that mask. Preserve the 72px compact rail with a 48px picture,
  240px expanded rail and 168px-wide 16:9 theater picture. Compact rules must
  exclude theater. All variants receive the same presenter and device truth.
- **Participant details:** a named native trigger opens the real participant
  actions with click, Enter/Space or the context-menu key. Details escape the
  scrolling rail through a viewport-contained portal, support menu keyboard
  navigation and Escape, and return focus to the trigger. In compact rails,
  camera/mic icons and buttons are hidden; their truth remains in accessible
  identity/details and their actions remain in details/the room toolbar.
  Expanded and theater device buttons remain separate 24px-or-larger targets,
  never nested inside another button.
- **Live source status:** `.cp-source-status` is passive, neutral and content
  sized. It has no field border, bevel, hover treatment or tab stop. The word
  Live identifies a source type, not proof of current connection health.
  Actual file timecodes continue to use `.cp-tc` unchanged.
- **Premiere disclosure:** `.cp-toolbar-disclosure` is the adopted 26px-minimum
  toolbar action, using sentence case, existing 11px text, neutral bevel/border,
  and white focus. A chevron, `aria-expanded` and `aria-controls` identify its
  existing source panel. Expanded does not mean connected or shared.

Keep specialized Play, frame-step, utility and single-volume geometry. Do not
change `.btn-compact` globally or import catalog mock handlers into production.
The catalog's **Before the fix** disclosures are historical evidence, not recipes.

### Review correction addendum (2026-09-07, evening)

- **Post and Share with room** are explicit user-approved green-action exceptions,
  using `--success` fill and `--bg-0` ink only while enabled. Other primary actions
  remain neutral. Share may pulse three times only with no reduced-motion preference;
  it never activates itself or claims verified connection health.
- Comment tools wrap before clipping Post. Reaction and emoji popovers portal
  outside scrollers and remain inside the viewport. Hiding a drawing suppresses
  the saved overlay at that moment; reopening its note restores it, without deleting it.
- Compact live-note context uses the shared type scale, not browser fieldset defaults.
  Review links are hidden from session onboarding; existing active-host access
  management and invitation policy remain intact.
- Expected speakers uses `ExpectedSpeakersMenu`, a controlled radio menu with
  `--novella-violet-deep` selected fill and shared menu keyboard behavior. This is a
  scoped exception to native selects, whose macOS popup selection cannot be themed
  reliably. It does not change Generate artwork or speaker identity colors.
- Empty Preview uses a flat `--bg-1` tonal surface; avoid quantized brand gradients
  or visible dither patterns behind the instructions.
- Premiere keeps the single Clip volume component and Settings-based diagnostics.
  Incoming dimensions size the initial monitor; do not force every input to 16:9.
  `Timeline TC unavailable` is honest state, not a substitute numeric clock.
- Transcript context menus distinguish **Remove from library** (exclusion only,
  immediate) from **Move to Trash…** (confirmed SRT/VTT-only native action).
  Keep source videos and sidecars; show partial errors and retry failed files only.
  This narrowly authorized exception does not reintroduce general media deletion.

### Catalog checkbox density (2026-09-07)

The approved catalog checkbox refinement uses a **13×13px native checkbox**
inside its associated **26px-minimum-height label**. Keep the label clickable,
the glyph non-shrinking, native Space activation and a visible 2px focus ring
with 2px offset. Visual size and pointer-target size are separate decisions.
This applies to the catalog's `.cp-ds-check` examples and text-size control;
it does not authorize resizing production settings, speaker controls or all
checkboxes. A separate approved catalog colour refinement sets the speaker-
roster checkbox accent to existing `--bg-5` (`#403F46`), preserving its native
white tick, unchecked state, 13px geometry and focus indication. This is scoped
to the catalog roster fixtures, not the production speaker/Detect speakers
recipes. The [frontend re-audit](DESIGN-FRONTEND-AUDIT.md) records remaining
production conformance work; a passing catalog is not an app-wide sign-off.

### Finder clip indicators (adopted 2026-09-07)

Use `ClipTagIndicator` with parent-provided native Finder tags. In thumbnail
cards, an **8px dot** sits immediately before the filename in
`.cp-lib-card-caption`, beneath and outside the artwork. The caption has a
6px gap; the dot never shrinks and the filename alone ellipsizes. In list
rows, a **2px stripe** sits at the row's far-left edge, inset **4px vertically**.
It is absolutely positioned, not another grid track or pointer target.

Use the existing `primarySwatch` (last colored tag), preserving all seven
Finder hues and the existing name-before-index resolution. Colorless custom
tags have no marker. Full tag names belong in the clip's tooltip and
accessible description. Indicators are passive metadata, not selection or
connection health. Never tint footage, the row fill or focus with a tag color.

Library, Home/search shelves, local recent items and downloaded web clips
share this recipe. Tag identity is the represented media file, never a URL,
borrowed transcript poster or session JSON. Parents use bulk reads; native
writes, failure rollback and Finder focus refresh remain intact. Successful
in-app writes also refresh other mounted views of the same file. Folders keep
their existing tinted glyphs. No tag editing is added to previously read-only
surfaces. See the Tables catalog entry for all-color and narrow examples.

### Premiere workflow correction (2026-09-07)

The Premiere source inspector uses the existing neutral action recipe,
with a small yellow **Beta** badge (`--gold` background, `--bg-0` text).
Its source label, refresh action and select have explicit gaps. Opening
the source settings requests discovery every time; only Preview source starts
capture, and only Share publishes. A vanished source never selects another.

Installation and receiver diagnostics belong in **Settings → Integrations**.
The inspector provides an actual Settings shortcut, not collapsed setup help.
The shared Review / Transcript / AI Summary / Queue drawer stays mounted
independently of the settings dialog. Session setup and notes can be switched without
stopping the preview. Private Premiere notes use their own review identity;
private inspection inside a room cannot misfile notes into the room document.

When Premiere owns playback, omit file Play, step, mark, speed, snapshot and
caption controls. Preserve their existing geometry for file playback. Preview
source enables local program monitoring through the existing single volume
control; a positive slider change unmutes it. Autoplay denial offers a clear
audio/monitor retry. No button here controls Premiere's transport, and no NDI
timestamp is represented as verified sequence timecode.

The one rule behind all of the others: **a value in a stylesheet should be a
name, not a number.** A number is a decision nobody can trace, and the next
person types a slightly different one.

---

## Type

Eleven rungs. `--text-base` is body; below it is chrome, above it is titling.

| token | size | use it for |
|---|---|---|
| `--text-2xs` | 8.5px | dense badge numerals |
| `--text-xs` | 9.5px | chip and pip labels |
| `--text-sm` | 10px | metadata, all-caps group labels |
| `--text-base` | 11px | **body** |
| `--text-md` | 12px | control labels, row titles |
| `--text-lg` | 13px | emphasised rows, section labels |
| `--text-xl` | 14px | section headings |
| `--text-2xl` | 15px | dialog titles, large inputs |
| `--text-3xl` | 18px | pane titles, empty states, large glyphs |
| `--text-4xl` | 22px | modal titles |
| `--text-5xl` | 28px | the welcome screen, and nothing else |

Eleven is more than a scale usually wants. The alternative was moving
heavily-used sizes by 1–3px to reach a shorter list, which is a redesign
wearing a cleanup's clothes. The scale's job is to stop the twelfth rung
appearing.

**Weight — read this one.** The app loads five faces: 300, 400, 600, 700, 800.
Ask for any other and the browser silently substitutes a different one. There
is deliberately **no** `--weight-medium`, because `font-weight: 500` appeared
fifteen times, no 500 face was ever imported, and every one of them rendered
as 400. Use `--weight-normal` / `-semibold` / `-bold` / `-black`. If you want
medium, import the face first; the token can follow.

**Leading** is unitless, always: `--leading-none` (1) / `-tight` (1.3) /
`-snug` (1.4) / `-normal` (1.5). A pixel line-height does not grow with its
text, so the first time the type changes size the chip clips its descenders.

**Tracking**: `--track-tight` (-0.01em) for large display text,
`--track-slight` (0.01em) for body, `--track-wide` (0.02em) for small body and
buttons, then three caps rungs — `--track-caps` (0.04em),
`--track-caps-loose` (0.06em), `--track-caps-wide` (0.10em). Uppercase needs
more air the smaller it gets.

**Numerals** are tabular everywhere: `base.css` sets
`font-variant-numeric: tabular-nums` on `*`, so a running timecode cannot
shimmy as its digits change. `--font-mono` is not a different family — the app
ships one typeface — it is a marker meaning *digits matter here*, and a rule
that uses it must also ask for the figures.

---

## Colour

**`--accent` is the neutral.** It resolves to `--fg-1` (white), and 137
surfaces lean on it for "brighter": the primary action, the current tab, the
armed control. It is not green, and it must not become green again
(`green-contract` pins the declaration).

**Green is not decoration.** `--success` means one of exactly three things: a
positive outcome (done, saved, passed), work actually running (the Generate
sweep, the recording dot), or a live feed. `--ella-green` is the same colour
reserved for the brand mark (loader, welcome, nav edge, the Generate sparkle).
Green never means "highlighted", "selected", "primary" or "nice" - and the
rule runs both ways: an outcome surface painted in `--accent` is a wrong
state, not a quieter choice, because a success then looks like an info.

**Selection is violet.** `--sel-fill` with `--sel-ink` on top, in every list
and the grid, so "which of these is selected" is never answered by one grey
step against another.

**Focus is white, never green.** A focused control brightens its existing
outline toward `--focus-ring`. Composed fields (a wrapper around a borderless
input, e.g. `.cp-url`) brighten the wrapper via `:focus-within` and suppress
the inner ring. Do not allowlist around this.

**The grey ladder** runs `--bg-0` (deepest) through `--bg-5`, with text
`--fg-0` (white) through `--fg-5`. Pick by depth, not by eye — seven
near-duplicate greys existed before this was written down, each matched
against whatever was on screen at the time.

**Lines** come from `--line-1` (separators), `--line-2` (control borders),
`--line-3` (hover and emphasis). Background FILL alphas are a separate concern
and keep their own values; that distinction is deliberate.

**Status**: `--success`, `--warning`, `--danger`, and `--danger-text` — the
last is danger as TEXT or an icon on a dark surface, because full-saturation
`--danger` fails contrast there.

**Tints derive, they are not retyped.** A translucent brand colour is
`color-mix(in srgb, var(--accent) 20%, transparent)`, never
`rgba(108,255,141,0.2)`. Ninety-plus hand-written tints meant retuning a brand
colour left ninety copies of the old one behind.

**Three naming generations coexist, and that is the thing to know before
minting a name.** `--bg-N` / `--fg-N` / `--stroke-N` came first, `--novella-*`
and `--gold` carry brand colours, and `--color-*` was a semantic-alias pass
that stalled halfway — some aliases were adopted, some barely
(`--color-accent-green` is the LEAST used of the three greens; reach for
`--success`), the unreferenced ones were deleted, and
what is left sits beside the other two. Several colours still answer to more
than one name. **Before adding a token, check whether the value already has
one.** A test fails the build on an unreferenced token, so the pile cannot
quietly rebuild itself, but nothing stops a fourth synonym for a colour that
already has three.

The in/out mark is a stem with one chevron wing at the waist, pointing away
from the marked region. The wing is `--mark-wing-l` / `--mark-wing-r` (a
clip-path, in `base.css` beside `--marker`), and the same drawing is the
path inside `IconMarkIn` / `IconMarkOut`, so the button and the mark it
leaves on the timeline are one shape. `IconRange` stays a `[` / `]` bracket
on purpose: a review comment range is not a clip range, and it is drawn on
the same track.

Also live and not covered above: `--danger-2` (the solid danger for fills, as
against `--danger-text` for glyphs), `--gold` (host crown and winner accents —
no status meaning), and `--marker` (the in/out marker violet).

Two literals are correct and are not drift: `#000` inside a `mask-image`
(black there is the alpha channel, not paint), and a colour no token holds —
whether the palette should grow is a design call, and naming a colour used
twice leaves the next person choosing between names instead of decisions.

---

## Spacing

`--s-1` … `--s-12` in 4px steps (4, 8, 12, 16, 20, 24, 28, 32, 40, 48).

Off-scale values are tolerated and are not a violation. The compact controls
in this app genuinely need 5px and 7px in places where 4 and 8 are both wrong,
and forcing them onto the scale would redesign every dense surface for no
stated gain.

---

## Radii

| token | value | use it for |
|---|---|---|
| `--r-2xs` | 2px | scrollbar thumbs, progress bars, hairline chips |
| `--r-xs` | 4px | small inline marks |
| `--r-sm` | 6px | small tiles, chips, thumbs, close buttons |
| `--r-md` | 8px | **controls** — buttons, inputs, rows |
| `--r-card` | 10px | **surfaces that float** — popovers, cards, panels, toasts |
| `--r-lg` | 12px | large containers, and **dialogs** (Settings, the speaker sheet, the share and move dialogs, the name gate) |
| `--r-xl` | 16px | the command palette and its shortcut sheet, the drop overlay |
| `--r-pill` | 999px | pills |

`--r-card` sits deliberately between a control's 8 and a container's 12. That
tier existed in fourteen places before it had a name. Every ANCHORED popover
or menu - anything that opens from a control and carries a shadow - is
`--r-card`; the r162 conversion had rounded each literal to its nearest rung
without reconciling the family, so four popovers on one monitor bar opened at
three different radii.

**Elevation** is two tokens. `--shadow-card` for the popover tier (menus,
popovers, toasts, HUDs) and `--shadow-modal` for dialogs; `--shadow-soft` is
the hairline lift for a small in-flow element like an avatar. A hand-typed
outer shadow with 8px or more of blur fails `elevation-contract`.

`border-radius: 50%` and per-corner shorthands (`0 0 6px 6px`) are shape, not
size, and are left alone.

---

## Stacking

Eight rungs, and nothing invents a number above 99.

| token | value | layer |
|---|---|---|
| `--z-modal` | 100 | a modal scrim and the dialog it dims |
| `--z-menu` | 200 | a menu or popover inside a panel |
| `--z-firstrun` | 300 | the welcome screen |
| `--z-popover` | 400 | a popover above everything in its own panel |
| `--z-notify` | 500 | notifications, recents, badge sheet |
| `--z-palette` | 600 | command palette, full-screen scrims |
| `--z-overlay` | 700 | menus launched from a scrim; a live OS drag |
| `--z-top` | 800 | a menu above its own scrim |

**Values at or below 99 are local** — stacking inside one component, relative
to its siblings and not to the app. Leave those as small integers; a token
would say nothing about them.

If you need a value *between* two rungs, you need a stacking context, not a
bigger number. This ladder replaced 27 ad-hoc values running to 10002, where
each author picked one above whatever they were losing to — which is how a
Rename dialog once rendered underneath the app and read as a button that did
nothing.

---

## Motion

`--dur-instant` (80ms) hover tints · `--dur-fast` (120ms) small state changes ·
`--dur-base` (180ms) the default · `--dur-slow` (280ms) entering and leaving ·
`--dur-slower` (350ms) panel travel.

Easing: `--ease-out` for most things, `--ease-in-out` for symmetric motion,
`--ease-spring` for the app's overshoot, plain `linear` for progress (there is
no `--ease-linear`; this page used to promise one).

**Entrances are tiered.** A popover or menu enters at `--dur-fast`, a sheet,
palette or toast at `--dur-base`, a dialog at `--dur-slow`. The Settings and
speaker dialogs used to run the SAME keyframe at 280 and 180ms.

These are for **transitions** and for the `animation:` shorthand of a
click-driven entrance. The timings INSIDE `@keyframes` are tuned per animation
and a shared token for them would mean nothing. The library hero's ambient
crossfades (450ms, 2500ms, 10s) are likewise their own thing — atmosphere, not
a response to a click.

**Reduced motion is not optional.** Every file that animates honours
`prefers-reduced-motion: reduce`, and `--panel-slide` collapses to `none`
under it. A new animation ships with its reduced-motion branch or it does not
ship.

---

## Targets

24×24 CSS px minimum (WCAG 2.2 SC 2.5.8). Smaller is allowed only where a
24px circle around the target touches nothing else, and that judgement goes in
the commit message, not in a silent allowlist entry. Grow the hit area with
padding or a transparent `::before` — not the icon.

---

## Specialty controls are part of the system

Consistency does not mean every button has the same geometry or paint.
Preserve these existing, named exceptions:

- **Generate transcript + speakers:** use `src/components/GenerateButton.tsx`,
  with the `.cp-source-action` context where appropriate. Preserve its three
  sparkle paths, beveled face, existing green brand wash, layered labels,
  progress and resolution feedback. Its idle brand wash is an intentional
  exception, not permission to make ordinary primary commands green.
- **Export and Fetch:** use `StatefulButton` with the actual caller recipes
  in Sidebar and Toolbar. Export keeps its violet CTA and 36px treatment;
  Fetch keeps its width lock and spinner-only loading state.
- **Speaker controls:** the transcript-library **Speakers** button is a
  pressed filter; **Detect speakers** is a checkbox; **Expected speakers** is
  a select; **Manage** opens the roster. Speaker identity/color, assignment,
  insights and detection are different roles, not one generic “Speaker” API.
- **Transport and editing utilities:** preserve Play, frame-step, mark,
  source-status, timecode and borderless utility geometry. Do not mechanically
  apply the proposed catalog command sizes to them.

For Generate and StatefulButton, the caller owns the real work, phase,
progress, disabled state and result reset. A style change cannot invent job
timers or alter cancellation. The catalog passes isolated local fixture props
to the actual components; it does not invoke transcription or export.

See [component recipes and examples](DESIGN-CATALOG.md#specialty-component-recipes)
before adding a new variant. Proposed 30px/26px generic controls remain
catalog-only until an adoption batch is approved.

### Premiere companion (internal-test adoption, 2026-09-07)

The user approved matching the small Premiere plugin to this design system.
Its [design contract](../premiere-companion/DESIGN.md) imports the actual app
tokens and adopts neutral 30px-minimum commands, shared bevel states, white
focus, and the 13px dark-neutral checkbox inside a full-height label. This
does not authorize another application-wide control migration. Native UXP
font/field limitations are explicit exceptions, not a new font or palette.
The package's own design and rendered-panel tests protect those recipes;
real Premiere rendering remains a separate host acceptance gate.

### Saved session history (2026-09-07)

Session rows and grid cards use **Open session** for their primary context
action, double-click and Enter. Opening a record must not reveal its JSON,
join a room, publish a source or load video. A read-only archive view keeps
source context on the left and saved notes/replies on the right. Back restores
the list and row focus; **Open source in Clip** is a separate explicit action
only for a recorded, unambiguous file/web source.

Known Premiere senders carry a neutral **Pr** badge; other NDI senders carry
**NDI**. Neither badge implies connected/live health or verified timecode.
Source-less/live records explain the lack of a saved video without hiding the
notes or requiring Premiere to read them. Missing records and missing review
documents have distinct messages. No approval, editing or marker-sync action
is implied by this historical reader.

The sessions search field reserves space for “Search sessions and people”;
its toolbar may wrap at narrow widths. These styles are scoped to the session
shelf, not a global browser-toolbar or compact-button redesign.

---

## Settings integration panels

Placement correction, 2026-09-08: the Preview sidebar is the shared Clip
commenting/tool drawer. Never insert NDI configuration between its tabs and
comments. This supersedes the earlier inline source inspector and transport
text disclosure placement.

Open source settings from the named **NDI settings** gear using the existing
`cp-icon-btn` utility recipe, immediately after the single volume control.
Preserve host/presenter permissions and keep the gear available at narrow widths.
The picture/audio settings are a viewport-contained portal dialog headed **NDI**
with a yellow Beta badge, distinct from Premiere's companion/marker integration.
Use the shared modal focus trap; Escape, Close and Done return focus to the gear.
Opening discovers sources without starting capture or publishing. Closing must
preserve source selection, the decoder, the active sidebar tab and comment drafts.
Installation and Marker setup close this dialog before opening Settings →
Integrations; instructions and receiver diagnostics remain there.

Keep at least `--s-3` (12px) between Marker setup and Reconnect picture. The
standalone Preview header uses `--s-3` internal padding and a matching gap below
it so the paste/watch controls do not touch the monitor surface. These are scoped
layout rules, not changes to global compact-button sizes or room publication.

Clear-viewport follow-up, 2026-09-08: no source-name, connection-status or
audio-recovery badges over the NDI picture. Keep passive Not shared / Shared
with room / Sharing stopped above it, with the sequence-timecode window centered
in the same header. Use `NdiPreviewHeader` and the existing `cp-tc` recipe;
`--:--:--:--` is explicitly unavailable, never an invented NDI-to-sequence clock.
Timeline timecode unavailable and Playback controlled in Premiere share one
transport line. Do not show the file Shortcuts/marking hint during live input.
Source details, decoder errors and Enable program audio / Resume program monitor
belong in NDI settings. Guest settings offer local decoder recovery only: no
discovery, source selection, marker setup, capture or room publication. Opening
the gear while viewing an existing input must not switch to a retained private
candidate. Keep Preview's notes rail docked even below 1200px; only Clip retains
its narrow floating-drawer behavior. Hide covered file onboarding while awaiting
the first program frame, without unmounting any file player.

Integration setup uses the same Settings recipes as General: `cp-pane-title`
for the 18px heading, `cp-pane-sub` for the 12px introduction, `cp-pane-row`
for status/actions, and `CollapsibleSection` for optional setup and diagnostics.
Supporting status text uses the 11px description token. Never leave headings
or paragraphs to browser-default sizing. Settings actions use the neutral,
sentence-case 30px button recipe; compact transport controls stay unchanged.
Keep version/runtime metadata inside Connection details and wrap long values.
Premiere-specific overrides stay inside `cp-premiere-setup`.

Companion pairing is one explicit **Copy pairing code** action in Settings,
one masked **Pairing code** field in Premiere and a **Connect** command.
Do not expose two raw credential fields or copy only half the pairing data.
Copy success/error feedback is inline; neither copying nor pasting connects.
The native UXP companion keeps its host-painted form controls without adding
a second CSS border/bevel. Align labels left, use the existing type scale and
space between sections instead of decorative divider boxes. Empty sequence
and note controls stay out of the disconnected setup; queued notes survive it.

---

## Voice

Terse and plain. **No em dashes** anywhere in user-facing copy. No
strikethrough. Say what happened and what to do about it:

> That project still holds 3 transcripts. Move them out first.

not "Operation failed: directory not empty". Singular and plural both get
written — "1 transcripts" is the tell that nobody read the string.

---

## Naming

Every class is `cp-` prefixed and kebab-case, grouped by component context
(`cp-reader-project-title`). The prefix is a carryover from the app's original
name and is kept deliberately: renaming ~600 classes touches every file and
buys nothing a user can see.

---

## What checks this

`npm test` runs these. `node scripts/design-audit.mjs` recounts the outliers at
any time and should print 0.

| test | what it holds |
|---|---|
| `design-tokens-contract` | the type, weight, leading, tracking, radius and z rules above |
| `token-usage-contract` | no literal hex that a token already holds |
| `focus-contract` | a focus ring is never the green accent |
| `hit-target-contract` | no new sub-24px pointer target |
| `reduced-motion-contract` | every animating file honours the preference |
| `voice-contract` | no em dashes in user-facing strings |
| `class-prefix-contract` | the `cp-` prefix |
| `css-var-contract` | no reference to a token that does not exist |
