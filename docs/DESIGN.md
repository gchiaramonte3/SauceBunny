# Sauce Bunny — the design system

One page. Everything below is enforced by a test, so you will meet it as a
failure message if you skip it; this exists so you meet it here instead.

Tokens live in `src/styles/tokens.css`. Component styles live in
`src/styles/<area>.css`. There is no CSS framework and no component library,
on purpose — see CLAUDE.md.

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

**Green is not decoration.** `--accent` (`--ella-green`) means one of exactly
two things: this is the primary action, or this is a notification. It never
means "highlighted", "selected", or "nice".

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
| `--r-lg` | 12px | large containers |
| `--r-xl` | 16px | modals, the command palette |
| `--r-pill` | 999px | pills |

`--r-card` sits deliberately between a control's 8 and a container's 12. That
tier existed in fourteen places before it had a name.

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
`--ease-spring` for the app's overshoot, `--ease-linear` for progress.

These are for **transitions**. `@keyframes` timings are tuned per animation and
a shared token for them would mean nothing. The library hero's ambient
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
