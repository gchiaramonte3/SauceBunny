# Design system audit

Four parallel passes over colour, tokens and control vocabulary.
A worklist, not a record of work done.

---

# DOCUMENT 2 — Design system audit: colour and control vocabulary

HEAD `3fc77b1`. Commit `8071823` ("green means 'this is on', not 'click this'") already landed and is included in everything below.

## 1. Current state — colour

**The primary-button green is already gone.** `.btn-primary` is a raised neutral across all four states — `bg-4` fill, `bg-5` hover, `line-2` border (`buttons.css:65-85`) — with the rationale at `buttons.css:54-64`. The green CTA glow tokens were deleted (`tokens.css` diff in `8071823`). 24 call sites inherit it. Nothing re-greens it.

**Green still paints 115 rules / 184 declarations across 21 of 23 stylesheets** (pass 3's enumeration; I spot-checked the reference counts and they hold: in `src/styles/*.css` alone, `var(--accent)` 101, `var(--accent-rgb)` 48, `--color-accent-green` 20, `--ella-green` 14, `--success` 11). Pass 3's three groups:

- **(a) live/active state — 67 rules.** Nav rail active view, running progress fills, playing cue, session badges, toggles that are on.
- **(b) a control that is merely available — 25 rules.** Fetch hover flare (`buttons.css:190-208`), Generate hover glow (`buttons.css:298`, `:316`), four resize-handle rails (`resize.css:34/44/58/68`), five native `accent-color` tints, two AI citation styles.
- **(c) decoration — 23 rules.** Of which **15 are dead**: `var(--marker-color, var(--accent))` / `--pr-color` / `--ghost-color` fallbacks whose custom property is always set inline from JSX (`Timeline.tsx:148/210/528/546`, `ReviewPanel.tsx:1505`, `PeoplePanel.tsx:243`), all resolving through `AVATAR_COLORS` (`review.ts:789`), which never returns undefined. Those 15 green tokens never paint a pixel.

**Inside group (a), 18 rules are success/outcome, not liveness** — done, ok, pass, approved, authorized, copied. That is a separate semantic wearing the same colour.

**One hex answers to seven names.** `#6CFF8D` is `--ella-green` (`tokens.css:10`), `--success` (`tokens.css:64`), `--color-accent-green` (`tokens.css:123`); `--stroke-green` (`tokens.css:53`) and `--ring-green` (`tokens.css:102-104`) derive from its rgba; `--accent` aliases it at `base.css:58` with `--accent-rgb` at `:59`. **149 declarations flow through that one alias line.**

**The stated rule contradicts itself in the tree.** `buttons.css:186-189` says, in as many words, "colour contract: green marks the primary action and live states, nothing else" — and commit `8071823` says green means "this is on", not "click this". Both are in the repo. Neither is enforced by a test.

**Green is also an identity colour, in a place CSS cannot see.** `AVATAR_COLORS` (`review.ts:789`) contains `#2dd4bf` and `#34d399`. A reviewer whose name hashes there gets green comment pins, ghost playheads and avatar rings meaning *this person*, applied as inline style from `Timeline.tsx:528/546` and `PeoplePanel.tsx:243`.

**Two colour bugs, free to take.** `TranscriptViewer.tsx:1677` renders the transcript error icon as `var(--color-warn, #f5a)`; `--color-warn` is defined nowhere (the tokens are `--warning` at `tokens.css:65` and `--color-warning` at `:126`), so it renders **hot pink** — and passes `css-var-contract` because a fallback counts as resolving. `.cp-review-reclabel` (`review.css:857`) is green text on a purple recbar while the mic button is red: three colours for one recording.

## 2. Current state — control vocabulary

**188 distinct classes appear on a `<button>`; 136 declare their own pressable surface. The shared system is 5 classes**: `.btn` (`buttons.css:9`), `.btn-primary` (`:53`), `.btn-ghost` (`:174`), `.btn-icon` (`:140`), `.btn.btn-compact` (`:215`). Of 488 `<button>` sites, 198 use the family, 230 use a bespoke class only, 60 carry no static class.

**Two files contain the same rule.** `.cp-icon-btn` (`transport.css:90-104`) and `.cp-queue-iconbtn` (`queue-drawer.css:389-402`) declare identical properties in identical order with identical hovers. Only the box size and a stray `padding: 0` differ.

**Fourteen classes do one job.** The close/remove "x" family drifts on six axes: sizes 18/18/18/19/20/20/20/20/24/24/26/28 (+one unsized), radius `--r-xs`×7 vs `--r-sm`×6, colour `--fg-3`×9 vs `--fg-4`×4, `background: transparent`×6 vs `none`×5 vs an rgba, glyph sizes across `--text-base` through `--text-3xl`. Seven of them are already pinned in `hit-target-contract.test.ts:40-47`'s `KNOWN_SMALL`.

**Seventeen pixel heights, no token.** 13/14/15/17/18/19/20/22/24/26/28/30/32/34/36/38/40 across 106 button-surface rules. `tokens.css` has `--r-*`, `--s-*`, `--text-*`, `--leading-*`, `--track-*`, `--weight-*`, `--z-*`, `--dur-*`, `--ease-*` — and **no control-height token of any kind**. `.btn` is 30px, `.btn-compact` 22px, and the most common values are 24 (19 rules), 26 (16), 22 (13), 30 (11).

**Icons have no colour token at all.** Every icon defaults to `stroke="currentColor"` (`Icons.tsx:15`), so its colour is whatever `color:` the container declares — 15 distinct values across 5 icon-button families that disagree on rest, active and disabled. `Icons.tsx:15` also declares `size = 16`, which is dead code: all 245 call sites pass an explicit size, across 20 distinct values with a mode of **13**. Disabled is never a colour; it is `opacity` at ten different values.

**One family already does what you want.** `.cp-icon-btn` (`transport.css:90-108`): `--fg-3` at rest → `rgba(255,255,255,0.05)` + `--fg-1` on hover → `--bg-5` fill + `--fg-0` when active. Zero green. Propagate it; do not invent a new pattern.

**Spacing is the biggest uncovered category.** Of 415 `gap` declarations, 91 use a token, 119 write a literal the `--s-*` scale already names, and 205 are off-scale — dominated by **6px (56)** and **10px (43)**, neither of which has a rung on a 4px scale starting at `--s-1: 4px` (`tokens.css:152-161`). Padding: 504 declarations, 74 tokenised.

**Uncovered leaks with cheap fixes.** 14 rules use the CSS keyword `ease`/`ease-out` instead of `var(--ease-out)` — a real curve change, `cubic-bezier(0,0,0.58,1)` vs `cubic-bezier(0.2,0.8,0.2,1)` (`tokens.css:272`). And duration literals survive because they are written in **seconds**: `buttons.css:257-261` has `0.35s` (= `--dur-slower`) and `0.12s` (= `--dur-fast`), invisible to every ms-shaped grep.

**Already locked down, do not re-propose:** radius, font-size, font-weight, line-height, letter-spacing, app z-index, `--font-mono`/tabular pairing, unreferenced tokens (`design-tokens-contract.test.ts`); literal hex duplicating a token (`token-usage-contract`); hex fallbacks on defined tokens (`token-fallback-contract`); `var()` resolvability (`css-var-contract`); `!important` ratchet; `cp-` prefix; dead classes; reduced motion; sub-24px targets; focus-ring colour.

## 3. Ranked worklist

### 1. Rebind the name — one line, 149 declarations move

`base.css:58-59` currently reads `--accent: var(--ella-green); --accent-rgb: 108, 255, 141;`.

Split it. Keep `--accent` as the role name and point it at a neutral (`var(--fg-2)` for text/glyph roles). Mint `--live: #6CFF8D` and `--live-rgb: 108,255,141` as the **only** green. Repoint the 67 group-(a) rules to `--live`; the other 48 follow the neutral automatically. Do this first so every later step is a deletion rather than a search.

### 2. Collapse seven green names to one

Delete `--ella-green` (`tokens.css:10`), `--success` (`:64`), `--color-accent-green` (`:123`), `--stroke-green` (`:53`), `--ring-green` (`:102`); repoint their references at `--live`.

**Ordering trap:** `design-tokens-contract.test.ts` fails on an unreferenced token and `css-var-contract` fails on an unresolved one, so each token's last reference and its definition must die in the **same commit**. `--ring-green` (1 ref, `settings.css:281`) and `--stroke-green` (1 ref, `shell.css:827`) are the cheapest starts.

### 3. Give icons a ladder; propagate the family that already works

Adopt `.cp-icon-btn` (`transport.css:90-108`) as the house rule and mint three tokens so the state has a name a test can read: `--icon-rest` (= `--fg-3`), `--icon-active` (= `--fg-0`), `--icon-disabled` — replacing ten different bare opacities.

Convert the five families that currently go green on active: `review.css:108` (`.cp-review-iconbtn.active`), `review.css:699` (`.cp-review-tool.active`), `transcript.css:59`, `settings.css:143`, `sidebar.css:514`. These are the icons you touch constantly, so this is where "brighter white and grey" actually reads.

### 4. Fix the review composer — both halves, differently

- `.cp-review-tool.active` (`review.css:699-703`) is real state → neutral active treatment from step 3 (`bg-5` fill, `fg-0` glyph). It also stops contradicting its own **red** `.recording` sibling at `review.css:705`.
- `.cp-review-drawhint` (`review.css:829-836`) is decoration → fully neutral (`fg-2` on `rgba(255,255,255,0.06)`, `--line-1` top border). The banner only mounts while drawing is armed, so its existence already carries the state — and the same class carries two non-drawing messages ("Transcribing your voice…", `dictNote`).
- `.cp-review-reclabel` (`review.css:857`) → red, matching the mic button and the recbar.

### 5. Neutralise all 25 group-(b) rules

Nothing here is state. In visibility order: the Fetch hover flare (`buttons.css:190-208` — see the decision in §5), the Generate hover glow (`buttons.css:298`, `:316`), the four resize rails (`resize.css:34/44/58/68` — these use the *same* green for `:hover` at 0.55 opacity and `.dragging` at 1.0, which is exactly the available-vs-live collision: keep drag green via `--live`, make hover white-alpha), the five native `accent-color` tints, the two AI citation styles.

### 6. Delete the 23 group-(c) greens, starting with the 15 that are free

`transport.css:194/209/516/565/578/588/590/613/623/635/655/674`, `review.css:651`, `room.css:237/247` need only `var(--accent)` → `var(--fg-3)` **inside the fallback slot**. Zero pixels change, because the fallback never fires. Then the genuine decoration: `welcome.css:16/33`, `loader.css:4`, `monitor.css:97` (a speaker name is identity, not state), `shell.css:824/827`, and the green radial stop in `--grad-brand-wash` (`tokens.css:132`).

### 7. Tokenise the grey fill layer

38 distinct white-alpha literals over ~305 declarations. The line layer got `--line-1/2/3` in r99; the fill layer never did — and it will get worse as green stops carrying state, because every neutralised rule reaches for another one-off alpha. Mint four fill tokens at the four dominant values — 0.03, 0.05, 0.08, 0.12 — absorbing the 0.015/0.02/0.025/0.035, 0.04/0.06, 0.07/0.09/0.10, 0.11/0.14 strays.

Collapse two near-duplicate greys while you are there: `--color-text-secondary` `#8A8A8E` (1 ref, `transcript.css:339`) into `--fg-4` `#86868F`, and `--stroke-1` `#141419` (1 ref, `settings.css:812`) into `--bg-2`/`--line-1`.

### 8. One-line bug

`TranscriptViewer.tsx:1677`: `var(--color-warn, #f5a)` → `var(--warning)`. Stops being the only pink pixel in the app.

### 9. Easing and duration literals

Fix the ~16 sites in §2. Treat the `ease-out` keyword sites as a **visual change**, not a rename — eyeball `transport.css:532/612` and `room.css:129`.

### 10. Icon size — enforce with the type system, not a test

Change `Icons.tsx:4` from `size?: number` to a union of the rungs you keep, and fix the dead default at `Icons.tsx:15` to the size actually dominant (13, not 16). `tsc` then fails all 268 call sites at once, which is the correct blast radius and needs no new contract file. Suggested rungs from the existing distribution: 11 / 13 / 16 / 20 / 28, with the four display sizes (32/44/52/96) split to a separate path.

### 11. Collapse the close/x family

14 classes → one `.cp-close` at 24px, which is also the WCAG 2.5.8 floor, so it retires seven entries from `hit-target-contract.test.ts:40-47` as a side effect. Delete `.cp-queue-iconbtn` (`queue-drawer.css:389`) and use `.cp-icon-btn` with a size modifier. Check `e2e/new-folder-consistency.spec.ts` (pins a class by name) and `e2e/card-unity.spec.ts` / `e2e/list-row-height.spec.ts` (measure geometry) before renaming.

### 12. Control-height scale — needs a decision first

Mint `--control-sm/md/lg`. 22/26/30 covers 59 of the ~106 height-declaring rules with no visual change; 32/34/36/38/40 is a fourth rung or a real redesign. Because the unreferenced-token contract fails on an unadopted token, mint and adopt in one commit.

### 13. Spacing — decide the two missing rungs before writing any test

6px and 10px are the r162 `--r-card` situation repeating verbatim: two clusters too large to be mistakes with nowhere to live. Either name them or round 99 declarations to 4/8/12 (a visible change). Once decided, enforce on `gap` **only** — it is single-valued and 119 declarations are exact token duplicates today. Leave `padding` alone: 404 of its 504 literals are two-axis shorthands where the axes rarely share a rung, and a mechanical sweep there is a regression generator.

**Not worth doing:** a box-shadow contract (the untokenised half is legitimately one-off glow stacks), a border contract (257 of ~300 `1px solid` already use `--line-*`), a centering-idiom contract (flex vs grid+place-items is style, not drift).

## 4. The new contract tests

This repo enforces design rules with tests. Three new ones, plus two amendments.

### A. `green-contract.test.ts` — the headline rule, written last

Write it **after** steps 1-2, because it is only tractable once exactly one green name exists.

- Scan every rule body in `src/styles/*.css` for `--live` / `--live-rgb`.
- Fail unless the rule's `file:selector` is on a pinned allowlist, seeded with the 67 group-(a) rules and **shrink-only** — the same ratchet `important-contract` uses and `hit-target-contract.test.ts:98-106` implements, including its honesty test at `:108` ("a class that grew past the minimum must leave the list; a stale entry reads as 'reviewed and accepted' when it means neither").
- **Canary required:** `expect(greenRules.length).toBeGreaterThan(0)` — CLAUDE.md:673 documents this as the failure this repo keeps shipping.

**Do not derive liveness from the selector.** `.active` means "playing now" at `transcript.css:508` and "the tab you happen to be looking at" at `settings.css:143`. A pattern test would bless both. This must be a **token** rule with a human-curated list, not a selector rule.

### B. `icon-color-contract.test.ts`

Once step 3 lands: every rule whose selector matches a known icon-button family must set `color` from `--icon-rest` / `--icon-active` / `--icon-disabled`, and must not express disabled as a bare `opacity`. Same ratchet shape, same canary.

### C. Extend `design-tokens-contract.test.ts`

Two new `describe()` blocks in the existing file rather than new files:

- **Transitions.** Reject any timing function that is not `linear` or a `var(--ease-*)`. Reject any duration literal equal to a `--dur-*` rung, **normalising seconds to ms first** — that normalisation is the entire point, since `buttons.css:257-261` hides four such literals behind `0.35s`/`0.12s`.
- **Control height** (after step 12) and **gap** (after step 13): the radius-shaped "never writes a literal a token already names" check. Verify the `:root`-only premise for `--s-*` first, exactly as the radius block does for `--r-*`.

### D. Amend `focus-contract.test.ts` — it has a live hole

`focus-contract.test.ts:17-18`:

```js
const GREEN =
  /--accent\b|--accent-rgb|--ella-green|--color-accent-green|108,\s*255,\s*141|#6cff8d|#88f362/i;
```

It omits `--success`, `--ring-green` and `--stroke-green`. A `:focus` rule painting the identical hex through any of those three names passes today. No rule does yet — latent, not live — but a green-neutralisation pass could walk straight into it. After step 2, reduce the regex to the single surviving `--live` name and drop the stale `#88f362`, which exists nowhere in `src/` except that line.

### E. Register every new test

`contract-register.test.ts` asserts that CLAUDE.md's spelled-out count matches the table's row count and that every named test file exists. Each new contract needs: the test file, a row in the table at `CLAUDE.md:694+`, and `CLAUDE.md:659` bumped from "Fifty-nine".

## 5. Disagreements, and decisions only you can make

**Between the passes:** pass 3 (colour) and pass 4 (sizing/vocabulary) do not contradict each other — they cover disjoint categories and their overlapping facts agree (both record `.btn-primary` as already neutral). Pass 3's raw counts differ slightly from mine (`--ella-green` 15 vs 14, `--color-accent-green` 22 vs 20) because pass 3 counted across `src/` including `.tsx` and I counted `src/styles/*.css`. Not a disagreement. Group assignment of the 115 rules is pass 3's judgement, not a measurement; the genuinely debatable ones are the 18 success/outcome rules, the four `.active`-that-means-selected rules (`settings.css:143/277/318`, `palette.css:115`), and the four resize handles, which are legitimately group (b) on hover and group (a) while dragging **from the same declaration**.

**Between pass 3 and the repo:** pass 3 recommends neutralising the Fetch hover flare. `buttons.css:186-189` documents it as a deliberate exception under a *different* stated rule — "green marks the primary action and live states" — which commit `8071823` supersedes without deleting. That contradiction is unresolved in the tree and only you can settle it.

**Decisions:**

1. **Does green mark success, or only liveness?** 18 of the 67 group-(a) rules mean "finished / passed / approved", not "happening now". Strip them and the app loses its only success semantic; `.cp-status-chip.approved` (`review.css:907`) becomes an ordinary chip. Keep them and "green means live" is not literally true. A third option — a separate `--ok` token — costs one more name.
2. **Does Fetch keep its flare?** `buttons.css:186-189` says it is the only toolbar button that flares, precisely so it reads apart from Clear and Import. Neutralise it and the toolbar's primary action becomes visually identical to its neighbours; the fix is to give it the `.btn-primary` raised-neutral shape, which is what that pattern is for.
3. **"Controls are grey" — how grey?** There is **no light-grey surface token**. `--bg-5` `#403F46` (`tokens.css:19`) is the lightest surface the palette owns, and `.btn-primary` already uses `bg-4`/`bg-5`. A genuinely *light* grey chip on a `#0E0E10` canvas needs a new palette step and a re-decision of the raised-control language — the bevel insets at `tokens.css:86-96` are tuned for dark fills and will look wrong on a light one. Confirm which you mean: "lighter than the green" (already true) or "a light grey chip" (a redesign).
4. **Do `AVATAR_COLORS` lose their two greens?** `review.ts:789` contains `#2dd4bf` and `#34d399`. "Green means live" is not actually true until they go — and removing them changes existing users' assigned colours, which no CSS-scanning contract can see or enforce.
5. **Two new spacing rungs, or 99 rounded declarations?** `--s-1-5`/`--s-2-5` makes the scale 12 rungs and weakens its authority. Rounding is a visible redesign that should be reviewed on screen, not merged as a cleanup.
6. **Contrast risk you should price in now.** `#6CFF8D` reads ~14:1 on `--bg-1`; `--fg-4` `#86868F` reads 5.19:1 and `--fg-3` `#A2A0AA` 7.48:1. Every green *label* turned grey loses 2-3x luminance, and the ones sitting on their own tinted fill (`review.css:830`, `settings.css:320`, the queue status pill) are where it drops under 4.5:1. `tokens.css:41-48` records that exactly this class of miss was found only by pointing the sweep at a state it had never reached. Run `e2e/contrast.spec.ts` **and** `e2e/deep-state-contrast.spec.ts` after every batch, not at the end. Batch by **group** — all of (c) first, 15 of which are free no-op edits, then (b), then (a) — never by file, so each commit is one reviewable claim about meaning and can be reverted alone.

---

## Verified by hand, 2026-08-25

Added after a sweep prompted by a report of a square corner in an icon
overlay. The reported corner was NOT reproduced - see below - but the sweep
turned up one real inconsistency and confirmed several things are sound.

### The icon set has eight corner radii and no scale

`grep -oE 'rx="[0-9.]+"' src/components/Icons.tsx | sort | uniq -c`:

| rx | count |
|----|-------|
| 1 | 6 |
| 2 | 5 |
| 1.5 | 3 |
| 3 | 2 |
| 0.5 | 2 |
| 8 | 1 |
| 2.5 | 1 |
| 2.25 | 1 |

Eight values, chosen per icon. `2.25` and `2.5` differ by a quarter pixel at
a 24-unit viewBox and cannot be told apart at any size the app renders. The
radius tokens in `tokens.css` exist precisely so this kind of thing is picked
from a scale; the icon set does not use them because SVG `rx` is in viewBox
units rather than CSS pixels, so a token would need a viewBox-relative
counterpart. Worth one: three values (a hairline, a normal, a pill) would
cover every icon in the set.

No `<rect>` in the set is missing `rx` entirely, so nothing is fully sharp.

### Checked and sound

- Every control in the transcripts picker header computes a 6px radius:
  count pill 999px (a deliberate pill), view toggle, New project, search and
  sort all 6px.
- `.cp-annot-tool` (the drawing overlay's tool buttons) - 6px.
- `.cp-reader-row-thumb` - 6px with `overflow: hidden`, so its poster is
  clipped rather than overflowing square.
- A sweep of every `button`, `[role=button]`, `[role=radio]` and `[role=tab]`
  across the Library, Transcripts and Clip views, filtered to those with a
  visible background or border, found **zero** with a computed radius of 0.

### The four `border-radius: 0` rules are all deliberate

`.cp-lib-card-art` (the card does the rounding now), `.cp-lib-lrow` (a list
row is not a card), the popped-out queue drawer (it fills its own OS window),
and a 12px resize handle. None is an icon overlay.
