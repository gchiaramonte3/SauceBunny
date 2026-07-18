> **STATUS (2026-07-18): SUPERSEDED.** The "lines win" decision below was
> reversed the same week: the user chose the TONE-CARD grammar instead
> (uniform bg-1 cards, r-lg radius, 4px half-gap gutters, no borders —
> tone does the separation; modeled on Claude Code's desktop UI). See
> `_design/prompts-ui-polish-v3.md` and the shipped shell/sidebar/library
> CSS. This document stays as the record of the road not taken; sections
> 2+ (Clip panel defaults, gray-placeholder thumbs) DID ship.

# Plan: one design language (lines), Clip panel defaults, YouTube gray-placeholder thumbs
2026-07-17 · follows d8f2411

## 1. The design-language decision: lines win, curves become content-only

Diagnosis. The app has two dialects. Home/Library (v2/v3) speak LINES:
flat surfaces on bg-0/bg-1, --line-1 hairline separations, density, quiet
chrome. The Clip view still speaks the older CARD dialect: sidebar, drawer,
and logs render as inset rounded panels (r-lg radii, borders on all four
sides, gaps between panel and window edge) — three floating curved slabs.
That is why it "doesn't jive": the eye reads Home/Library as one continuous
surface but Clip as three objects sitting ON a surface.

Decision (the user's lean, endorsed): the STRUCTURAL chrome goes line-based
everywhere; radii survive only on CONTENT and CONTROLS. Concretely:
- Panels (Clip sidebar, right drawer, logs sheet, Library tree/detail):
  full-bleed to the window edges, zero radius, separated from neighbors by
  ONE --line-1 hairline (border-right on the sidebar, border-left on the
  drawer, border-top on logs). No outer borders, no inset gaps, no panel
  shadows.
- Curves stay ONLY on: buttons/inputs (r-sm/r-md), cards/posters (r-md),
  the video monitor surface itself, modals/popovers (floating = allowed to
  be objects), chips/keycaps. This matches what Lore/Spotify actually do:
  square chrome, rounded content.
- Implementation is CSS-only: sidebar.css, queue-drawer.css, logs panel css,
  monitor.css seams; delete the panel radius/border/gap/shadow tokens usage,
  audit with a grep for r-lg on structural containers. Verify no layout
  shift breaks the drag-resize handles or the screening overlay.

## 2. Clip panels: open when you arrive
Entering the Clip view (nav click, ⌘3, or any import/open that routes there)
OPENS the left sidebar and right drawer every time. In-session toggles still
work (collapse to focus), but arriving at Clip always presents the full
workbench — the panels are the page. Implementation: navigateView("clip")
and the load-core setActiveView("clip") wrappers call the raw setters
(setSidebarOpen(true) / setQueueOpen(true), NOT the persisting choice
wrapper). The persisted preference becomes session-scoped memory only;
delete the localStorage reads or leave them as within-session defaults.
The logs sheet stays closed (it is a diagnostics overlay that covers the
timeline, not part of the editing layout) — flag if disagreed.

## 3. The gray YouTube thumbnail (screenshot: Gilmour card)
That gray rounded-rect with three dots is YOUTUBE'S OWN "no thumbnail"
placeholder image. i.ytimg serves it with HTTP 200 for some
maxresdefault/hqdefault misses — so the <img> onLoad fires, onError never
does, and the v3 candidate-walk (maxres → hq → placeholder) never advances.
Fix: advance the walk on LOAD too, when the loaded bitmap is the known
placeholder: onLoad, if img.naturalWidth <= 120 (the placeholder is 120x90;
every real maxres/hq is >= 480/320) treat as a miss and try the next
candidate. Apply in BOTH LibraryCard's remote branch and LibraryHero's
backdrop walk. Cheap, no network probing, no new state beyond the existing
candidate cursor.

## Order
3 (bug, minutes) → 2 (behavior, small) → 1 (CSS sweep, the real work).
Gates as always; one commit per item.

## REVISION v2 (Claude-frontend inspiration — supersedes section 1's "all lines")

Claude Code's own UI is the model that lets BOTH dialects coexist, by ROLE:
- NAVIGATION + PRIMARY CONTENT are flat and open: the left sidebar is
  full-bleed, borderless, separated by TONE (slightly different bg) and
  spacing — almost no hairlines; the chat column is borderless open canvas.
- TOOL PANELS are soft rounded tone-cards: Terminal and Background tasks
  are inset rounded panels (bg one step lighter than the page, radius,
  small consistent gaps from the window edges, NO visible borders), each
  with a quiet header row: small title left, icon actions right.

Mapping onto Sauce Bunny:
1. Flat/nav tier: nav rail, Home, Library tree + grid (keep hairlines ONLY
   inside dense lists where tone can't separate rows).
2. Tool-card tier (Claude Terminal grammar): Clip's source/export sidebar,
   the queue/review drawer, the logs sheet, Library's detail panel. Restyle
   the EXISTING curved panels instead of deleting them: bg-1 tone on the
   bg-0 page, one consistent radius (r-lg), consistent 8-10px inset gaps,
   REMOVE the borders (tone does the separation; keep at most a 1px inner
   line-1 on scroll areas), and give every panel the same header row
   pattern (11px 600 title left · icon buttons right) like "Terminal +".
3. The monitor + timeline stay the open flat center (the chat column).

Why this fixes "not jiving": today's panels mix borders+radius+edge-attach.
The Claude grammar keeps the curves the user likes but makes them read as
one deliberate system: tone-cards on an open page, uniform radius, uniform
gaps, uniform headers. Library keeps the density the user likes because
hairlines remain the in-list separator.

Sections 2 (panels open on Clip entry) and 3 (YouTube 120x90 placeholder
detection on load) unchanged. Order: 3 → 2 → 1.
