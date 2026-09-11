# Design catalog: source inventory and review candidates

Evening follow-up: see `REVIEW-CORRECTIONS-2026-09-07.md` and the evening rules
in `DESIGN.md`. Compact People now hides camera/mic icons and controls, keeping
device truth in details and actions in details/the room toolbar. Post and Share
with room are explicitly approved green actions. Expected speakers demonstrates
the production violet radio-menu exception; other native selects stay unchanged.
The catalog imports only its controlled picker, icons, CSS and shared focus helpers,
never its transcription job or native controller.

Status: limited People/Preview production adoption, 2026-09-07. The approved
batch fixes participant indicator clipping, details accessibility and theater
parity, plus Preview's Live status and Premiere disclosure. All other candidate
recipes remain for review; no application-wide styling or Preview layout change
is authorized by this document.

The isolated catalog lives in [design-system](../design-system/). Its source-backed register is [catalog-data.ts](../design-system/catalog-data.ts). It covers Home, Library, Clip, Review, Transcripts, Settings, dialogs, nested components and detached windows. It must not load the production app, invoke native commands, connect NDI, create a room, request camera/microphone permission, or run media jobs.

Run `npm run design:catalog` and open [the local catalog](http://127.0.0.1:51731/design-system.html). Run `npm run check:design-catalog` for strict TypeScript, the application's Hooks lint rules, recursive inventory, isolation tests, browser checks, and a temporary production-build exclusion check. This development-only HTML entry is not the production application's default build input.

The server binds to loopback only. Generic proposed controls remain isolated
under `design-system/`; they are not production APIs. The adopted People and
Preview examples use production styling with isolated fixture behavior. Previous
defective examples are retained under **Before the fix**, not as the current
recipe. The verifier builds the frontend into a fresh temporary directory,
checks for catalog code/styles/HTML, and prints that location. It does not touch
the normal `dist/`, stamp a release, or build a DMG.

## Catalog verification

### Avid NDI help candidate (2026-09-11)

The Preview entry renders the pure production `AvidNdiSetup` disclosure. It
performs no native call, discovery, capture or publication. Production places it
in the existing gear dialog, never the commenting sidebar. Actual-App browser
tests cover its minimum window at normal/125% text. This is UI verification,
not proof that the installed Avid broadcasts a usable signal; see
[AVID-NDI-COMPATIBILITY.md](AVID-NDI-COMPATIBILITY.md).

### Premiere workflow follow-up (2026-09-07)

The Preview example now reflects the separately approved live-input behavior:
no Play/step buttons while Premiere owns transport, one local volume control,
and installation/connection diagnostics in Settings → Integrations rather
than a help disclosure in Preview. Source fixtures still perform no discovery
or capture. Production uses the original four-tab drawer, not a duplicate mock
Review panel. The September 8 placement correction moves source settings into
a gear-launched dialog beside volume, leaving the sidebar for its shared tools.
Earlier catalog text-disclosure specimens demonstrate that control recipe, not
the current transport placement. See DESIGN.md for the adopted rules; real
Premiere output remains a separate native verification.

The clear-viewport follow-up adds the pure production `NdiPreviewHeader` to
the Preview specimen: passive publication status plus a centered, explicitly
unavailable sequence-timecode readout above the picture. Browser coverage checks
that center and separation. Earlier text-disclosure fixtures remain labeled as
control-recipe demonstrations, not the current gear/dialog placement. App tests
exercise the actual settings recovery button, not a simulated catalog connection.

### Finder clip indicators: limited adoption, 2026-09-07

The Tables entry now also renders the pure production `ClipTagIndicator` and
production caption/row styles with isolated markup and fixture data. It shows
all seven Finder colors, no tags, a colorless custom label, multiple tags,
selected rows, long filenames and narrow containers. Grid dots are 8px;
list stripes are 2px at the far-left edge, inset 4px vertically. Folder tints
are unchanged. No LibraryCard/store/media hook is imported into the catalog.

This is an explicitly approved production recipe alongside the earlier
People/Preview adoption, not an adoption of the schematic table replacement.
The fixture uses only local selection state. Source references and full
usage rules are in DESIGN.md and the Tables entry; native synchronization is
tested separately from these visual fixtures.

The verification matrix is 1100×700 and 1680×1020, with normal and 125% text. Tests cover all 20 families, search/workspace filters, source links, command sizes, keyboard focus, field validation, menus/dialogs, passive status, combined participant states, viewport-contained details, the single existing Preview volume control, and the real specialty components. Fixtures prohibit storage writes, native calls, device capture and application network requests. Catalog checks complement the separate real-application People/Preview regressions; they do not establish that unrelated production findings are fixed. See the [current audit](DESIGN-SYSTEM-AUDIT.md) for verification results and remaining limits.

The recursive inventory currently covers 139 production TSX files and 25 CSS files, including nested directories. `node scripts/design-catalog-audit.mjs --json` prints the full source-site inventory and its digest for future comparison; it is read-only.

## Which source means what

| Source | Role and precedence |
| --- | --- |
| [DESIGN.md](DESIGN.md) | Current application rules and token conventions. These remain in force. |
| Production components and styles | Evidence of what is implemented now, including exceptions and defects. A CSS comment is not proof when its declarations disagree. |
| [Catalog data](../design-system/catalog-data.ts) and this document | Current inventory and proposed recipes for review. A proposed example is not a production primitive or an instruction to migrate. |
| [DESIGN-AUDIT.md](DESIGN-AUDIT.md) | Historical findings and proposals, preserved with a dated reconciliation appended. Old counts, line numbers and suggested fixes are not automatically current. |
| [DESIGN-SYSTEM-AUDIT.md](DESIGN-SYSTEM-AUDIT.md) | Current application-to-catalog comparison, evidence, coverage limits and ordered follow-up. Not permission to change application screens. |

Only the explicitly adopted recipes listed in DESIGN.md are adopted. Other examples
do not authorize replacing the app's classes, colors, layout or behavior.
Preserve the dirty working tree and existing user work.

## Catalog classifications

- **Keep:** an existing pattern is useful; demonstrate and protect it.
- **Standardize:** related implementations drift; compare a shared recipe before adopting it.
- **Intentional exception:** a specialized treatment earns its difference and must not disappear in a mechanical sweep.
- **Functional defect:** an incorrect label, inaccessible interaction, clipped control or inconsistent state is not simply an aesthetic choice. It still requires a scoped implementation and verification after review.

These classifications describe the entry's main concern. For example, panels are primarily a standardization area but contain an undefined detached-button class; a useful existing table language can still have isolated accessibility defects.

### Specimen provenance

Each side of a comparison declares what is actually being rendered:

- **Production component · fixture props:** imports the component, but supplies local demonstration data and handlers.
- **Source-markup fixture:** reproduces selected application markup/classes with isolated data; it is not the whole mounted application.
- **Components + fixture markup:** a mixture, with the source references identifying the actual components.
- **Illustrative fixture:** a schematic explanation, not a pixel-identical application screenshot.
- **Catalog only, not applied:** proposed behavior or styling awaiting review.

**Keep** describes the pattern to preserve, not a claim of pixel equivalence.
**Related examples** compares complementary patterns rather than replacements.
Do not copy a schematic table, panel, tab or status example over production
styles. Source inventory coverage and visual fixture coverage are separate.

## Inventory coverage

| Entry | Current scope and examples |
| --- | --- |
| Action buttons | Home/library commands, Clip import/fetch/export, Review setup/NDI actions, Settings and dialog confirmation |
| Icon actions | Transport, queue, Review tools, browser toolbar, close/remove and image-overlay controls |
| Statuses | Source Live readout, connection state, job outcome, roles and identity |
| Fields | URL/search wrappers, filename, session/join fields, timecode and nested review input |
| Selects | Shared native select family, sort controls and permission-safe device labels |
| Choices | Switches, segmented choices, radio-style swatches and custom color input |
| Tabs | Drawer, Settings, shelves and Host/Join; preserved panel state and drag reordering |
| Menus | Source, row, project and nested transcript history/selection menus |
| Tooltips | Native title baseline, positioned composer exception and dynamic action names |
| Dialogs | Rename, move, share, Settings, paste notes and speaker roster |
| Tables | Shared local-file, web, frame and session/history tables, empty floor and long-cell behavior |
| Panels | Resizable sidebar/drawer, Preview setup rail, transcript splits and detached root |
| Feedback | Toast, progress, empty state, error, stale media and note delivery |
| Typography | Current font, role scale, neutral emphasis, selection, focus and semantic color |
| Participants | Expanded People panel, compact spine, theater tiles and all participant states |
| Preview | Existing monitor/transport, passive source state and Premiere disclosure |
| Generate transcript + speakers | Actual GenerateButton, exact combined/transcript/retry/rerun labels, progress and result states; no jobs |
| Speaker controls | Detect/expected options, Speakers filter, Manage, insights and detection actions, identity vs command semantics |
| Async actions | Actual StatefulButton for Export and Fetch; simulated phases only |
| Navigation | NavRail, shelves, folders, breadcrumbs and Library session history |

The production TSX inventory found 530 raw button source sites, including loop templates and reusable-component internals; this is not a count of rendered instances. The problem is not that every raw button is wrong. It is that shared visual recipes and interaction semantics are insufficiently explicit, so a compact text command can acquire a different treatment from neighboring transport controls by accident.

## Specialty component recipes

These are existing production patterns, not newly approved generic APIs.

| Pattern | Production source / recipe | Ownership and usage |
| --- | --- | --- |
| Generate | `src/components/GenerateButton.tsx`; `.cp-gen-*` in `buttons.css`; Sidebar adds `.cp-source-action` | Parent passes `idleLabel`, `loadingLabel`, `loading`, `progress`, `resolution`, `disabled`, `onClick`, `onResolved`. Loading wins visually over a lingering resolution; the audit records a stale-announcement edge case. Preserve three sparkles, green wash, progress underfill and reduced motion. |
| Export | `StatefulButton`; `.btn.btn-primary.cp-export-cta.cp-sbtn-export` | Parent owns `phase`. Preserve the violet treatment and 36px geometry; disabled depends on export eligibility. |
| Fetch | `StatefulButton`; `.btn.btn-ghost.cp-sbtn-fetch` | Preserve 86px minimum width and `loadingLabel=""` spinner-only treatment; its polite status announces loading. |
| Detect speakers | Sidebar `.cp-toggle-row` with native checkbox | Changes detection configuration, not speaker visibility. Disabled during the real job. |
| Expected speakers | Sidebar `.cp-select.xs.cp-mini-select` | Native select shown when detection is enabled; Auto or 2/3/4/5/6+. |
| Speakers | TranscriptReader `.cp-reader-chip` with `aria-pressed` | Filters the transcript library to items with speakers. Not a roster launcher. |
| Manage / speaker count | TranscriptViewer `.cp-tx-bar-btn` / `.cp-tx-bar-fact` | The count is passive; Manage opens the roster. |
| Speaker identity / assignment | `transcript/SpeakerRosterRow.tsx`, `SpeakerAssignFlyout.tsx`, `SpeakerColorPicker.tsx` | Identity color, rename, selection, audition and assignment remain separate actions. Rich flows are source-inventoried, not fully reproduced by the catalog. |
| Speaker insights / detection | TranscriptViewer icon action / Tools menu | Insights opens a rich popover; Detect/Re-detect speakers is a job command. No speakers-only Generate CTA exists. |

Example of the actual component with intentionally local catalog state:

```tsx
<GenerateButton
  className="cp-source-action"
  idleLabel="Generate transcript + speakers"
  loading={phase === "loading"}
  progress={progress}
  resolution={phase === "success" || phase === "error" ? phase : null}
  disabled={phase === "loading"}
  onClick={() => setPhase("loading")}
/>
```

This example deliberately does not dispatch work. A production caller must
wire existing job state and `onResolved`, not use fixture handlers. Import
the component rather than copying its DOM or assigning `.cp-gen-btn` to a
plain button. Never mount Sidebar, TranscriptViewer, a store or a model
loader just to demonstrate a control.

## Candidate recipes to review

### Commands and utilities

Keep the current dark neutral, subtly beveled control language and Nunito Sans. Review a **30px default / 26px compact** pair, with 8px / 6px radii and the existing 12px / 11px label roles. These values are catalog candidates, not newly adopted production tokens.

Size, emphasis, tone and behavior are separate choices. Primary is stronger neutral emphasis, not green. Compact does not automatically mean uppercase. The existing 22px uppercase command variant remains visible as a legacy comparison, not the proposed compact default.

Proposed later API: a native `Button`, an `IconButton` requiring an accessible label, and a passive `StatusBadge`. Compose toggle, disclosure and menu behavior rather than introducing one ambiguous `active` flag. A toggle uses `aria-pressed`; a disclosure uses `aria-expanded` and `aria-controls`; a menu trigger also needs menu semantics and keyboard behavior. Switches and tabs retain their own interaction models.

Do not flatten everything into this pair. Keep large Play, borderless transport utilities, imagery-overlay controls, table rows, swatches and branded async actions as explicit contextual recipes. Icons have independent glyph and hitbox sizes; the box must not shrink under flex pressure.

### Compact native checkbox

Approved for the catalog on 2026-09-07: `.cp-ds-check` uses a 13×13px native
checkbox, down from 16×16px. Its associated label remains at least 26px high
and clickable, including the space above and below the smaller glyph. Keep
the native checked state and Space activation; keyboard focus retains a 2px
outline with a 2px offset. The header's enlarged-text checkbox uses the same
recipe. This is not a global production checkbox migration or a change to
Detect speakers / speaker roster controls.

The speaker-roster specimen separately uses the existing dark neutral
`--bg-5` (`#403F46`) as its native checkbox accent, making the white check more
distinct than the production `--fg-4` fill. This approved catalog-only colour
refinement appears in both the inline and dialog fixtures; retain its 13px
geometry, native unchecked state and focus indication. Production speaker
checkboxes and the Detect speakers control are unchanged.

Browser regressions check glyph dimensions, label hit area, click outside the
glyph, Space activation and focus at normal and 125% text. The complete
catalog now has 28 browser cases. See the [frontend re-audit](DESIGN-FRONTEND-AUDIT.md)
for current production findings and the limits of passing catalog examples.

### Preview status and Premiere action

Adopted in the limited 2026-09-07 production batch. Use `.cp-source-status` and
`.cp-toolbar-disclosure`, not the catalog's generic Button or StatusBadge APIs.
The actual source panel, callbacks, monitor and audio controls remain unchanged.

The source status and source action are adjacent but different:

- **Live** reports the visible source/transport state. It remains passive, without a misleading button border or disabled appearance.
- **Premiere / Connect Premiere** opens source controls. Give it a deliberate toolbar disclosure treatment and an associated expanded panel.
- **Share with room** is publication. It is separate from private preview and cannot happen because a user opens the panel or selects a design example.

Align the status and action deliberately without rewriting the monitor, timeline, notes or conversation layout. Keep the existing single player mounted. Live input has no seekable file timeline and cannot borrow a hidden file's note time. The catalog makes no latency or timecode-verification claims.

### Participant variants

The picture/chrome separation and accessible details pattern are adopted.
Production keeps its real PersonTile stream attachment, device callbacks,
local-only mute/hide actions and host permission gates; the catalog's mock
participant model is not a replacement application component.

Use one participant-state model across three review candidates:

| Variant | Candidate geometry | State/control treatment |
| --- | --- | --- |
| Expanded | 240px-wide, 16:9 tile | Readable name, role, media and attention slots, with non-overlapping controls |
| Compact | 72px rail, 48px avatar | Image mask clips only the image; concise presenter/attention indicators and accessible details stay outside it |
| Theater | 168px-wide, 16:9 tile | Same participant truth and available actions as expanded mode, with compact chrome |

Do not put full Presenting/Sharing/Recording text or a pair of self-device controls inside a 48px circular clip. Presenter and raised-hand states need separate slots. Camera off, connecting, reconnecting, locally muted, recording and self/host identity must remain distinguishable.

The initial audit found clipping/overlap rules, incomplete theater prop wiring
and a remote context-action keyboard gap. Those People findings are resolved
by the approved production batch and its rendered geometry/action tests; do
not reapply the old fixes. Other keyboard findings remain separately tracked
in the frontend re-audit.

### Content, surfaces and feedback

Keep the shared native select, table vocabulary, existing tooltip exception and explicit toast dismissal. Show their important states in the catalog rather than replacing them with generic cards.

Retain the established 10px anchored-surface and 12px dialog tiers. Separate the shape of a popover from its behavior: a menu, rich panel and dialog do not become interchangeable because they have a dark background and shadow.

Use the current font, loaded weights, token scale and restrained palette. Do not add a new font, dependency, theme or production token set. Keep intentional dense spacing; rounding every gap and padding to a 4px grid is a redesign, not cleanup.

## Source-confirmed defects versus validation work

The scoped People/Preview adoption resolves compact indicator clipping,
participant keyboard access, theater prop/CSS parity and mixed Preview control
recipes. These have actual-application tests in addition to catalog examples.
The following findings remain open:

- Some tab-role controls lack the expected arrow-key model; nested HistoryPopover lacks the shared menu keyboard behavior.
- Filename labeling and some timecode validation need explicit accessible relationships.
- Volume's muted-state tooltip says Unmute while clicking opens its popover.
- Detached notice Dismiss uses `cp-btn`, which has no production CSS definition.

The browser review must still measure actual hitboxes, overflow, focus visibility and contrast, including text over white/bright video. A source contract passing is not evidence that every badge fits or that every dynamic label is correct. No real-media test, native behavior or latency acceptance gate is satisfied by the catalog.

## Later migration order, after user review

1. Review further recipes using the isolated catalog. People/Preview are the completed first adoption; other candidates and exceptions remain visible for review.
2. Add further minimal compatibility primitives only in approved batches, with no media or persistence behavior changes. Test semantics before broad usage.
3. Preserve the People/Preview production regression checks while extending other families; do not reapply the historical defects.
4. Move straightforward dialog, Settings, Home and Library commands; then shared dense Review/Transcript/Queue utilities.
5. Migrate specialized transport, destructive confirmation and async actions only with their existing behavior suites and real state fixtures.
6. Retire a private class or token only after all known consumers, including nested and detached views, are accounted for.

Each batch needs keyboard and accessible-name checks, contrast on real backgrounds, pointer-target measurements and screenshots at the normal minimum width, wide layouts, narrow docked rails, theater and detached windows. Include long names/labels, multiple concurrent participant badges, camera off, reconnecting, disabled, busy, success, error and reduced-motion states.

Keep all existing guardrails. Strengthen recursive source discovery, dynamic-name checks and actual browser geometry rather than adding allowlists to silence findings. Preserve the player identity, source ownership, note durability, entered setup values, grants, device opt-in and session-history navigation tests alongside visual checks.
