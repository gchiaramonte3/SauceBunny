# Review usability corrections

Approved scope: implement the September 12 Review-page UI/UX audit within the
existing design. No theme, media-engine changes, native capture-engine changes, DMG
publication or GitHub publication are part of this batch.

## Plan and implementation map

| Audit finding | Minimal implementation | Regression evidence |
| --- | --- | --- |
| Room “Not shared” hides active broadcast | App-owned source-bound broadcast observations, separate publication label and outside-picture Stop/status | ObsBroadcastControls and NdiPreviewHeader component tests; obs-preview-controls browser cases |
| File/web notes depend on opening NDI | Notes/setup visibility follows the represented source; opening settings leaves picture and navigation alone | review-source-flow browser cases for both file and web |
| Native activation and tabs conflict with playback | Respect handled events and native control keys; roving focus follows visual tab order | use-keyboard-shortcuts and QueueDrawer tests; review-keyboard browser cases |
| Previous file notices cover live input | Suppress covered file-only chrome, retaining player identity and work | Monitor.program-layer test; source-switch browser inspection |
| Private Preview clips at narrow widths | Container-based transport fit, protected title and wrapping source bar | review-source-flow normal/enlarged text and room-head-spacing browser cases |
| Editing removes paragraphs | Labeled multiline editor with explicit Save/Cancel | ReviewPanel.writing tests; review-writing browser cases |
| Reply navigation loses drafts | Drafts scoped by document/version/comment; remove only after posting/discard | ReviewPanel.writing tests; review-writing browser cases |
| Clicking search results clears query | Search persists through list/toolbar interaction until explicit dismissal | ReviewPanel.writing tests; review-writing browser cases |
| NDI-only naming and hidden URL submission | Source-neutral entry points, visible Load action, retained URL, disambiguating-only IDs | RoomSourceBar test; review-source-flow and capture controls tests |
| Ineffective live range command / oversized context | Omit unsupported range action; compact source identity and optional timing disclosure | ReviewPanel.writing tests and rendered live-source review |

## Invariants

Keep the single monitor and volume control, green Post/Share, existing font and
neutral controls, explicit room/broadcast consent, native sender ownership,
source/room identity boundaries, saved-note undo and previous People/drawing fixes.
Opening settings or observing status never creates a room, captures or broadcasts.
Returning to a file keeps its player, marks, captions and notes available.

Broadcast observations stay with retired sources until shutdown is confirmed.
The status DTO exposes existing native cleanup proof separately from failure:
an ended, fully cleaned-up failed sender can retire, while missing/unconfirmed
cleanup remains visible. This adds observation metadata, not a new sender or
capture lifecycle. The frontend/backend build handshake is bumped together.
Retired source errors stop polling only when `cleanupConfirmed` is true;
missing proof remains uncertain. A selected source's confirmed failure stays
visible for recovery. Source settings also uses the shared white focus token
for its initial dialog focus, avoiding WebKit's platform-accent popup outline.

## Verification scope

Component and browser regressions exercise production UI with controlled native
IPC. They establish interaction, accessibility, geometry and ownership wiring,
not real NDI delivery, media/audio quality or live participant transport.
Full verification and a packaged-app rendering spot-check are separate gates;
record their actual results rather than inferring them from a green unit suite.

### Completed verification · September 12

- `npm run verify`: all gates passed on the final source. Includes 3,812
  frontend unit tests (2 skipped), 625 Rust library tests (24 ignored), 3 OBS
  service API tests, Swift checks, native fixture/packaging/license gates, and
  388 Chromium application tests (4 skipped).
- `npm run check:design-catalog`: passed TypeScript, lint, isolation tests,
  33 catalog browser cases, and the production-build exclusion check. The
  passive production header fixture demonstrates independent room/broadcast
  states and Stop without importing native observers.
- Inspected actual-App Chromium renders at 1100×700 and 1680×1020 with normal
  and 125% text, including multiline editing and the closed-settings live
  source layout. The current picture stays unobstructed by broadcast chrome.
- Built and ran a separate temporary AppKit/WKWebView `.app` containing the
  current production frontend with fixture-only IPC and nonpersistent storage.
  Four settled rendering stages passed at 1100×700, including 125% text,
  private Review, NDI settings and application/crop settings. Verified retained
  draft/monitor, restored gear focus, no overflow, and the source modal's
  opaque background and white 1px focus outline. Build handshake:
  `2026-09-12-obs-broadcast-observation`.

Logs: `/private/tmp/sauce-review-ux-verify.9piDCk/verified.log` and
`catalog-final.log`. WK evidence and four PNGs:
`/private/tmp/sauce-review-wk.CWze8g/evidence.json` and its containing directory.
Temporary wrapper and loopback server were stopped; artifacts were retained.

The WK spot-check is production **frontend rendering with mocked IPC**, not
production Tauri packaging/IPC or real media, audio, NDI, capture or participant
transport verification. No installed app, real room, broadcast, or editing
project was changed. No DMG or GitHub publication was performed.
