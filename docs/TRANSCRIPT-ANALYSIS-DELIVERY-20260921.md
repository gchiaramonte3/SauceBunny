# Transcript and analysis delivery - September 21, 2026

## Candidate and scope

Sauce Bunny 0.5.0, internal Apple Development-signed arm64 candidate. Advanced Intelligence is explicitly included with `VITE_SHOT_INTELLIGENCE_PREVIEW=1`; the broader default rollout gate is unchanged. The original implementation handoff below records build 2026092112, which was not committed or pushed at that checkpoint. The separately requested push/rebuild follow-up is recorded at the end. Neither candidate was installed in Applications or notarized for external distribution.

This implements authoritative multitrack transcript publishing, named exports and recording dates, manual cast marker preferences, clearer picture-model selection and shot analysis, and a bundled AV1 software decoder. It preserves the existing Home, Review, NDI and permissions identities. Pre-existing working-tree changes were retained.

## Data and behavior

- Each microphone result is committed to the native AAF document before the library is notified. Empty successful results count as generated. Failed attempts do not. The context action and confirmation use Generate/Regenerate accordingly.
- Transcripts > Multitrack contains a combined, source-filename entry referencing that document, not a duplicate transcript or invented SRT path. Opening it provides track filtering and Open timeline. Historical duplicate imports remain separate and disambiguated. Unchanged reimports reopen the existing document.
- Document schema 2 preserves older schema-1 transcripts and labels. Recording dates carry source/provenance; a separate override can be changed or removed. Missing and mixed dates remain explicit. BWF origination dates and explicit source recording metadata are accepted; Finder timestamps and generic AAF creation dates are not shoot dates.
- TXT/PDF include source, sequence, recording-date provenance, mic labels, audio lanes and timecodes. Untimed text remains in a labeled section. PDF uses restricted, script-disabled WebKit HTML and native paginated printing to a private staging file, then an atomic destination write. Print is separate. The Save As dialog controls names, destination, cancellation and overwrite confirmation.
- Gender is exclusively manually assigned. Man defaults to Blue and Woman to Pink; marker color is independently selectable. Applying a cast snapshots its preferences. Editing a saved cast does not mutate previously labeled documents. Existing unspecified colors are retained. Avid output retains each marker's own color and physical audio lane.
- Advanced Intelligence retains the existing switch with a small settings gear. Source and model are shown before Analyze. Verified local 9B and optional 4B installations are independently selected and remembered. Selection freezes during a run, and results identify their model. Picture observations remain separate from supplied transcript text; Audio shows evidence and labeled classifier suggestions. Cut controls remain beside their counts; cut ticks are below the timeline and chapters above it.
- The bundled decoder adds pinned dav1d 1.5.3 to the existing FFmpeg 8.0.3 / PyAV 16.1.0 runtime. Decode preflight preserves source identity and original PTS/frame mapping. Failure messages identify the source, codec and stage with technical detail collapsed.

## Automated evidence

The first full verification pass completed all repository gates: 4,371 frontend tests, 766 Rust tests, and 458 Chromium end-to-end tests passed. The later rerun passed 4,374 frontend tests, 766 Rust tests and all 458 Chromium tests; its video gate initially selected the wrong Python, then passed separately with the required Python 3.12 environment (76 tests, five optional cases skipped). The final PDF renderer's two focused Rust regressions also passed. Optional/environment-dependent tests remained skipped (3 frontend, 29 Rust, 12 Chromium); these are not claimed as certification. Native AAF reader, capture policy, audio analysis, NDI and licensing checks passed.

Additional focused coverage includes Stop-after-commit, per-document owner save/load races including delayed metadata, empty generated results, model-refresh StrictMode and removal, source-library identity/duplicate filenames, date overrides and mixed dates, cast migrations, all A1-A50 lanes with Blue/Pink at fractional rate, and restricted native print-document identity/content preservation.

Real generated codec tests passed for AV1, AVC and AVCHD/MTS at fractional rate. The original user-reported unidentified codec failure is still not tied to a specific source file; these fixtures do not establish that every variant of that source format is supported.

## Packaged 50-track exercise

Fixture: `Generated-50-Mics-48k.aaf`, a generated 97.1 MB AAF with 50 physical microphone lanes, 48 kHz audio, 480 frames at 24000/1001 fps (20.02 seconds). Forty-nine embedded sources carry 2026-08-01 and one carries 2026-08-02 to exercise mixed dates. Audio is generated speech, not user production footage. The original supplied AAF was not modified.

Hardware: this Mac has 36 GiB unified memory. A single bounded Parakeet recognizer was used, not 50 recognizers. Audio preparation remains bounded separately.

Observed in packaged WKWebView:

- Import and waveform display of all 50 tracks, Small track mode, zoom/fit, mouse seeking, two simultaneous Solo toggles, and Mute.
- All-mic playback advanced through the complete 20.02-second sequence. A settled start at frame 119 advanced across the next fixed audio-block boundary without falling back to paused/preparing state. Tool-observed Play calls returned in 573 ms on the first start and 34 ms on the settled boundary start; these are UI-action timings, **not physical audio onset or underrun measurements**.
- Stop during a transcription run reported 29 saved tracks, matching the visible pane and combined library entry. Opening that entry showed All voices and 29/50; Open timeline returned to the original sequence.
- A subsequent complete run saved all 50 results. Read-only disk inspection confirmed 50 native transcript records and 50 recording-date records, with both distinct dates retained.
- Right-clicking a mic-owner name opened the shared editor. Manual Man/Blue and Woman/Pink assignments for the first two generated mics persisted on disk.
- Native TXT Save As accepted a custom Unicode filename. The resulting text contained all 50 lanes, source and sequence names, both metadata dates, and fractional-rate timecodes.
- Native PDF Save As and overwrite confirmation produced an 11-page, 150-passage document with all A1-A50 lanes and both metadata dates. The first, middle and final pages were rendered and visually checked for readable, non-overlapping text. An independent native probe checked 300 Unicode rows across 14 pages.
- The app's combined Avid export contained 150 markers across all 50 lanes, with each A1 marker Blue and each A2 marker Pink. No markers were imported into a running Avid session.
- Clearing the shoot-date override displayed Not provided; Use source metadata restored both dates. Reimporting the unchanged generated AAF reused the same document ID with all 50 saved transcripts and no additional document.
- Sampled resident memory: native app approximately 113-122 MiB; its WKWebView content process approximately 866-1,033 MiB; observed recognizer process approximately 99 MiB. These are spot samples, not peak combined unified-memory or GPU allocation measurements.

Direct-PDF desktop testing exposed Tauri's data-URL rewrite truncating print HTML and WebKit's synchronous printing path using an unresolved page count. The final implementation avoids data URLs entirely: restricted HTML loads through public WebKit `loadHTMLString`, using a unique private base URL, disabled JavaScript, blocked resources/navigation and no app IPC capabilities. Printing uses AppKit's asynchronous completion and separate-thread pagination, consistent with [WebKit's print lifecycle](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/mac/WKPrintingView.mm). A native generated-text probe produced 14 complete pages with 300 Unicode rows; first and final rows and Unicode extraction were checked. Corrected app-level PDF results are recorded below.

## Offline picture inference

The frozen 9B worker was exercised with network access denied and generated two-shot footage. Three analysis trials completed in 17.52, 15.56 and 14.65 seconds while other builds were running. Source frame bounds and result model provenance were checked. Termination at model loading and shot analysis took approximately 0.004 and 0.086 seconds. These are short synthetic trials, not a long-program benchmark.

Qwen3.5 4B is pinned to `mlx-community/Qwen3.5-4B-4bit`, revision `0e7ffd5c629ef7719d4cbc04069232580bfa9d9c`, with exact sizes and hashes recorded for all ten artifacts (3,061,129,077 bytes total). Its weights were **not downloaded or inference-tested** because the optional download awaits user confirmation. Installation/removal/readiness and remembered-selection logic have automated coverage. Existing 9B files were not removed.

## Remaining limitations

- Optional 4B offline inference awaits its explicit download. Do not describe both picture models as desktop-certified.
- The 50-lane test proves the short generated workflow, not hour-long production AAF endurance, storage performance on another drive, physical audio quality, or peak memory. The real upcoming production 50-track source still needs its own acceptance run.
- Hardware audio audibility, output-device switching, and imported marker appearance in a running Avid session were not independently measured in this pass. Export serialization is tested through A50 and Pink/Blue; this is not an Avid round-trip certification.
- The original unidentified video that showed `avcodec_send_packet()` has not been identified or retested. Verified AV1/AVC/AVCHD fixtures are the available evidence.
- Internal signing is not Developer ID notarization. No installation, permissions reset, or GitHub push was performed.

## Original packaged checks — 2026092112

- Final artifact: **Sauce Bunny 0.5.0 (2026092112).dmg**, archived in the local `Sauce Bunny Builds` folder.
- SHA-256: `d190b0636badcf5fec5d43449097483671c31334ebf544e3bf8c11c7f4bab0d7`.
- Bundle and packaged-runtime verification passed. The DMG checksum is valid; its internal Info.plist reports build 2026092112, its main executable is byte-identical to the tested release app, and deep/strict certificate verification passed. The read-only verification mount was detached.
- The exact release app reopened the combined 50/50 transcript and wrote a fresh 11-page PDF containing all 50 audio lanes and both source dates. Canceling an overwrite left the earlier PDF's SHA-256 unchanged.
- Advanced Intelligence was tested in the narrow docked panel. The source, 9B default, gear, All/Picture/Transcript/Audio tabs and adjacent cut action were visible. Selecting unavailable 4B disabled Analyze and explained the explicit download; 9B was restored. Selection was disabled during analysis. The generated two-shot clip completed with accurate red/blue picture observations and 9B provenance. A second run was stopped through the UI and returned to idle. Its cut action added the generated clip's cut marker.
- Final native print regressions and strict Clippy passed. The print renderer remains script-disabled, local-only and separately guarded from concurrent PDF exports. Existing Sauce Bunny controls were retained; PDF QA included rendered-page inspection rather than text extraction alone.
- No installation, live capture, permission reset, commit or GitHub push was performed. The optional 4B and production-footage acceptance limitations above still apply.

## Push and rebuild follow-up — 2026092113

The user subsequently requested a GitHub push and another DMG. This checkpoint preserves the original handoff above rather than presenting its earlier no-push statement as the current delivery scope.

- Artifact: **Sauce Bunny 0.5.0 (2026092113).dmg**, in the same local build archive; build 2026092112 remains available.
- SHA-256: `8fb838413574e04818014496be8b9ddc4bbe083ead86bea61fdb7a39cd6c8e89`.
- Pre-push review removed two production `expect` calls in the native PDF-loading path. Load/URL failures now return typed errors through the dispatched WebKit load, close its window, and do not report a successful export. No unrelated Library, Home, Review, permissions or NDI behavior was changed in this follow-up.
- Automated reruns passed 4,374 frontend tests, 767 native Rust tests, 458 Chromium tests, 27 AAF reader tests and 76 video-worker tests (five optional video cases skipped). TypeScript, lint, strict Clippy, Swift, audio-evidence, OBS/NDI and license gates also passed. One full-suite run had a transient failure in the unchanged Library organization save-lock test; all five isolated Library tests and the full 767-test Rust rerun passed without a source change. Preserve this failure in the verification logs; it is not evidence that its underlying intermittent cause has been fixed.
- A subsequent complete `npm run verify` finished with exit code 0 and **All gates passed**, including 458 Chromium checks in 2.5 minutes. The review verdict is **OK to push this internal candidate**, subject to the explicitly unverified production and optional-model cases above. No broad structural refactor was introduced.
- Bundle and packaged-runtime checks passed. The archived DMG passed checksum verification; a read-only mount confirmed build 2026092113, a byte-identical executable and deep/strict certificate verification, and was detached afterward.
- With explicit desktop approval, the rebuilt release app reopened the saved generated 50-track sequence and exported a newly named PDF through native Save As. It contains 11 pages, 150 passages, every A1-A50 lane, the source filename and both embedded shoot dates. Rendered pages 1, 6 and 11 were inspected for layout. The user's original 20-track sequence was restored, paused, with NICOLE selected and Plain text as its export format. No production transcription was run.
- The code-co-review skill guided the pre-push correctness pass; the PDF skill guided rendered-page inspection alongside text assertions. The original 4B download, long-production endurance, hardware-audio and unidentified-source limitations remain unchanged. This is still an internal Apple Development-signed build, not a notarized public release or an installation.
