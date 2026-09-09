# Frontend conformance re-audit

Later September 7 correction scope and evidence are tracked in
`REVIEW-CORRECTIONS-2026-09-07.md` and `DESIGN-SYSTEM-AUDIT.md`. The checkbox-only
scope and counts below describe this earlier audit, not the full subsequent batch.
Unrelated keyboard and accessibility findings remain open.

2026-09-07 · current working tree, after the approved People/Preview fixes.

## Verdict

**The existing visual identity passes; the frontend does not yet conform to
all of its interaction rules.** This is not an AI-looking redesign problem.
Keep Nunito Sans, neutral controls, violet selection, panel geometry and the
intentional Generate/Export treatments. The material gaps are keyboard
ownership, accessible field feedback, popover behavior and incomplete checks.

This pass implements only the requested **catalog checkbox reduction from
16px to 13px**. Its associated label stays at least 26px high, with native
keyboard activation and visible focus. Production UI, playback, NDI, session
transport, saved data and DMG packaging are unchanged. Findings below are an
audited backlog, not authorization for a broad migration.

### Health assessment

| Dimension | Score / 4 | Evidence and limit |
| --- | ---: | --- |
| Accessibility | 2 | Named controls and reusable helpers exist; focused-button activation, group navigation, label and feedback defects are reproduced. |
| Performance | 3 | Provisional source assessment: no added framework and catalog excluded from production. No measured frame-time, memory or real-media benchmark in this pass. |
| Responsive layout | 3 | Minimum desktop and recent People/Preview matrix pass; a low-anchor History popover fails viewport containment. Not every populated screen was exercised at enlarged text. |
| Theming | 3 | Broad token consistency; three font shorthands and duration literals bypass guardrails. Contrast tests have explicit exclusions. |
| Product consistency / anti-patterns | 3 | Editing-specific vocabulary is intentional; a few misleading control names and catalog claims remain. No theme replacement is indicated. |
| **Total** | **14 / 20** | **Good foundation; address weak dimensions. Not an accessibility certification or release gate.** |

The scoring uses this product's **1100×700 desktop minimum** and documented
**24px target/spacing rule**, not a phone-layout or blanket 44px requirement.
Source counts and green tests do not establish that every state conforms.

**Open findings: 13 — 0 P0, 2 P1, 8 P2, 3 P3.** Priorities below distinguish
actual broken activation from incomplete composite navigation that still has
a Tab/click workaround. This refines the earlier combined keyboard finding.

## Coverage and evidence

Recursive inventory: **139 production TSX files** (including **20 nested
components**), **25 stylesheets**, **3,925 JSX sites**, **534 native-button
sites** and **2,858 CSS source preludes**. A separate CSS parse inspected
2,756 rules / 12,080 declarations. These are source sites, not rendered counts.

Production UI digest:
`f34b1945c418cdf019cd5dd4ec4a816025f80e9a56e3bd767bfcf7665f74fbca`.
Generate the inventory with `node scripts/design-catalog-audit.mjs --json`.
The digest was unchanged by this catalog/documentation-only update.

| Surface | Inspected / exercised | Limits |
| --- | --- | --- |
| Home and navigation | Source inventory, accessible-name sweep, minimum window, real-App Library-button Space/Enter probe | No OS file-drop/onboarding run |
| Library | Shared table/row controls, existing roving keyboard tests, no-bleed/contrast checks | No exhaustive populated resize/lasso/drag matrix |
| Clip | Toolbar/Sidebar/transport sources, Filename and invalid-mark probes, global shortcut boundary | No real export or media job |
| Review / Preview | Current People/Preview code, Volume component probes, reduced-motion pin CSS | Prior production People/NDI matrix remains valid evidence, not rerun here; no new real room/NDI test |
| Transcripts / nested components | Reader, Viewer, SearchBar, roster, History, actual Generate/Volume fixtures | No screen-reader session or real transcription job |
| Settings | Nine-tab minimum-window coverage, labels, real-App radio and native-checkbox keyboard probes | No native OS permission/device dialog |
| Dialogs / menus | Source inventory, existing focus tests, History keyboard/low-anchor probes | Not every nested popup state |
| Detached panels | PanelApp and connector/source inspection | No separate native-window sizing/focus run |

Fresh verification:

- **27/27 catalog browser tests**, including the two new native-checkbox
  tests at 100% / 125% text; visual inspection of the focused 125% specimen.
- **22/22 existing application browser tests** for names, Settings labels,
  Library keyboard navigation and popover focus.
- **25/25 additional application browser tests** for minimum size, Settings
  tabs, reduced motion, flat-surface contrast and sibling overlap.
- **115/115 style-contract tests** across 27 files; **6/6 catalog isolation
  tests**; app/catalog TypeScript and scoped catalog ESLint passed.
- Temporary production build: **65 artifacts**, with no catalog HTML,
  fixture code or styles. This is a frontend build check, not a DMG.
- Separate targeted mocked-App/component probes reproduced the defects
  below. The broad suites passing while these probes fail is itself a
  coverage finding; do not interpret the 74 passing browser cases as full
  conformance. The full 3,443-test frontend result belongs to the previous
  People/Preview batch, not a new full-suite run in this pass.

The contrast suite excludes imagery, gradients and faded content. Reduced-
motion and min-window suites exercise bounded fixture states. Native macOS
WebKit, VoiceOver, real-media timing and performance remain unverified here.

## Findings

### F01 · P1 · Playback shortcuts steal native button activation

**Accessibility / keyboard ownership.**
[use-keyboard-shortcuts.ts:275](../src/hooks/use-keyboard-shortcuts.ts#L275)
guards INPUT/TEXTAREA/contenteditable, but not buttons/selects. Dispatch at
324 reaches `preventDefault()` at 122 and does not respect `defaultPrevented`.

**Reproduction:** in Clip, focus the Library navigation button. Space leaves
Clip active; Enter opens Library. Native Settings checkboxes do work with
Space because INPUT is guarded. This is not a universal checkbox failure.

**Impact / recommendation:** keyboard users cannot reliably activate focused
commands, and claimed keys may also reach transport. Define the boundary for
interactive targets and already-handled events, while preserving explicitly
global commands and editing shortcuts. Test buttons, selects, radios, menus
and dialogs. Keep the recent local People/Preview protections. Follow-up:
`/impeccable harden`.

### F02 · P1 · Filename has no stable field label

**Accessibility / associated visible labels.**
[Sidebar.tsx:695](../src/components/Sidebar.tsx#L695) separates label and input;
the input's title at 716 is its current value, not its purpose.

**Reproduction:** the real input has `labels.length === 0`; no textbox is
named Filename. Its accessible fallback is the current filename and disappears
when cleared. The broad name sweep accepts a title and misses this defect.

**Impact / recommendation:** assistive-technology users lose the field's
identity, especially when empty. Associate label/input using a stable id and
`htmlFor`; retain the filename tooltip and validation separately. Follow-up:
`/impeccable harden`.

### F03 · P2 · Composite roles have incomplete keyboard models

**Accessibility / tabs, radios and menu behavior.**
[QueueDrawer.tsx:702](../src/components/QueueDrawer.tsx#L702) and
[SettingsModal.tsx:924](../src/components/SettingsModal.tsx#L924) keep all four
tab/radio buttons at tabindex 0; ArrowRight changes neither focus nor choice.
Related source gaps exist in ShareDialog:158, YouTubeSettings:182,
TranscriptReader:652, transcript/SearchBar:44 and SpeakerRosterModal:189.

[HistoryPopover.tsx:77](../src/components/transcript/HistoryPopover.tsx#L77)
advertises a menu but leaves initial focus on Tools. ArrowDown on the first
of two rows does nothing. **Escape already works**, as do Tab/Enter/Space.
TranscriptViewer Tools already uses `useMenuKeys` (1497); do not re-report its
arrow model as missing. Its trigger at 1824 lacks menu/expanded relationships.

**Impact / recommendation:** role-announced groups behave inconsistently;
Tab/click remains a workaround. Reuse tab/radio focus helpers for actual
groups. Sorting speakers is a choice, not a tab panel. Give History a complete
menu model or deliberately use a rich-list popover compatible with its nested
Remove actions. Preserve drawer dragging and mounted content. Follow-up:
`/impeccable harden`.

### F04 · P2 · Invalid mark feedback is visual only

**Accessibility / field errors.**
[Sidebar.tsx:645](../src/components/Sidebar.tsx#L645), also 669, applies an
invalid class without `aria-invalid` or an associated explanation.

**Reproduction:** entering `99:99:99:99` into Mark in gives the invalid style
but no invalid/error relationship. Users who cannot see the style are not
told what to correct. Associate concise format/range feedback without changing
normalization or persisted marks. Follow-up: `/impeccable harden`.

### F05 · P2 · Volume dismissal loses focus; trigger copy is misleading

**Accessibility / focus return and action naming.**
[VolumeControl.tsx:21](../src/components/VolumeControl.tsx#L21) closes on
Escape without restoring trigger focus; line 37 says Unmute while primary
click only opens controls.

**Reproduction:** focus the actual component's range and press Escape:
`aria-expanded=false`, `document.activeElement=BODY`. Restore trigger focus
on keyboard dismissal and name the opening action accurately. Preserve the
single audio control and existing mute behavior. Follow-ups:
`/impeccable harden`, `/impeccable clarify`.

### F06 · P2 · Generate can announce an old result while busy

**Accessibility / consistent asynchronous state.**
[GenerateButton.tsx:130](../src/components/GenerateButton.tsx#L130) reads
resolution directly, unlike its effective visual phase at 85.

**Reproduction:** actual component with `loading=true, resolution="error"`
has `data-phase="loading"`, `aria-busy=true`, but live-region text Failed.
This proves a component-contract mismatch, not its frequency in current jobs.
Use the effective phase for announcements; test retry/overlapping prop updates.
Do not alter its approved artwork or dimensions. Follow-up:
`/impeccable harden`.

### F07 · P2 · History can extend below the viewport

**Responsive / viewport-contained surfaces.**
[HistoryPopover.tsx:65](../src/components/transcript/HistoryPopover.tsx#L65)
clamps a top coordinate, not the full rendered height.

**Boundary reproduction:** actual component at 1100×700 with an anchor at
y640 / height26 renders top670, height360, bottom1030. This is a supplied
low-anchor case, not a claim the normal top toolbar always clips. Measure,
flip/clamp and cap the scrollable content to keep actions reachable. Follow-up:
`/impeccable adapt`.

### F08 · P2 · Detached notice Dismiss has an undefined recipe

**Product consistency / established command styles.**
[PanelApp.tsx:181](../src/PanelApp.tsx#L181) uses `.cp-btn`; no production CSS
declaration exists. Source-confirmed; native detached geometry was not tested.
Use the applicable existing command recipe and verify focus/hit area in a
detached window. Do not globally invent a new alias. Follow-up:
`/impeccable polish`.

### F09 · P2 · Comment-pin size animation ignores reduced motion

**Accessibility / reduced motion.**
[transport.css:568](../src/styles/transport.css#L568) retains 180–190ms width /
height transitions, with initials font-size animation at 581.

**Reproduction:** a browser-only comment-pin specimen using production CSS
keeps those computed durations while reduced-motion matching is true. Existing
checks sample Home transforms and animation shorthands, not these properties.
Suppress motion while preserving final hover geometry. Font-size animation is
a profiling candidate, not evidence of measured stutter. Follow-up:
`/impeccable harden`.

### F10 · P2 · Some catalog source-markup examples overstate production

**Product consistency / specimen provenance.**
[SpecialtyExamples.tsx:183](../design-system/SpecialtyExamples.tsx#L183)
labels source markup while its sort choices (162), Tools trigger (199), and
Text/Speakers tabs (215–228) improve semantics and keyboard behavior beyond
current production.

**Impact / recommendation:** a contributor can mistake a passing fixture for
an already-fixed app component. Explicitly label improved interactions as
proposals, or show faithful current behavior separately. Do not regress the
fixture or silently adopt its handlers. This audit records the discrepancy;
the checkbox-only edit does not repair it. Follow-up: `/impeccable document`.

### F11 · P3 · Font and duration literals bypass existing tokens

**Theming / traceable values.**
[transcript.css:696](../src/styles/transcript.css#L696), 857 and 1050 use
literal 12px / 11px font shorthands and one literal weight. The rename field
stayed 12px when `--text-md` was changed to 15px in a browser probe. The literal
80ms in [monitor.css:679](../src/styles/monitor.css#L679) duplicates
`--dur-instant`; multiline 190ms values in transport.css:569–570 are also
outside the ordinary token path.

**Impact / recommendation:** future token changes miss these controls. Use
equivalent existing tokens without visual resizing; explicitly document any
genuinely distinct timing exception. Do not mechanically normalize specialty
geometry. Follow-up: `/impeccable document`.

### F12 · P3 · Conformance checks miss real cases and count comments

**Maintainability / accurate design enforcement.**
[design-audit.mjs:93](../scripts/design-audit.mjs#L93) strips only same-line
comments; line 147 misses multiline durations and font shorthand. Its three
reported outliers are two comment-only colors plus the real 80ms duplicate.
[menu-keyboard-contract.test.ts:34](../src/lib/menu-keyboard-contract.test.ts#L34)
does not traverse nested component folders. Existing name tests accept a
value-only title; existing motion tests miss F09.

**Impact / recommendation:** green checks imply more coverage than they
provide. Parse declarations/comments and recurse directories; test computed
states and complete input sequences alongside source contracts. Freeze the
reproductions above into regressions when implementing each fix. Follow-up:
`/impeccable harden` on verification infrastructure.

### F13 · P3 · Older CSS comments describe retired primary colors

**Documentation / semantic color roles.**
[buttons.css:1](../src/styles/buttons.css#L1) and its Export comment near 95
still describe green primary commands, while the current rule is neutral.
Future AI/developer edits could reintroduce a retired treatment. Update prose,
not colors; retain the intentional Generate wash. Follow-up:
`/impeccable document`.

## Reconciliation and things to preserve

- People clipping, participant details access and theater prop/CSS parity
  remain **resolved**, supported by the previous actual-App matrix and fresh
  source review. Do not resurrect historical defects from a closed specimen.
- Passive Live and the neutral Premiere disclosure remain **adopted and
  correct**. They are not a reason to restyle transport, add audio controls,
  or change source/session behavior.
- The earlier Filename, tab/menu, Volume, detached Dismiss, Generate and CSS
  comment findings remain open, with new reproduction/precision above.
  History Escape and TranscriptViewer Tools arrow navigation are already
  implemented; only the remaining gaps belong on the worklist.
- Native checkbox activation, Library roving navigation, existing modal-focus
  helpers and specialty operation distinctions are positive patterns to keep.
  Detect speakers, the Speakers filter and Manage are different functions.
- Speaker roster sub-24px controls still require actual spacing measurements;
  neither this audit nor the smaller catalog checkbox authorizes blanket
  production resizing. The roster selection-color exception still needs a
  product decision, not an automatic violet rewrite.

## Systemic causes and ordered follow-up

Three boundaries explain most findings: global shortcuts do not consistently
yield to focused controls; source contracts are shallower than their labels
suggest; and illustrative catalog improvements can be mistaken for production.
The remedy is focused behavior contracts and honest provenance, not a new UI
framework or a full screen redesign.

1. **P1 — `/impeccable harden`:** F01–F02, then regress keyboard ownership and
   stable field names in the actual app.
2. **P2 — `/impeccable harden`:** F03–F06 / F09, with real tab/menu callbacks,
   error announcements, focus return, async phase and reduced-motion tests.
3. **P2 — `/impeccable adapt`:** F07; validate the full popup rectangle at the
   desktop floor and enlarged text.
4. **P2/P3 — `/impeccable clarify` / `/impeccable document`:** F05 copy and
   F10–F13 provenance/token guidance; strengthen the relevant checks alongside
   each adoption. Do not present approved catalog styles as already migrated.
5. **Final — `/impeccable polish`:** F08 and a small visual consistency pass
   after functional corrections, preserving approved geometry and specialties.

These can be implemented individually or together with user approval. Re-run
`/impeccable audit` after fixes. Profile actual large transcripts/review lists
and media workloads before proposing virtualization or claiming latency gains.
