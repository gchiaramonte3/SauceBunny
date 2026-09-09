# Application-to-design-system audit

## NDI clear-viewport correction (2026-09-08)

The program viewport no longer hosts the source/status chip or playback-recovery
button. Source details and recovery render in the gear-launched NDI settings
dialog; Not shared / Shared with room / Sharing stopped and the centered
sequence-timecode availability window sit in normal flow above the picture.
The transport keeps timing availability and Premiere playback ownership on one
line. File Shortcuts/marking hints are absent only during live input.

Narrow Preview was inheriting Clip's floating-drawer rule, covering the picture
and gear. Preview now retains the docked notes rail; Clip keeps its existing
responsive behavior. Covered empty-file onboarding is hidden while the live
decoder awaits its first frame. No file player is reset or replaced.

Guest settings permit local playback recovery without offering source-changing
or marker controls, and perform no source discovery. Recovery still calls the
selected video directly; settings close/reopen does not reconnect or clear it.
No physical-audio or verified sequence-timing claim follows from this UI fix.

## NDI settings placement correction (2026-09-08)

The source inspector no longer consumes space inside the shared sidebar.
Production now opens NDI settings in a portal dialog from the existing utility
gear beside the single volume control. The original drawer, comment draft,
player and source state stay mounted. Marker setup and Reconnect picture have
12px separation; the standalone Preview header has 12px padding and separation
from the monitor. Setup shortcuts close the NDI dialog before opening Settings.
The earlier inline-inspector placement described below is superseded.

Verified against production components: TypeScript, scoped ESLint, 39 focused
component/style tests, and 19 browser cases passed. Browser coverage includes
1100×700 and 1680×1020 at 100% and 125% text, long source names, keyboard focus
trapping/return, reduced motion, persistent drafts and drawer geometry, source
callbacks, single audio control, and synthetic native-encoder media decoding.
These results resolve the reported placement and spacing defects in source.
They do not prove actual Premiere audio output: the running native app has not
been restarted, and the editor still reported silence in the preceding build.
Actual speaker output, jitter, guest delivery and verified sequence timing remain
open. Unrelated audit findings remain unchanged.

Final broad verification: `npm run verify` passed all gates, including 3,519
frontend tests (two existing skips), 471 Rust tests (20 ignored), 11 Swift tests,
362 application browser cases, TypeScript, lint, Clippy and license checks.
The catalog separately passed typing/lint, six isolation tests, 33 browser
cases and production-build exclusion (65 artifacts). The initial run exposed
closed-dialog DOM conflicting with existing dialog checks. The final component
keeps source-selection state but removes the portal while closed, and the
original modal contracts now pass without alteration. Logs are in
`/private/tmp/sauce-ndi-settings-verify-final.log` and
`/private/tmp/sauce-ndi-settings-catalog.log`.

## Evening screenshot corrections (2026-09-07)

Scope and remaining gates: `REVIEW-CORRECTIONS-2026-09-07.md`.
Production UI corrections now cover Hide drawing/proximity suppression, portalled
reaction/emoji menus, unclipped green Post, compact People without camera/mic chrome,
onboarding without Review links, transcript Remove/confirmed Trash, deep-violet
Expected speakers, a flat Preview empty surface, normal live-note typography,
explicit green Share with room, incoming-aspect monitor sizing, and an honest
unavailable timeline-timecode status. The real single Clip volume control and
Settings-based Premiere setup/diagnostics are preserved from the earlier batch.

Verification against this working tree:

- TypeScript and scoped ESLint passed.
- 3,501 frontend tests passed; two existing tests skipped.
- 31 focused application browser tests passed, including 1100/1680 People,
  125% text, no clipped Post, reaction/emoji focus return, transcript removal and
  Trash cancellation/focus, portrait input geometry, source swaps without player
  remount, and native-fixture H.264/AAC decoding with nonzero stereo PCM.
- 33 catalog browser tests, catalog typing/lint, six isolation tests, and the
  production-bundle isolation check passed (65 production artifacts, no catalog).
  The recursive inventory covers 147 production TSX files and 26 stylesheets.
- Two native transcript Trash checks passed, including a real recoverable move
  of one generated temporary SRT and retention of source-video/analysis fixtures.
  No user transcript or media was removed. Failed bulk members remain retryable.

These resolve the reported UI defects in production code under automated testing,
not the running older application's end-to-end NDI issues. Actual Premiere speaker
output, jitter/scrubbing, live host/guest behavior, and verified displayed-frame
sequence timecode are **still open**. The companion protocol does not currently
provide a sequence-clock stream. An unavailable label does not resolve that feature.
The current fixed encoder raster can also letterbox mid-capture aspect changes.
Do not close these gates or mark the entire goal complete from this test evidence.

The NDI-enabled debug executable builds without bundling. The active-room app
bundle has not been replaced or restarted, and no DMG is produced by this batch.

## Premiere workflow correction in progress (2026-09-07)

User-authorized follow-up: the source inspector has spaced source controls,
a yellow Beta badge, and a real shortcut to Settings → Integrations. Setup
instructions and receiver counters no longer appear as Preview disclosures.
Connect Premiere triggers discovery even if already open; scans retain an
explicit missing-source choice and never publish or clear the last picture.

The original Review / Transcript / AI Summary / Queue drawer is available
in Premiere Preview and live rooms. Source controls occupy a bounded area
above it; closing them does not change the visible source. Private solo
notes use the Premiere review identity. Room-private browsing remains blocked
from posting to an unrelated shared source, with explicit Return to room.
Session setup remains reachable without restarting the preview or losing notes.

Live inputs omit irrelevant file Play/step/mark/speed/caption/snapshot commands.
Preview source enables local monitoring, and a positive volume change unmutes
the existing audio control. Its tooltip now describes opening controls and
Escape returns focus. Browser autoplay rejection has an explicit retry.

Verified so far: 3,497 frontend tests (two skipped), TypeScript, scoped lint,
and 16 focused application browser cases including native H.264/AAC capture
decoding with nonzero measured left/right PCM, retained media nodes, tab/draft
behavior, Settings routing, room/file return, and People geometry. These
results do not yet prove the updated application against a running Premiere
sender, actual speaker output, or live companion marker insertion. Keep those
acceptance items open; no DMG has been produced for this correction.

Native recheck: the installed SDK/Tools 6.3.2, Premiere 26.3.2, Adobe NDI
output plugin, host runtime, Video Monitor and local-network declarations pass
the read-only preflight. The running development app is still the September 7
08:26 bundle, older than these changes. Its live accessibility tree confirms
the old monitor audio toggle/connection disclosure and missing drawer tabs.
It has an active review room, so do not replace or restart it without the
user's approval. Test the updated executable before attributing the old
running app's behavior to the new source.

The NDI-enabled debug executable subsequently compiled successfully with
`SAUCE_NDI_SDK_DIR='/Library/NDI SDK for Apple' npx tauri build --debug --no-bundle`.
An inconsistent `objc2-foundation`/`iroh` dependency cache required a scoped
`cargo clean -p` of those two packages before retrying. The running `.app`
bundle was not replaced, restarted or repackaged. Native testing of the new
executable awaits permission to interrupt the existing review room.

## Finder clip indicator correction (2026-09-07)

Separately approved: clip grids now show an 8px dot before the filename below
the artwork; lists replace the inline filename dot with a 2px far-left stripe,
inset 4px vertically. `ClipTagIndicator` shares the existing Finder palette and
primary-tag selection. All tag names remain in tooltips/accessibility descriptions.
Library, Home/local recent cards and downloaded web cards/rows receive media-file
tags. Remote-only sources, transcript/session artifacts and folder styling do
not gain clip colors. No new tagging workflow or persistence migration.

The missing grid indicator is resolved (the card previously received tags
only for its menu). A related bulk-read cancellation defect is also corrected:
equivalent array rerenders no longer cancel an in-flight tag read without a
replacement. Successful native writes notify other mounted views of that file.
The seven-color palette, custom labels and existing Finder writes are retained.

Verification: 11 focused actual-App browser cases cover clip geometry at both
desktop sizes and 100%/125% text, Home/cache identity, external-refresh/write
rollback, and unchanged folder menus/tints. Nine native tests include real
temporary-file xattr reads/writes for all seven colors, preserving media bytes,
clearing tags, surviving a rename and reporting a missing-file failure. This verifies Finder's
storage format, not an automated Finder-window or VoiceOver session.
Catalog checks cover the four new geometry cases alongside existing fixtures;
catalog assets remain excluded from production. Unrelated findings below stay open.

Final automated results: 3,492 frontend tests passed (two skipped), 79 focused
clip/list/keyboard/selection/drag browser tests plus five folder-color browser
tests, and 32 catalog browser tests. App/catalog TypeScript and scoped ESLint
passed. The isolated production-build check inspected 65 artifacts with no
catalog code/styles/HTML. No DMG was rebuilt.

## Saved-session navigation correction (2026-09-07)

Separately approved after the catalog adoption: Library session context menus,
double-click and Enter now open a read-only saved-session reader, not the JSON
record in Finder. The reader retains source context and session-specific guest
notes/replies without requiring video or Premiere. Known Premiere/other NDI
sources have distinct neutral badges; manual timecodes remain unverified.
Copy session name is available; source opening is explicit inside the reader.
Search placeholder width and the Notes sort label are corrected on this shelf
only. The existing playback stage and live-session controls are untouched.

Verified with actual frontend/browser fixtures at 1100×700 and 1680×1020,
normal and enlarged text: search fit, right-click and grid parity, Enter,
Escape/focus return, guest-note scoping and no media/room commands on archive
open. Full repository verification passed: 3,477 frontend unit tests and 336
browser cases (two unit and three opt-in media cases skipped), plus the native,
Swift, lint and license gates. These are automated-shell results, not a native
Premiere test or a code-review sign-off. No DMG was rebuilt for this correction.
The unrelated design-audit findings below remain open as previously recorded.

**Latest frontend conformance pass:** [DESIGN-FRONTEND-AUDIT.md](DESIGN-FRONTEND-AUDIT.md)
(2026-09-07, after People/Preview adoption). It records fresh browser probes,
the smaller catalog checkbox, current inventory and remaining production
defects. The original findings/counts below are retained as historical
evidence; use the latest report for the current backlog and severity.

2026-09-07. Scope: current working tree, including uncommitted work. This is
an audit and catalog improvement, followed by the explicitly approved limited
People/Preview adoption below. It is **not approval for an application-wide
restyle**. Playback engines, NDI/session protocols, stored data and packaging
are unchanged.

## Adopted People/Preview batch

The user approved these two pictured corrections in both production and the
catalog. Production now clips only participant pictures; role/media indicators
and self-device controls are outside the mask. A named details trigger supports
click, Enter/Space and context-menu access with a viewport-contained portal.
Theater receives the same presenter and self-device props as the side rail,
and automatic compact rules exclude theater.

Preview now uses passive neutral `.cp-source-status` and the sentence-case
26px-minimum `.cp-toolbar-disclosure`. File timecodes and specialized transport
geometry are unchanged. The Premiere trigger names its panel with
`aria-controls`; local Space handling preserves native activation without
changing global playback shortcuts. The catalog's previous faulty examples
are collapsed historical evidence, not current recipes.

Verification for this batch: actual-App People geometry/keyboard/theater tests
at 1100×700 and 1680×1020 with normal/125% text; nine NDI browser regressions,
including three existing native H.264/AAC capture-fixture tests; 25 catalog
browser tests; six isolation tests; TypeScript, focused ESLint and the frontend
suite (**3,443 passed, 2 skipped**). The browser totals are four People,
nine NDI/Preview and 25 catalog cases. A temporary production build checked
**65 artifacts**, with no catalog entry, fixture code or styles included.
Native capture-fixture decoding is not a running Premiere/remote-session
soak or evidence of improved NDI latency. No DMG was built.

## Verdict

Keep the existing visual identity. The app already has a substantial token
system, specialized controls and useful interaction helpers. The main system
gap was an incomplete, sometimes misleading catalog: a generic-looking
specimen could be mistaken for the actual component it purported to preserve.

The familiar desktop editing vocabulary passes the product anti-pattern
check. Nunito Sans, dark surfaces and intentional Generate/Export treatments
are not defects. Inconsistent action/status recipes and misleading specimen
labels are the problems, not a need for a new theme.

### Initial catalog-only assessment and limits

| Dimension | Source-review score / 4 | Evidence and limitation |
| --- | ---: | --- |
| Accessibility | 2 | Good native controls and shared focus helpers; remaining participant keyboard, tab/menu and label-association gaps. Not a WCAG certification. |
| Performance | 3 | Catalog has no UI framework or production entry; reviewed component imports are presentational. Production rendering and animation cost are not comprehensively profiled, so this is a provisional source assessment, not a speed benchmark. |
| Theming | 3 | Existing token contracts, neutral primary, violet selection and semantic color are retained; some role comments and local recipes disagree. Dark desktop product; no invented light-theme requirement. |
| Responsive layout | 2 | Compact People masks and theater selectors have concrete defects. Catalog desktop/enlarged-text checks do not prove every production panel fits. |
| Product consistency | 3 | Strong existing editing vocabulary; status vs action and specialty vs generic boundaries need explicit rules. |
| **Total** | **13 / 20** | **Acceptable, with significant targeted work remaining.** |

The responsive assessment uses this app's 1100×700 desktop minimum and its
documented 24px pointer-target/spacing rule. A lack of phone layouts or 44px
mobile controls is not reported as a defect. Numeric source counts are not
rendered-instance counts or evidence of accessibility compliance.

## What this pass corrected in the catalog

| Finding | Priority | Resolution in this milestone |
| --- | --- | --- |
| A bare `.cp-gen-btn` omitted the real specialty component | P1 | Import `GenerateButton` with fixture props: three sparkle paths, exact labels, layered loading/progress and Done/Failed states. No transcription calls. |
| Every Current example claimed to be the actual implementation | P1 | Add explicit component/markup/schematic/mixed provenance. Proposed examples remain clearly unadopted. |
| Speakers was missing as a family of distinct controls | P2 | Add a Specialty entry for checkbox/select, library filter, viewer actions, detection, identity and roster patterns. Do not conflate speakers with room participants. |
| Keep comparisons could imply replacing production with a different sketch | P2 | Use related-example labels for complementary patterns; retain a source-markup table reference and label schematic behavior demonstrations separately. |
| Developer and AI entrypoints lacked a clear route to the catalog | P2 | Add root `AGENTS.md`, plus links and precedence in `CLAUDE.md`, `README.md`, `CONTRIBUTING.md` and the design rulebook. |

These five findings concern the catalog and documentation, not broken
production transcription or exports. The system now has 20 named families,
including a visible Specialty group. Export and Fetch also render the actual
`StatefulButton`, rather than generic lookalikes. Their real job handlers are
never imported into the catalog.

## Whole-application coverage

The recursive scanner covers **139 TSX files, 25 CSS files and 3,898 JSX
source sites**, including **530 native button sites**. It traverses nested
component directories and reports source locations, dynamic roles and a
digest. Run `node scripts/design-catalog-audit.mjs --json` to reproduce it.

Inspected production UI digest:
`ce9d0434f302ceb97aaa480eaf996f1abe21e16a042526a745bd0ad0328ce949`.
The source digest identifies this review's baseline; a different digest means
recheck relevant findings, not that a change is automatically wrong.

| Surface | Source inspected | Catalog coverage | Still needs production-level validation |
| --- | --- | --- | --- |
| Home | App home branch, LibraryView, WelcomeScreen, NavRail and shared buttons | Typography, navigation, actions, empty/loading states | Real onboarding and file-drop states |
| Library | LibraryBrowser, LibraryBrowserBar, LibraryTree, LibraryListRow, FrameListRows, WebListRows, ReviewSessionsPane | Grid-table source markup, selected rows, long names, menus, navigation, fields | Real resize/lasso/reorder, image-overlay controls, empty-floor behavior in all four tables |
| Clip | Toolbar, Sidebar, Monitor, Transport, Timeline | Actual Generate/Export/Fetch; source controls, native options, editing exceptions | Full transport/marks geometry and real job interactions remain production tests |
| Review / Preview | CoReviewLobby, PeoplePanel, ReviewPanel, NdiInputPanel, SourceShareMenu | Setup controls, participant variants, passive Live, Premiere disclosure, notes/status recipes | Actual People state wiring, reactions/composer combinations, media-backed room layouts |
| Transcripts | TranscriptReader, TranscriptViewer and nested transcript components | Speakers filter, detection/configuration, Manage/insights, roster fixture, tabs, menus | Full cast/merge/assignment workflows, slash-command suggestions and cue selection |
| Settings | SettingsModal and area-specific controls | Native fields/selects, choices, tabs, confirmations | Every nested device/model/error combination |
| Dialogs and menus | ShareDialog, RenameDialog, nested review/transcript sheets, common focus helpers | Surface tiers, focus/dismiss demonstration, menu and dialog fixtures | Every real opening/closing path and portal edge position |
| Detached panels | PanelApp and QueueDrawer connectors | Source references, dense utilities, tab/panel recipes | Actual separate-window sizing, action notices, drag states and focus return |

This is whole-app **source discovery with representative examples**, not a
claim that every state of every screen has been rendered. Exact component
reuse is preferred when safe. Container components that load files, native
devices or application stores are documented or excerpted, not imported into
the design page. No mock screen should overwrite a real screen merely
because it is shown in the catalog.

## Specialty rules and source evidence

- [GenerateButton](../src/components/GenerateButton.tsx) owns only rendering
  and the resolution callback timer. [Sidebar](../src/components/Sidebar.tsx),
  around lines 517–585, owns the quiet Detect speakers checkbox, expected
  count and exact combined/transcript/retry/rerun labels. Preserve its green
  brand wash, three sparkles and `.cp-source-action` context.
- [StatefulButton](../src/components/StatefulButton.tsx) takes a parent-owned
  phase. Sidebar around line 827 uses the violet Export recipe; Toolbar
  around line 159 uses Fetch with an empty loading label and 86px width lock.
- [TranscriptReader](../src/components/TranscriptReader.tsx), around line
  536, uses **Speakers** as an `aria-pressed` filter. It is not a roster
  launcher. [TranscriptViewer](../src/components/TranscriptViewer.tsx), around
  line 2032, uses **Manage** for the roster, with a separate passive count.
- [SpeakerRosterRow](../src/components/transcript/SpeakerRosterRow.tsx) has
  separate identity color, editable name, selection, talk time and preview
  actions. The catalog uses local markup fixtures; it does not open a saved
  roster or pretend the whole cast/merge workflow is implemented there.
- Production library rows are grid-based, with 12px text, 27px geometry,
  subtle stripes and an empty-floor pattern in
  [library.css](../src/styles/library.css), around lines 1252–1415. A new
  semantic HTML table using strong solid alternating fills is an illustrative
  behavior example, not a faithful replacement for those production styles.

Detailed APIs, recipes and ownership live in
[DESIGN-CATALOG.md](DESIGN-CATALOG.md#specialty-component-recipes). The 30px /
26px command prototype is not a mandate for Generate, Export, transport,
speaker identity chips or imagery controls.

## Tracked production findings

The original eight findings were **3 P1, 4 P2, 1 P3**. Two are now resolved;
six remain open (**2 P1, 3 P2, 1 P3**), with the participant portion of the
keyboard finding resolved. No P0 was established. Descriptions below preserve
the original evidence; status notes take precedence over historical wording.
These are source-confirmed findings or, for compact clipping, corroborated by
the user's screenshot. Fresh full-application browser reproduction remains
part of each implementation batch.

### P1 · Compact People clips meaningful state and controls

**Resolved in the approved People/Preview batch.** Production browser checks
verify the 72px rail, 48px picture, outside indicators, 24px device hit areas,
simultaneous state, long names, keyboard details and preserved monitor identity.

Location: [room.css](../src/styles/room.css), around lines 470–500;
[PeoplePanel](../src/components/PeoplePanel.tsx), around lines 301–333.
The circular 48px picture mask also contains full Presenting/Sharing text and
self controls. The reported screenshot shows the Presenting label cut off;
presenter/attention states also compete for space. This hides role/device
information, not just decoration. Separate the image mask from the chrome,
with an accessible details action and independent indicator slots. Verify
overlap and targets with all simultaneous states. Suggested follow-up:
`/impeccable adapt` on People, after recipe approval.

### P1 · Keyboard contracts are inconsistent for participants, tabs and menus

**Partially resolved.** Participant details now support pointer and keyboard
access to real actions, Escape and focus return. Tabs and nested HistoryPopover
remain open, unchanged findings; this batch is not a broad keyboard migration.

Location: PeoplePanel around line 281; QueueDrawer around line 702;
TranscriptReader around line 652; ShareDialog around line 158;
[HistoryPopover](../src/components/transcript/HistoryPopover.tsx), around
lines 60–142. Remote participant actions are attached to a non-focusable
context-menu div. Several tablists lack the arrow-key/roving-focus model.
History rows support Tab/Enter/Space and dismissal now, but lack menu arrow
navigation; do not report the already-fixed Escape issue again.

Users cannot consistently discover or operate these controls with a keyboard.
Use the existing focus/menu helpers, associated tabs/panels and a real
participant details trigger. Preserve tab dragging and child buttons. WCAG
2.1.1 is relevant to inaccessible participant actions; ARIA tab/menu patterns
define the expected navigation. Suggested: `/impeccable harden`.

### P1 · Filename's visible label is not associated with its input

Location: Sidebar around lines 695–700. `<label>Filename</label>` is adjacent
to a separate input with no matching id/htmlFor or accessible name. Screen
reader users lose the field's purpose; this concerns WCAG 1.3.1/3.3.2.
Associate the label and input, preserving existing filename validation and
export naming. Suggested: `/impeccable harden` on fields.

### P2 · Theater receives different participant truth

**Resolved in the approved People/Preview batch.** Actual-App tests verify
presenter identity, self-device state/actions and 168px-wide 16:9 pictures at
the 1100px floor and larger widths. Expanded and compact CSS no longer leaks
into the theater strip.

Location: [App](../src/App.tsx), around line 5489, compared with the PeoplePanel
call around line 4803. Theater omits presenter and self-device props;
PeoplePanel defaults presenter to `m0`. The 1100px compact selector also
matches theater before strip sizing, allowing mixed geometry. Presentation
handoff or device state can look different solely because of the layout.
Pass the same participant state into all variants and scope compact CSS.
This needs a correctness fix as well as visual adaptation.
Suggested: `/impeccable harden`, then `/impeccable adapt`.

### P2 · Volume's tooltip describes a different action

Location: [VolumeControl](../src/components/VolumeControl.tsx), around lines
38–43. Muted state says “Unmute” in the tooltip, but primary click opens the
popover; right-click performs mute toggling. Keep the single existing volume
control and clarify the trigger's actual action, with consistent visible and
accessible names. Suggested: `/impeccable clarify`.

### P2 · Detached Dismiss has an undefined control class

Location: [PanelApp](../src/PanelApp.tsx), around line 181. Action-notice
Dismiss uses `cp-btn`, which has no production stylesheet declaration. The
action misses the normal control recipe. Adopt the approved existing command
class in a detached-panel batch, then verify its target and focus.
Suggested: `/impeccable polish` on detached notices.

### P3 · Historical CSS comments contradict current color rules

Location: [buttons.css](../src/styles/buttons.css), opening comment and Export
comment around line 95. They still refer to a green primary action even
though `.btn-primary` is neutral. This can mislead future AI/developer edits.
Correct comments in a scoped source-documentation pass; do not restore the
retired green primary or remove the deliberate Generate wash.
Suggested: `/impeccable document`.

### P2 · Generate can announce a stale result while visually loading

Location: GenerateButton around lines 85 and 130–131. Its visual phase makes
loading take precedence over an old resolution, but the polite live region
reads the resolution directly. `loading=true` with `resolution="error"` thus
renders a busy button while leaving “Failed” in its announcement. This is a
component-contract mismatch, not evidence that every current caller triggers
it. Align the live announcement with the effective phase in a scoped fix and
test rapid retry/overlapping prop updates. The catalog supplies consistent
props and does not silently patch the production component.
Suggested: `/impeccable harden` on async state accessibility.

### Specialty items requiring a decision or measurement

The roster's 13px checkbox, 20px color action and 22px play action are visible
in `transcript.css` around lines 1246–1286. Small geometry alone does **not**
prove a WCAG target failure: the documented spacing exception must be measured
in the real roster. Existing hit-target tests explicitly track the latter
two. Preserve them in the source-markup fixture and record the measurement
before growing targets, which could otherwise overlap.

The picked roster row uses a neutral translucent fill while the general list
selection rule calls for violet. Decide whether this composite editing row is
an intentional exception or selection drift; do not recolor it during the
catalog audit. Nested `SearchBar.tsx` and `SpeakerRosterModal.tsx` also declare
tab roles without a complete tab keyboard model, extending the keyboard
finding above. The catalog's working fixture interactions are not proof those
production behaviors were fixed.

## Reconciliation: preserve earlier fixes

The older [DESIGN-AUDIT.md](DESIGN-AUDIT.md) is a historical record, not an
executable backlog. Its dated reconciliation and this source review take
precedence over old suggestions and counts.

Confirmed improvements to retain: neutral primary controls, native select
density variants, danger-text tokens, explicit toast dismissal, continuous
table striping/column rules, shared dismissal helpers and the consolidated
speaker-management modal. Do not redo old green-primary, whole-toast-dismiss,
per-row merge or blanket spacing-normalization proposals.

## Verification and remaining performance work

Catalog verification is run through `npm run check:design-catalog`: strict
TypeScript, scoped Hooks lint, recursive source inventory, transitive pure-
import/isolation checks, browser interaction/geometry checks and a temporary
production-build exclusion check. Specialty tests exercise real phase markup,
sparkles, native configuration, filter state and keyboard behavior. Normal
and reduced-motion specimens are checked separately.

Production source is fingerprinted before and after this task. No new runtime
UI dependency is introduced. The catalog is excluded from the production
entry/bundle; a frontend verifier build is not a DMG build.

Completed verification for the initial catalog-only pass (before adoption):

- Frontend suite: **3,432 passed, 2 skipped**, including six catalog isolation
  and source-coverage tests. Existing jsdom canvas/media warnings remain;
  those mocks are not real-media validation.
- Catalog browser suite: **24 passed**, covering both desktop viewports,
  normal/125% text, normal/reduced motion, specialty geometry, speaker dialog
  text parity, keyboard behavior and source-table stripes/clipping.
- Catalog TypeScript and scoped ESLint: passed.
- Temporary production build: **65 artifacts checked**, no catalog HTML,
  fixture code or styles included.
- **796 production files** fingerprinted before/after: unchanged.
- **62 repository documentation links** checked: no missing targets.

Rendered screenshots are written under `test-results/design-catalog/` by the
browser suite. These are development artifacts, not a shipped UI migration.

Performance follow-up must measure, not infer: Generate has per-letter
animation and shadow/filter work; rich transcript/review lists and hidden
panels need representative interaction traces before virtualization or broad
memoization. Measure active/hidden animation cost, comment/cue interaction
latency and rendering under enlarged text. Passing CSS contracts does not
prove smooth frames. **NDI latency, real-media A/V sync and session throughput
were not measured in this design milestone.**

## September 8: Premiere Settings alignment

Replaced browser-default Premiere headings/body text with the existing Settings
title, introduction, status-row and disclosure recipes. Installation actions now
use standard sentence-case buttons; runtime/version metadata lives in Connection
details. Companion setup and timing diagnostics use the same disclosure treatment.
Changes are scoped to integration setup, not transport or generic compact buttons.

Verification: 64 focused component/design-contract tests and TypeScript/scoped
ESLint passed. Five production-component browser tests passed, including General
versus Integrations computed typography, keyboard disclosure behavior, long runtime
strings, 1100×700 and 1680×1020 layouts at normal/125% text, and unchanged private
Preview navigation. Screenshot inspection confirmed the narrow/enlarged layout.
Opening Settings does not start capture, pairing, installation or publication.
The local debug app was rebuilt and reopened; its bundled executable matched the
new binary. Native Settings inspection confirmed the adopted General/Integrations
hierarchy and companion controls. No Premiere settings were changed and no DMG
was produced. These checks do not resolve the separate real-media audio/timing
acceptance gates.

## Ordered next moves, after approval

September 8 companion pairing refinement: replaces separate endpoint/secret
fields with a single masked pairing code and explicit Connect. Settings copies
the complete expiring envelope and reports clipboard failures without claiming
success. Parser rejects malformed/expired values before opening a socket.
Native UXP controls no longer receive a duplicate CSS border, padding or bevel;
section divider lines are removed and labels explicitly align left. Native
0.1.5 is installed in Premiere: native inspection confirmed the single masked
field, left-aligned label and reduced borders. Clicking Connect with harmless
invalid text displays the parser error without opening a connection. Native
focus chrome remains host-controlled. Keyboard acceptance is still open:
Space reached Premiere playback despite the React event guard. Playback was
stopped and the original 00:00:54:06 playhead restored; the project was not saved.
Do not equate the passing simulated-host keyboard test with native acceptance.

Verification for this batch: 30 companion unit/design tests, four packaged-panel
viewport/text-scale cases, 41 focused app parser/design tests, TypeScript/scoped
ESLint and two isolated Settings browser cases passed. The browser cases exercise
the actual copy handler, masked one-field flow, clipboard failure, expiry,
disconnect, preserved drafts and explicit-only connection. No real credentials
were generated and no marker, sequence binding, sharing or timeline edit occurred.
The user-approved Sauce Bunny restart loaded the rebuilt debug bundle (containing
companion 0.1.4), but native Settings verification then stalled. A read-only stack
sample shows the main thread waiting in macOS Keychain during
`has_review_identity`; no identity or Keychain settings were changed. The standalone
CCX is 0.1.5. No new DMG was produced. Authenticated pairing remains unverified.

September 8, 02:48 PDT native follow-up: the same approved debug process
(PID 9624) recovered without another restart. A new one-second stack sample
shows its main thread in the AppKit event loop, not the earlier Keychain wait
(`/private/tmp/saucebunny-ndi-resume-keychain.sample.txt`). Native Settings
responded and rendered the compact Premiere integration and yellow Beta badges.
Review's Connect Premiere opened the existing Review/Transcript/AI Summary/Queue
tabs above the NDI inspector and displayed one discovered Premiere source.
Refresh retained that source; an unchanged result alone does not prove discovery
latency or source-switch behavior. The Install or set up Premiere shortcut
visibly opened Settings → Integrations, where Connection details resides.
No Preview source, room start, credential creation, companion connection or
Premiere playback was triggered in this follow-up. Actual audio monitoring and
authenticated pairing remain unverified; the transient Keychain wait is no
longer a current blocker. The one-code Settings form requires explicit pairing
creation, so only its disconnected state was inspected natively.

September 8 companion startup repair: 0.1.1 added the missing Adobe plugin/panel
lifecycle registrations; native Premiere now renders the interface. Creative Cloud
also installed 0.1.2 with a localhost-only network declaration after the IP-literal
declaration failed in the host. Pairing remains unverified pending user approval
to create fresh credentials. Beta badges now use the requested yellow (`--gold`)
instead of the orange warning token; other warning/status colors are unchanged.

September 8 drawer follow-up: all existing tabs now precede the independently
scrolling source inspector, whose visible heading is “NDI”. No new tab model,
capture behavior or timecode transmission was introduced. TypeScript, scoped
ESLint, 20 panel tests and eight NDI browser tests passed; three opt-in real-media
tests were skipped. Browser assertions cover tab position while the inspector
scrolls, retained drafts, focus return and private preview continuity.

1. Review the specialty examples and proposed People/Preview recipes.
2. `/impeccable harden`: participant keyboard/state parity, tab/menu behavior
   and label associations, preserving player and draft identity.
3. `/impeccable adapt`: People compact/theater and Preview action/status
   alignment with real mounted application screenshots.
4. `/impeccable clarify` and `/impeccable document`: correct action names and
   stale role comments; do not change specialty identity.
5. `/impeccable optimize`: profile specific measured UI bottlenecks before
   adopting render optimizations.
6. `/impeccable polish`: finish each approved small migration batch, including
   detached and nested surfaces; rerun the audit and regression suite.

These can be reviewed one at a time or in a user-approved batch. No app-wide
migration, media change or DMG rebuild is authorized by this audit.
