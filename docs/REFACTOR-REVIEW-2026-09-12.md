# DRY review and Home welcome · September 12, 2026

## Review verdict: Ship for internal testing

The bounded cleanup preserves existing capture/playback behavior and public
interfaces. This is an internal-test delivery, not a claim that the entire
application or experimental OBS distribution is release-ready. Known Review
limitations below remain explicit follow-up work, not implied fixes.

## Bugs

- **Fixed:** retired OBS broadcast observations could be pruned after child
  exit without raw-stop/pipe-EOF proof, making a later status read falsely say
  cleanup was confirmed. The registry now retains incomplete and unknown
  observations. Regressions cover all eight cleanup-proof combinations and
  unknown startup failure, including pruning by a different source.
- **Fixed:** shared capture-helper shutdown discarded child-wait errors before
  notifying stop callers. Successful reaping is now required for completion,
  including the startup-pipe error path. Interrupted waits retry; unknown
  ownership retains the closed client and active capacity without further
  PID signals. Generated-process regressions cover normal/forced shutdown,
  injected wait errors and retained stop-pending state. These tests do not
  exercise live media. Quarantined capture reports a required app restart;
  normal draining retains its existing retry wording and deadline.
- **Fixed:** notarization preflight omitted Deno from required sidecars while
  pin verification intentionally tolerates absent files on fresh clones. The
  required set now includes Deno and is checked against Tauri's externalBin
  list. Tests execute the actual presence-check block against temporary files.
- **Fixed:** Home's empty hero was capped at 72vh, leaving a separate blank
  floor. The empty-only layout fills the available viewport. Its search and
  populated folder/recent/transcript branches remain separate.
- **Test harness:** the catalog's deliberate edge-position scroll could arrive
  after Shift+F10 opened a participant menu, correctly dismissing it. The test
  now reuses its existing scroll-settlement observation before opening. No
  menu behavior, assertion, retry count or fixed delay changed.

### Known preexisting Review limitations, outside this cleanup

The read-only UI/UX audit confirmed these mechanisms also exist before this
refactor. They are not resolved by this delivery:

- **High:** an unfinished main comment can carry from ordinary source A to B;
  the draft's guard compares live-program IDs, not ordinary source/version IDs.
- **High:** a late Tidy result can overwrite text entered while the request was
  pending. It needs source/draft/revision validation before applying its result.
- **Medium:** main-composer Enter does not guard active IME composition; a
  synthetic event reproduced unintended posting. Actual macOS IME remains a
  separate verification step.
- **Medium:** deleting a focused comment checks focus before React removes the
  row, so keyboard focus can fall onto the page body.
- Source approval has no user-facing writer; resolving a comment is not a
  source-level verdict. Reactions also crowd author identity at enlarged text.

Do not infer that these are fixed from passing refactor, source-flow or reply
tests. They need their own focused follow-up, without changing the media engine.

## Principles

- **DRY:** capture controls now reuse `copyCaptureSelection` for the exact
  selection/crop snapshot already used by the coordinator. A regression checks
  mutation isolation in both directions during an asynchronous handoff.
- **Remove dead code:** deleted the unused single-source `useObsBroadcast`
  wrapper. Both test fixtures now use the same `useObsBroadcasts` manager as
  App; no production caller or public native command was removed.
- **DRY:** `Program::started` supplies the same source ID, display name and
  loopback route to all three native descriptor call sites. A pure test covers
  route and identity equivalence; it does not alter capture ownership.
- **Keep scope small:** no new settings workflow, framework, transport,
  persistent store, shared playback abstraction or global button restyle.

## The "no" list

No new preparation timer, speculative abstraction or media-buffer limit is
introduced by the DRY/Home changes. Existing real backpressure, generation
guards and hardware-capacity limits remain. Cleanup-proof guards are necessary
ownership boundaries, not defensive wrappers to remove for brevity.

## Welcome design and verification

The screenshot identifies the empty Home hero, not the first-launch welcome /
permissions overlay. The revised hero uses the existing typography and controls,
a small opaque bunny mark, short copy and one continuous neutral surface. No
oversized watermark or gradient. The frontend-design skill guided restraint
and existing-token reuse, not a new theme.

Eleven new mocked-browser cases cover 1100×700, 1680×1020 and 2200×1100 with
normal/125% text, bottom-edge geometry, hit-testing, keyboard actions, search
roundtrip, retained Clip player, and populated folder/recent/transcript shelves.
These are real frontend layout tests with mocked native calls, not real-media
or packaged WKWebView certification.

## Integrated verification

- `npm run verify`: all gates passed. Includes 3,818 frontend tests (2 skipped),
  634 Rust library tests (24 ignored), 3 OBS service API tests, 11 Swift tests,
  strict Clippy, lint, native fixture/packaging/license gates, and 399 Chromium
  application tests (4 skipped).
- `npm run check:design-catalog`: passed type/lint checks, 6 isolation tests,
  33 browser cases and production-bundle isolation.
- Capture-helper cleanup/error handling received a second independent review.
  Its targeted service suite passed 12 tests; 3 live-capture cases remained
  intentionally ignored. No live media was started during this cleanup.
- Earlier verification exposed a missing contract-register row/count and the
  catalog scroll-order fixture defect. Both were corrected before the final
  passing gates; no assertions were removed and no retries were added.
- A separate nonpersistent AppKit/WKWebView fixture rendered the current Home
  frontend at 1100×700 and 1680×1020 with 100%/125% text. All four states filled
  the bottom edge without overflow; both actions were visible and hit-testable.
  No errors or capture calls were recorded. The wrapper/server were stopped.
  This is frontend-only WK rendering, not production Tauri or real-media testing.

Final integrated log: `/private/tmp/sauce-delivery-verify.KR92mJ/verify-final.log`.
Welcome WK measurements/screenshots: `/private/tmp/sauce-home-wk.9XMtEy/`.

## Delivery boundary

Use the OBS-enabled internal app staging path for this test DMG; ordinary
`build:dmg` does not stage the experimental OBS runtime and separate sender.
The available Apple Development identity supports consistent internal signing,
not Developer ID notarization. Retain internalOnly/distributionReady metadata
and the third-party source/provenance records. The app uses production identity
and data paths when launched; a separate output directory is not a data sandbox.

### Test DMG produced

- Built from source commit `c832bb7b0ec18d7a5edd671929d21b7ff338d5d3`:
  Sauce Bunny **0.5.0 (2026091201)**, arm64, Apple Development signed.
- `Sauce-Bunny-0.5.0-2026091201-Internal-Test.dmg` (197,747,211 bytes), stored
  locally under `Developer/Sauce Bunny Builds/2026091201/`; not uploaded as a
  public GitHub release.
- SHA-256: `1ff067bede13d34e07b780bb0d51ea7ebbeaaa6d530acbca5f5957111fade9bb`.
- Exact staged-app and mounted-copy checks passed: OBS/sender provenance and
  signatures, app bundle contents/signature, packaged implementation checks,
  and `hdiutil verify`. Both app copies have executable SHA-256
  `ff1e32c7ea08abe0b78c81dce17e7ff4b3f22f28cfe49ba85ac4ab8fb2822e74`.
- Runtime metadata remains `internalOnly: true`, `distributionReady: false`;
  the application profile contains 19 components plus the separate NDI sender.
- The verification mount was ejected. No installed application was replaced
  or launched. Live Avid/Premiere audio/video, room transport, paste permission
  and first MP3 export remain hands-on acceptance checks, not inferred passes.

The dated build folder includes the final test/build logs and four Welcome WK
screenshots. Subsequent documentation-only commits record this evidence without
changing the code packaged in the image.

Code-co-review was used to prioritize concrete bugs and remove exact duplication.
The existing Review layout, native media cadence and explicit sharing consent
remain the constraints for this delivery.
