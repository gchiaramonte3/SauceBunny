# Local video intelligence

Implemented in source and a standalone frozen Apple Silicon worker. The latest
internal preview is **2026092113**; see the
[transcript and analysis delivery report](TRANSCRIPT-ANALYSIS-DELIVERY-20260921.md)
for current verification and limitations. It is archived in the local
`Sauce Bunny Builds` archive. It explicitly enables the
preview, uses compact existing controls and separate bottom-edge cut markers,
and includes the fractional-frame seek corrections described below. Normal
builds retain the default-off rollout.

The earlier 2026092107 mounted app passed native WKWebView/Tauri analysis, visible red/blue
frame seeking, explicit duplicate-safe cut adoption, Stop and clean restart on
generated fixtures. Its bundled Qwen/proxy workers passed offline checks, and
its audio helper passed all six generated-fixture checks. See the final
2026092107 checkpoint below for evidence and limitations. This is Apple
Development signed, not a notarized public release; `/Applications` was not
replaced. The unavailable original reviewed video remains unverified. This
feature does not change Home, existing transcription engines, text AI providers,
or original media.

## Use

### Reference-package availability (September 21)

The user confirmed that they do not have the original reference package or its
reviewed 705-frame video. The exact reference-package and reviewed-video gates
therefore remain unverified in the current checkout; earlier dated results do
not establish a fresh acceptance run. Do not fabricate or substitute a generated
clip while claiming those exact gates passed. Qwen's pinned download was approved
again for local testing. `video-sidecar/smoke_shots.py` is a separate Qwen-only
offline check using generated red/blue footage and existing verified weights,
not a reference-detector acceptance test or a general video-quality benchmark.

Qwen was downloaded using the packaged worker to the normal app-data
`video-intelligence/models` directory. All 5,977,071,067 bytes passed the pinned
size/SHA-256 checks; the worker reports `qwen3.5-9b-video` ready. No AST, embedding
or reranker download was performed. Offline packaged inference was then exercised
with network denied and Homebrew removed from PATH. The first two-shot run
identified red but returned insufficient evidence for blue. The following three
complete trials identified both colors correctly, retained shot IDs/ranges,
sampled source PTS and supplied transcript, and showed no repeated-sentence loop.
Those runs took 5.89, 4.61 and 4.57 seconds for two shots each on this Mac.
Do not erase the first failure or treat this synthetic smoke as reliable
real-footage quality, reviewed-reference acceptance, or packaged-UI certification.
Reports: `/private/tmp/sauce-qwen-shots-20260921/report.json` (initial failure)
and `/private/tmp/sauce-qwen-shots-20260921-trials/report.json` (three full trials).

The generated source also passed the integrated AI Summary browser check in
installed Chrome and Playwright WebKit. The actual detector decoded all 48 proxy
frames at 24000/1001 and found the boundary at 1,001,000 microseconds. The real
offline Qwen worker described the two corresponding red/blue shots; supplied
dialogue remained separate. The native audio helper correctly reported no audio
track. Explicit marker adoption preserved exact source times (0 and 1.001 s).
The native proxy manifest came from `smoke_proxy.py`; browser-to-native calls in
this test are a fixture bridge, not production Tauri IPC. These checks therefore
do not certify the packaged WKWebView lifecycle. Run them without the missing
reviewed fixture using `SCENE_GENERATED_SMOKE_REPORT`, `SCENE_VIDEO_WORKER`,
`SCENE_VIDEO_ROOT`, and optionally `SCENE_AUDIO_HELPER` with
`e2e/shot-intelligence.spec.ts -g 'generated fractional'`.
Set `SAUCE_PACKAGED_FRONTEND=1` to serve the already-built `dist/` instead of
development modules. The explicit preview switch and generated real-Qwen
scenario also passed against the compiled preview frontend in WebKit. This
still uses the fixture IPC bridge; it does not turn a browser test into native
desktop certification.

After the explicit build opt-in was added, the full frontend run passed 4,347
tests with three existing skips. The ordinary-build integration group passed
six tests; its three opt-in scenarios were skipped in that run. The preview
opt-in scenario, real-Qwen generated scenario, and reviewed-reference scenario
remain distinct: the first two were run separately and passed; the absent
reviewed-reference scenario was not run. TypeScript and scoped lint passed.

The Qwen-only smoke also terminates the real offline worker on its observed
`loading-model` and `analyzing-shots` events. Both exits were non-successful with
no adoptable terminal result (3.8 ms and 127.1 ms after the termination signal).
Three complete two-shot trials then passed, showing that a subsequent process
can load the model and produce source-bound answers. These are worker process
observations, not desktop Stop-button latency measurements. The report is
`/private/tmp/sauce-qwen-cancel-20260921/report.json`.

### Static-shot prompt regression (September 21)

The compiled-preview WebKit test was subsequently run with the configured app
CSP applied to its document, using the mounted 2026092103 workers. It reported
no CSP violations, but failed the visual-description assertion: Qwen called a
visible static red shot insufficient evidence. The failed run remains recorded
at `/private/tmp/sauce-preview-csp-webkit-20260921.log`; it must not be described
as a successful end-to-end run.

A controlled, network-denied comparison used the same two generated shots, the
actual AI Summary question, unchanged model/sampler, and fixed seeds 0–29. The
previous prompt named the expected visible color in 54/60 answers; the candidate
did so in 60/60. The other six answers omitted observable appearance or treated
the lack of action as insufficient evidence. This is a narrow synthetic prompt
regression, not 60 independent real-footage examples or a general accuracy claim.
Both sets of outputs remain in
`/private/tmp/sauce-qwen-prompt-diagnostic-extended-20260921.json`.

The visual-shot prompt now asks for appearance as well as action, treats static
frames as evidence, and confines uncertainty to unsupported details. The audio,
identity, cut-count, timecode and supplied-dialogue safeguards remain unchanged;
the retrieval-description prompt is unchanged. The packaged smoke now asks the
actual AI Summary question rather than an easier color-only question. This change
is packaged in preview 2026092104, not the earlier preview 2026092103.

The first three-trial smoke of the 2026092104 worker passed its transport,
cancellation, expected-color and repetition checks. One answer nevertheless
said supplied transcript text appeared on screen, although the generated red
frame contained no text. This is a semantic grounding error, not a successful
visual-text recognition result. Raw answers are preserved at
`/private/tmp/sauce-qwen-preview-2026092104/report.json`. Passing the automated
smoke does not certify factual accuracy: descriptions need human review, and
the separately displayed supplied transcript and deterministic shot timestamps
remain distinct from model-generated prose.

The mounted 2026092104 worker also passed three two-shot runs (6.00, 6.07 and
5.33 seconds) and cancellation during loading/between shots (3.8 and 128.9 ms).
One of those answers invented the word “No” for an empty supplied transcript;
the raw response remains in `/private/tmp/sauce-qwen-dmg-2026092104/report.json`.
The structural tests validate source IDs, exact ranges, verbatim separately
returned transcript, sampled frame PTS, expected colors and repeated-sentence
limits; they cannot validate every factual assertion in generated prose.
These two semantic errors remain known preview limitations, not fixed claims.

The DMG is 364,011,244 bytes with SHA-256
`34b5aea3d866bed09df7b1ed1484a2846d6e1b82aed8c8d3a18977840403119d`.
Its mounted build number and strict deep signature check passed. The mounted
executable and video runtime match the built artifacts. Automated bundle and
packaged checks passed; video-sidecar tests passed 73 with one opt-in skip.

The final compiled-frontend WebKit run used the mounted 2026092104 audio/video
helpers with the configured app CSP: three tests passed, with no CSP violations
(`/private/tmp/sauce-preview-csp-webkit-dmg-2026092104-final.log`). The browser
assertion now compares complete rendered prose, retaining every word and
punctuation mark while accounting for the existing Markdown renderer's supported
syntax. Earlier paragraph/heading assertion failures and the unsuccessful
server-rendering test approach are recorded in the preceding `sauce-preview-csp-*`
logs; no product rendering change was made to satisfy those checks. This remains
a fixture IPC bridge, not the outstanding real desktop WKWebView interaction.

### Explicit timeline adoption (September 21 source update)

Advanced Intelligence offers **Add cut markers** beside the shot/cut count.
A cut is a detected shot change, not necessarily a new narrative scene. Two
shots with one boundary create one marker, never an extra marker at zero.
Verified source-relative starts retain microsecond precision, without adding
container origin or rounding through FPS on seek.

Cuts have a separate `CutMarker` store (`saucebunny.cutMarkers.<sourceKey>`),
drawn as bottom-edge timeline ticks. YouTube and text-generated chapters stay
at the top, unchanged. Already-saved chapters from earlier builds are not
guessed at or deleted. Repeated adoption deduplicates by microsecond; analysis
alone never changes markers. The store shares the existing localStorage
eviction limitation of chapters; immutable machine evidence remains separate.

The same-window cut event and detached-panel cut callback refresh the timeline.
Read-back checks prevent claiming success when saving fails. The normal
production switch replaces the bespoke mode toggle, retaining busy-state locks
and the text conversation/draft across mode changes. Regression coverage lives
in `ShotCutAction.test.tsx`, `ShotIntelligence.test.tsx`, `Timeline.test.tsx`,
`cut-markers.test.ts`, and `e2e/shot-cuts.spec.ts`. Browser fixtures do not certify
native detached-window delivery; packaged-app checks remain separate.

Verification for this UI update: all `npm run verify` gates passed (4,361
frontend tests, 458 Chromium browser tests; existing optional skips retained).
The six focused WebKit checks and the production frontend build also passed.
Narrow 360/440px panels at 100%/125% scale, exact cut seeking, idempotent adoption,
chapter preservation and the detached-panel notification are covered. These
changes were subsequently packaged and tested in 2026092107, as recorded below;
no installed app was replaced.

1. Settings → **Video Intelligence**, immediately below AI Summary: download
   the search model. Reranking and descriptions are separate optional downloads.
2. In Library, select local videos or a scanned folder, then open **Video
   Intelligence** and click **Index**. Opening the panel never starts indexing.
3. Describe a moment and Search. Refine matches uses the optional reranker.
   Click a result to open its decoded source time, or Describe for a concise
   explanation. Existing transcript cues in that range supply dialogue context;
   no new transcription is started.

Stop retains completed segments. Index again to resume. Remove index deletes
only the selected sources' derived data. Settings model deletion is separate;
neither operation touches original footage or existing transcripts.

## Ownership and safety

- Rust validates typed requests, owns cancellable JobRegistry children, and
  bounds the JSON protocol. A one-request subprocess owns MLX and local files.
  No inference server, user Python or Homebrew is needed at runtime.
- Explicit HTTPS downloads use pinned revisions, sizes and SHA-256 hashes.
  Inference is offline with remote code disabled. Missing models never trigger
  an implicit download. Completed artifacts are reused after interrupted
  downloads; an incomplete individual artifact starts again.
- One heavy video operation at a time. Models are released between embedding,
  reranking and reasoning. Playback, transcription and text AI have priority;
  yielded indexing must be resumed explicitly. A resident text model must be
  explicitly unloaded, not silently evicted during a conversation.
- Search requires 16 GB unified memory; descriptions require 24 GB. The MLX
  allocator is capped at 8 GiB and its cache at 512 MiB. This is not an OS-wide
  RSS limit or a guarantee against memory pressure from other applications.
- Indexes and downloaded weights live under the app data directory's
  `video-intelligence/`. No automatic library scan or face identification.

## Models and index

| Role | Pinned model | Download |
| --- | --- | --- |
| Search | Qwen3-VL-Embedding-2B, MLX 4-bit | 1.8 GB |
| Optional reranking | Qwen3-VL-Reranker-2B, MLX 4-bit | 1.8 GB |
| Descriptions | Qwen3.5-9B, MLX 4-bit | 6.0 GB |
| Optional audio evidence | AudioSet AST, MLX adapter | 346 MB |

Exact repositories, revisions and artifact hashes are in
`video-sidecar/models.json`. No Qwen Omni or 27B/35B model is included.

PyAV decodes at most eight frames per eight-second window, stepping six seconds
between windows, at up to 384 pixels on the longest side. Native MLX-VLM
Qwen processors receive actual decoded timestamps. The embedding adapter calls
the video backbone explicitly: the generic embedding forward currently drops
video tensors. Reranking scores at most twelve candidate moments; descriptions
use at most 512 generated tokens and bounded existing transcript context.
Generated timecodes are never used for navigation.

SQLite WAL transactions durably checkpoint segments and normalized 2048-element
vectors. HNSW (usearch) is a disposable, revisioned search cache; corruption
rebuilds it from SQLite. Identity includes full source SHA-256, path, model
revision and sampling policy. Changed/missing files are excluded; moved files
must be explicitly selected and indexed again. Identical copies at different
paths remain separately scoped. The current ceiling is 100,000 indexed windows.

## Build and verification

```sh
VIDEO_PYTHON=/path/to/python3.12 bash scripts/build-video.sh
VIDEO_TEST_PYTHON=/path/to/python3.12 npm run test:video
python3 video-sidecar/runtime_manifest.py verify \
  src-tauri/video-runtime/saucebunny-video --repo .
```

Build-time CPython is pinned to 3.12.14; dependencies and compiler inputs are
hash-locked. Wheel selection explicitly targets macOS 14 arm64, rather than the
builder's newer OS. The narrow FFmpeg 8.0.3 decoder is compiled LGPL-only and
PyAV is compiled against it. No vendor GPL codec wheel libraries or OpenCV
binary are included. Exact FFmpeg source, configure log, license texts and a
dependency-notice inventory travel with the worker. See THIRD-PARTY-LICENSES.

`build-app-with-ndi.sh` rebuilds the worker before Tauri packaging.
`verify-bundle.sh` rejects missing/stale payloads and native libraries above the
macOS 14 deployment floor; stub-sidecar CI builds explicitly do not certify it.
The runtime manifest records source/lock fingerprints and payload hashes;
Mach-O signatures/linkage are checked separately because release signing
changes signature bytes.

Tauri dereferences resource file aliases. The build also places `mlx.metallib`
beside the flattened `libmlx.dylib` alias; without that resource the macOS 14
Metal wheel can pass `--version` yet fail on its first GPU import. The runtime
gate requires matching shader payloads at both lookup locations. Acceptance
uses a dereferenced resource copy, not only the original PyInstaller folder.

Automated coverage includes checkpoint recovery, changed/missing sources,
scoped HNSW search, malformed vectors, fractional frame rates, EOF, download
hash/size validation, cancellation races, foreground ownership, and rendered
Settings/Library at narrow width and enlarged text. CPU tests require no weights.

`video-sidecar/smoke_worker.py` runs the actual frozen worker against a generated
14-second color fixture. It denies network via a macOS sandbox profile, removes
Homebrew from PATH, uses an empty Hub cache, tests cold-load Stop, indexes,
resumes, searches with reranking, and checks a Qwen description. This is a real
inference smoke test, not a retrieval benchmark on an editorial library.

Limitations: sampled visual retrieval and per-moment description, not full-film
reasoning, face recognition, native audio reasoning, or joint multi-clip
comparison. No long-library accuracy certification or packaged WKWebView
end-to-end certification is implied. No GitHub push, DMG publication or
installed-app replacement was performed for this implementation.

### Validation record

On this development Mac, the final source passed 4,267 frontend unit tests,
738 Rust library tests, three native service tests and 18 video-worker tests.
Existing ignored/native-desktop cases remain ignored; no live capture ran.
The full browser suite passed 449 tests in one run. The last complete gate run
had an intermittent existing transcript-search scrim test failure (448 passed);
that unchanged test subsequently passed three consecutive focused reruns.
Therefore this is not a claim of a consistently green end-to-end release gate.

The final app-style copied worker passed a network-denied generated-footage
smoke: indexing 17.28 s, resume 0.58 s, search with reranking 11.56 s, description
21.02 s, cold-load process cancellation 2.1 ms. These single observations include
model startup, ran alongside other tests, and are not p95 production targets.
Its 227 native payload copies passed linkage/signature/deployment-floor checks.
This does not substitute for running on a physical macOS 14 host or certifying
the complete application in WKWebView.

## Primary references checked September 15, 2026

- https://github.com/QwenLM/Qwen3-VL-Embedding
- https://huggingface.co/Qwen/Qwen3.5-9B
- https://github.com/Blaizzy/mlx-vlm
- https://ml-explore.github.io/mlx/build/html/install.html
- https://ffmpeg.org/legal.html

## Full-frame shot analysis integration, September 16

This is a separate path from the sampled retrieval index. The supplied Ella
detector is ported under `src/lib/scene-analysis/`; its scoring, thresholds,
full-frame iterator and sensitivity 95 are unchanged. Sensitivity is a detector
setting, not an accuracy percentage. Neither embedding windows nor model prose
may supply a cut count.

`startSceneAnalysis` creates a module worker and returns cancellation ownership
before awaiting native file metadata. A typed PROBE precedes START. The worker
uses MediaBunny `CustomSource` to request compressed byte ranges; the main window
only relays existing `get_file_size` / `read_file_range` commands and transfers
the resulting buffers. It never fetches the whole original into a Blob.
MediaBunny Input, every decoded VideoSample, canvas, pixels and features remain
inside the worker. Stop rejects outstanding reads, disposes Input, then sends a
terminal acknowledgement. Stale run messages and reads cannot complete a new run.

Intentional reference deviations:

- Sauce Bunny retains its installed MediaBunny 1.52.3 rather than the reference
  1.52.2. Ella's separate integration uses its existing 1.55.1. The reviewed
  fixture is tested in each integration, not assumed identical by version.
- START additionally accepts a native-file descriptor and the protocol includes
  compressed byte-range requests/results. There is no decoding or feature work
  on the UI thread. Cache size remains the reference's 8 MiB; this is not a cap
  on total decoder/feature memory.
- The exact hardware-preferred decoder configuration is probed, rather than
  only the codec's default configuration. Unsupported configurations produce
  `UNSUPPORTED_CODEC`; there is no reduced-rate or HTML-video fallback.
- Pipeline errors preserve the underlying failure message. Decoder cleanup
  precedes the terminal worker message.
- The ten reference unit tests use Vitest here; their assertions are unchanged.

### Browser checks

| Surface | Observed result | What it does not prove |
| --- | --- | --- |
| Installed Chrome, real worker and range bridge | 705 decoded frames, 11 cuts, exact reviewed indices; Stop under 1 second; malformed bytes and unsupported codec are typed failures | Packaged app performance or long-form memory |
| Playwright WebKit, real worker and range bridge | Same fixture and failure/Stop checks pass | Installed Safari or packaged WKWebView certification |
| Playwright headless Chromium | Default codec probe may pass while the hardware-preferred H.264 configuration is unavailable; now explicitly rejected | H.264 support on other Chromium distributions |
| Edge / Firefox | Not tested in the Sauce integration | No support claim |

Expected cut indices are `26, 61, 90, 121, 166, 340, 355, 374, 390, 513, 621`.
The 11 boundaries partition the full clip into 12 shots, not 11.

```sh
npx vitest run src/lib/scene-analysis
SCENE_REVIEWED_FIXTURE=/absolute/path/to/the-reviewed-fixture.mp4 \
  npx playwright test e2e/scene-analysis.spec.ts --workers=1
SCENE_BROWSER=webkit SCENE_REVIEWED_FIXTURE=/absolute/path/to/the-reviewed-fixture.mp4 \
  npx playwright test e2e/scene-analysis.spec.ts --workers=1
```

The fixture cases are explicitly skipped when that path is absent; the ordinary
suite still runs the malformed-media worker case. No user library is scanned.

### Connected preview path, September 16

The small Text / Advanced Intelligence switch now connects to the actual
detector and native shot reasoning operation. Existing text conversation and
draft state stay mounted; a mode change aborts text prompt pre-warming, but does
not silently unload the resident text model. Model readiness is checked before
proxy preparation, and missing weights require an explicit download in Models.
Source changes, transcript replacements, unmount, and Stop invalidate callbacks
across every asynchronous phase. Detached panels receive the completed local
source path through the existing panel bus; live program inputs withhold it.

`prepare-shot-proxy` produces H.264/yuv420p at at most 960×540, without upscaling.
Apple's VideoToolbox encoder runs in the owned Python process through the pinned
LGPL media libraries; there is no child encoder to orphan on Stop. Every frame
uses its actual source-relative integer-microsecond PTS, including VFR. A second
full decode must match the original frame count and SHA-256 of every signed
little-endian int64 PTS. The browser computes that same digest over its complete
MediaBunny iterator before accepting the versioned mapping. This protects the
bridge against differences in demuxing as well as encoder drops or duplication.
The source is content-hashed again before model analysis. A nonzero first frame
relative to the declared origin is rejected explicitly; complex edit lists are
not silently approximated. The implementation follows PyAV's documented
[rational stream/codec clocks](https://pyav.org/docs/stable/api/time.html).

Proxies are content/version-addressed under the owned `scene-proxies` directory.
The `h264-vt-540p-display-frames-v2` proxy bakes the source display orientation
into its pixels. Retrieval and shot-description samples use the same full
display matrix, including mirrored orientations; they do not feed sideways
coded pixels to the model. Unsupported affine/perspective transforms and
midstream geometry changes fail explicitly. The unrotated encoding path still
uses native PyAV scaling; transformed frames require an RGB transpose first.
Sampling versions and search-cache revisions exclude older derived results
until the source is explicitly reindexed. Originals are never modified.
The opt-in `VIDEO_TEST_H264_PROXY=1` tests compare all eight orthogonal
orientations against FFmpeg's independently autorotated pixels, then verify
actual VideoToolbox proxy output and preserved presentation timestamps.

The September 16 orientation checkpoint was frozen again from the existing
pinned dependencies, without installing models. Its current-recipe manifest,
201 bundled Mach-O signatures/linkage and macOS 14 deployment floor passed.
That verified runtime is staged in the development bundle; this does not
replace the installed app or certify packaged WKWebView. A network-denied
smoke on generated footage passed indexing, resume, search/reranking, visual
reasoning, proxy preparation and source-bound shot descriptions. Individual
observations on the development M4 Max: indexing 6.79 s, two-shot descriptions
4.63 s, cold-load cancellation 2.8 ms. The separate real-audio fixture run
returned all 527 labels over three windows in 1.39 s; model-load/inference
Stop took 1.7/7.0 ms, and restart completed. The Rust collector accepted that
actual recorded output only after its terminal success. These are smoke
observations, not accuracy calibration or percentile performance claims.

Only a verified complete directory is published. Proxy size is bounded at 2 GiB
and frame metadata at 3,000,000 frames. PTS hashing adds eight bytes per decoded
frame temporarily to the browser's existing timing array; this is not constant
total memory. A hard-killed process may leave an unpublished staging directory;
it is never reused. Cache-wide quota/cleanup and long-form soak remain open.

Immutable detector evidence, proxy identity and time-map version are committed
to the `sauce-scene-evidence` IndexedDB store before model descriptions start.
Editable/model text cannot mutate that evidence. Cues crossing a cut appear in
both adjacent shots without invented word timings. Full supplied text is kept;
per-shot model context is explicitly marked when limited to 12 KB. Requests are
batched under both the 64-shot and native JSON-size ceilings. Native answers must
return the same IDs, ranges, transcript and source identity. Eleven detector cuts
therefore mean twelve shots regardless of anything the model writes.

The generated 540p reviewed fixture passed in real Chrome and Playwright WebKit:
705 frames, the exact eleven reviewed indices, matching native/browser PTS
digests, twelve mapped shots, typed failure checks and Stop under one second.
The compact 440px panel test verifies draft/conversation retention, no implicit
download, and live-input exclusion. Native proxy tests include actual fractional
frame rates; VFR/nonzero-origin coverage is in the explicit hardware test gate.

The rebuilt frozen worker also passed the network-denied generated-footage
smoke with existing model weights and `/usr/bin:/bin` only. It prepared a
336-frame proxy, re-inspected its source, and described two supplied shots with
Qwen while preserving IDs, source-relative ranges and supplied transcript text.
Observed once on this development Mac: proxy 0.45 s, source inspection 0.14 s,
two-shot reasoning 5.48 s, cold-load process Stop 4.4 ms. These are single smoke
observations, not p95 targets, minimum-hardware results or WKWebView certification.
All 36 native worker tests passed with actual H.264 hardware tests enabled,
including VFR and a nonzero source origin. The recipe and 201 bundled Mach-O
files passed self-containment, signature and macOS 14 deployment-floor checks.

Full frontend rerun: 4,301 passed, 2 skipped. Full Rust rerun: 746 passed, 28
ignored. The first complete verification run exposed new styling-contract
violations (corrected) and an unrelated OBS pipe-EOF race (`WouldBlock`); that
untouched native test passed in the full rerun. The full browser suite passed
453 tests, with its opt-in cases reported separately. This records the actual
sequence rather than claiming the first full verification invocation was green.

### Rollout status: incomplete, internal opt-in only

The switch is hidden by default. Internal validation enables
`localStorage["saucebunny.shotIntelligence.preview"] = "1"` before opening the
panel; this is not a new end-user settings workflow. Remove that key to retain
the original text-only UI. An explicitly compiled internal preview can instead
use `VITE_SHOT_INTELLIGENCE_PREVIEW=1`; it exposes the same compact switch without
writing WebKit preferences or enabling developer tools. This is opt-in at build
time, not a change to normal release defaults. Label and archive such candidates
as internal previews. The newly pinned native runtime must be rebuilt with
`scripts/build-video.sh`; an older frozen worker cannot serve the new operation.
Model descriptions are currently session results, not a durable report export.

Do not enable the user-facing path before its source-change/Stop races and
packaged WKWebView behavior are verified. Minimum-laptop p95 throughput,
long-form memory soak, and the wider edit-list/VFR/rotation fixture matrix remain
open rollout gates. The full objective is not complete.

Music is not analyzed by Qwen's visual frames or supplied transcript text.
Actual-audio music classification remains a separate integration, not an inferred
claim in shot descriptions; native results currently report `audio_analyzed:false`.

Actual-audio feasibility checks on September 16 rejected the initially proposed
Hub `laion/larger_clap_music` checkpoint: its text vectors collapsed and controls
received nearly identical rankings under two Transformers versions. LAION's
original music checkpoint, strictly converted, produced distinct features but
still failed the musical control's music-presence test. Apple SoundAnalysis
separated the generated speech/music controls better, but also ranked music first
for silence at a low score. Neither top-label selection nor softmax is a safe
classification policy.

The [reproducible music-analysis diagnostics](../scripts/music-analysis/README.md)
record pinned checkpoint hashes, conversion, actual audio controls, measurements,
decoder limitations and remaining integration gates. Follow-up comparison matched
the converted CLAP model to the pinned original inference components, but its
current prompts still performed poorly on tested public audio. A supervised
AudioSet AST candidate separated these smoke controls more usefully. Its
MLX adapter matched the PyTorch reference over 24 windows, with
identical preprocessing; this is numerical parity, not classification accuracy.
The experimental `audio_pcm.py` / `music_analysis.py` path now decodes a selected
audio stream in-process, preserves source anchors and gaps, and feeds bounded
ten-second PCM windows into the AST candidate. Coarse packet timestamps are
validated before normalization to a region-relative sample clock; real gaps
flush the resampler instead of being joined. Generated AAC edit-list/gap cases,
fractional origins, cancellation and source-replacement tests cover this path.
The reviewed 23.5-second scene fixture produced three actual-audio AST windows;
their scores remain uncalibrated evidence, not a genre verdict.
The model catalog now offers an explicit AudioSet AST download. Once its verified
receipt is ready, the feature-flagged controller uses the owned `analyze-music`
worker instead of the native audio classifier. No download starts during analysis.
All 527 scores are retained as compact float32 vectors with one shared vocabulary;
Rust validates the streamed evidence and clean process exit before adoption.
The existing disclosure shows ranked raw suggestions, not a calibrated verdict.
No audio model or dependency was added to the installed app. The standalone
frozen worker has been rebuilt and tested with locally supplied weights, OS-denied
networking, and no Homebrew on PATH. Its actual windows pass the production Rust
collector; event-triggered Stop during model loading and inference yields no
adoptable partial result, and a new run completes afterward. Missing models fail
explicitly without download. See the [real-worker smoke instructions](../scripts/music-analysis/README.md#real-worker-offline-and-cancellation-smoke).
The first frozen completion took 12.36 seconds on this Mac, versus 0.90 seconds
for a new process after Stop; this is not a minimum-device or p95 claim.
The dereferenced Tauri-style resource copy also passed manifest/native checks,
the offline inference/cancellation smoke, and Rust packet adoption. Its first
completion took 8.13 seconds, followed by 0.86 seconds after Stop. No installed
application or permissions were changed for these checks.
The feature-flagged disclosure now includes a tentative music summary using
`audioset-music-summary.v1`. This experimental presentation policy requires
at least five seconds of context and a Music score of 0.5; a broad genre family
also needs a score of 0.1 and a 1.5 ratio over the next family. Correlated parent
and child scores use their maximum, not a sum. These are provisional review
thresholds, not calibrated probabilities or a measured accuracy guarantee.
Uncertain windows remain unclear, and the original ranges and all raw scores
stay intact. Suggestions do not identify song boundaries or claim that music
is absent. Policy calibration, durable audio results and packaged lifecycle
validation remain open; the feature flag remains off by default.

### Native audio evidence transport (internal, September 16)

`VideoRequest.analyze-audio` now runs a first-party Swift worker under the same
Rust job owner, Stop handling, foreground priority and child-exit validation as
video analysis. The feature-flagged AI Summary preview now requests it after
visual descriptions. It does not return a genre or calibrated music-presence
verdict. The installed app was not rebuilt.

- The request carries the inspected source SHA-256, analysis ID, source origin,
  duration and explicit audio-track index. Content is verified before and after
  decoding. A result is adopted only after matching terminal identity and clean
  exit; streamed windows alone are never a successful result.
- AVFoundation supplies local PCM, with external media references forbidden.
  CoreMedia's **output** timestamps retain edit mapping; raw packet timestamps
  do not. This adds a system-only native decoder instead of relying on the
  minimal Python video runtime's missing resampler or creating a full WAV.
- Retained PCM is one three-second, 48 kHz mono window. SoundAnalysis provides
  backpressure through synchronous per-window completion. Digital silence is
  recorded without classification; short tails remain `insufficient-context`.
  Non-overlapping three-second windows deliberately differ from the initial
  overlapping feasibility probe, so their scores need separate calibration.
- Generated AAC with a two-second timestamp gap exposed AVAssetReader flattening
  the audio timeline. The worker rejects a decoded/source-range disagreement;
  it does not publish the misplaced windows. Endpoint tolerance follows the
  actual container time-base precision or one output sample. Gap-bearing media
  still needs a timestamp-preserving decoder path before broader rollout.
- Native evidence includes raw scores, signal energy, actual covered intervals,
  OS/classifier and preprocessing identity. It is not a replacement for the
  immutable visual shot result, and it never infers sound from Qwen's images.

`npm run test:audio-analysis` runs generated-PCM native lifecycle tests, while
the existing Swift/Rust suites cover window timing and streamed-result adoption.
Set `AUDIO_TEST_FFMPEG` to a real bundled FFmpeg executable to additionally test
generated AAC origins/gaps (CI's sidecar stubs cannot encode those fixtures).
`npm run build:audio-analysis` stages only the helper, not a DMG or installed app.
Normal app builds now include it, and bundle verification checks its source
receipt, Mach-O build identity, system linkage and macOS 14 floor.

### AI Summary audio evidence (internal, September 16)

The existing Advanced Intelligence preview reads the first audio track of the
verified source after completing visual descriptions. Nothing runs on mount or
mode selection. Late results after Stop, source/transcript changes or unmount
are rejected; playback/transcription still own foreground priority. Audio errors
retain completed shot descriptions and supplied text, with the native reason in
a quiet optional disclosure rather than a fatal visual-analysis error.

The response is source/run-bound and deeply frozen before display. The compact
Audio evidence disclosure shows actual window ranges, digital silence and
unclassified short tails. It labels raw ranked suggestions as unverified, never
as detected genres or confidence percentages. Windows may cross multiple cuts;
their ranges are not copied into shot boundaries or represented as word/shot
timing. All original scores remain in memory; only three are shown per window.
Audio results are session-only, like the current visual descriptions.

The opt-in browser test accepts `SCENE_AUDIO_HELPER` alongside
`SCENE_PROXY_MANIFEST` to run the actual native decoder/classifier on that exact
reviewed source. The browser uses the real detector/controller, but visual-model
answers and the Tauri bridge remain test substitutes; it is not a packaged
WKWebView certification. No capture, playback or model download is involved.

To replace the visual-model substitute with real offline inference in that same
test, also set `SCENE_VIDEO_WORKER` to a verified frozen executable and
`SCENE_VIDEO_ROOT` to an isolated worker root containing the existing verified
models. The test supplies only the manifest-bound source, denies network access
at the OS boundary, and removes Homebrew from PATH. It checks all twelve actual
answers retain the supplied IDs, ranges and transcript, sampled frame PTS stay
inside their shots, and every returned description appears in its corresponding
UI row. It attaches the actual answers to the test report. The test bridge still
stands in for Tauri IPC; this mode does not certify packaged-app cancellation.

Checkpoint verification: the full automated gate passed (4,315 frontend tests,
756 Rust tests and 453 browser tests, with the existing fixture-dependent skips).
The opt-in reviewed-fixture run also passed all four checks in both Chrome and
Playwright WebKit with the real native audio helper. It displayed 12 shots from
11 cuts and eight audio windows, including the explicitly unclassified 2.5-second
tail. The disclosure was checked at 360/440 px and normal/125% text sizes. These
checks establish transport and UI behavior, not music-label accuracy or packaged
app performance.

Remaining: reviewed real-audio calibration (including pure tones, dialogue over
music and sound effects), tentative style-model packaging, persistent audio
evidence, validated per-shot music interpretation, and packaged WKWebView
validation. The music feature and overall scene-analysis/AI Summary goal remain
incomplete.

### September 21 packaging and source-binding checkpoint

Internal DMG build `2026092101` was rebuilt with the pinned Python 3.12.14
runtime. The app mounted from that DMG passed both bundle and packaged checks;
it is Apple Development signed, not a notarized distribution release. The
frontend suite passed 4,337 tests (three skipped). Four browser integration
checks passed; four fixture-dependent checks were skipped in this run. The
video-worker build ran 74 tests with one skipped. These results do not replace
the outstanding real-fixture, model-output, or packaged-WKWebView gates.

The frozen worker inside the mounted DMG also passed a model-free offline
smoke run with generated 23.976 fps footage: source inspection, 48-frame H.264
proxy creation, matching source identity and 2,002,000 µs time-map coverage,
and exact reuse of the completed proxy. Network access was denied, PATH excluded
Homebrew, no models were downloaded, and all four worker calls had empty stderr.
This verifies the delivered worker's loading/decoder path, not visual reasoning
or the WKWebView-to-worker command path.

`video-sidecar/smoke_proxy.py` reproduces this model-free packaged check using
the pinned build Python environment, an explicit packaged worker, and a new
output directory. It never scans media or downloads models. Its `report.json`
can drive `e2e/scene-proxy-roundtrip.spec.ts` with
`SCENE_GENERATED_SMOKE_REPORT=/absolute/output/report.json`. Run once normally
(installed Chrome) and once with `SCENE_BROWSER=webkit`. Both passed on
September 21: matching native/browser PTS hashes for all 48 frames, sensitivity
95, exactly one cut at frame 24 / 1,001,000 µs, and source ranges ending at
2,002,000 µs. This generated fractional-rate control does not replace the
separately reviewed 705-frame fixture or certify packaged WKWebView behavior.

The subsequent full verification command completed with 453 browser tests
passing and eight skipped. It was not a clean full-gate pass: the Rust suite
reported 760 passed, 29 ignored, and one OBS descriptor-closure test returning
`WouldBlock` where it expected EOF. That exact test passed in an isolated retry;
no OBS source was changed. The video-worker gate selected system Python below
3.12; rerunning with the pinned build interpreter passed 70 tests with four
opt-in cases skipped. Those retries explain the observations but do not turn
the original full-gate exit status into success.

A subsequent source-only validation fix rejects visual model responses whose
source path or timestamp origin differs from the immutable shot evidence.
Regression cases failed before the fix and passed afterwards, alongside the
60 focused scene/lifecycle tests (one skipped). This fix is newer than that
DMG. Audio responses already checked both fields.

Persistence audit: `saveSceneEvidence` currently appends detections only.
There is no reader, and descriptions and audio results are not stored. A
restore path must bind saved results to source content and supplied transcript,
retain model/preprocessing identities, and reject obsolete loads after Stop,
source replacement, or a new run. An evidence ID alone is not a reusable source
lookup: it includes the detector's per-run performance measurements. Do not
silently treat a path match as content validation or alter prior immutable
evidence IDs to make caching appear to work.

The detection writer now treats an identical retry as success within one
serialized IndexedDB transaction. A conflicting record under the same ID is
rejected without replacing the original. Transaction errors are reported after
abort rather than rejecting with a not-yet-populated `transaction.error`.
Real-browser storage tests cover concurrent duplicate saves, conflict rejection,
record survival across reload, and refusing a newer database version. This is
not a restore UI for descriptions/audio, and is newer than build `2026092101`.

### September 21 internal-preview desktop validation

Build `2026092104` was opened directly from its DMG with the normal application
identity. On generated 48-frame, 24000/1001 fps red/blue footage, actual Tauri
IPC and WKWebView completed detection and Qwen descriptions, reported two shots
and one cut, and adopted two explicit timeline markers. A second adoption was
idempotent. Stop during description work returned to idle without adopting a
late answer. These were desktop actions, not a browser IPC fixture bridge.

The same desktop test caught a fractional-rate seek defect: the second shot's
1.001-second source PTS passed through nominal 24 fps timecode conversion and
landed at 1.000 seconds, displaying the preceding red frame. AI evidence seeks
now use the existing source-keyed ReviewSession/controller path, preserving
source seconds and hidden-source guards. Detached panels retain their existing
exact-second bus relay; the normal transcript seek path is unchanged. Drawer
regressions exercise the real session/controller through to a player handle.
The `2026092105` retest exposed a second, independent boundary defect: WebKit
converts a `currentTime` assignment of 1.001 into 1.0009999, still selecting the
previous frame even through the exact-seconds route. An isolated real WebKit
decoder experiment reproduced this. `nativeSeekTarget` advances the assignment
only by floating-point precision, which WebKit converts to exactly 1.001. It
preserves zero/EOF, does not add a frame or a delay, and leaves the requested
command time unchanged. Unit tests and an opt-in real decoded-pixel test cover
the correction; `NATIVE_SEEK_FIXTURE` selects the generated smoke-shots clip.
The final packaged correction is tracked in build `2026092106`.

Final-artifact checks for `2026092106`: 4,355 frontend tests passed (three
existing skips), plus npm packaging/profiling/capture-policy checks, TypeScript
and scoped lint. The real WebKit decoded-pixel regression passed. The mounted
DMG passed strict deep signature, executable identity and bundle/package checks.
Its six audio-helper tests passed, as did three offline Qwen trials and
event-driven worker termination during loading/inference (no late completion).
The actual desktop app completed native Analyze and descriptions. Final native
picture/Stop/recovery sign-off remains pending: automation subsequently reported
`noWindowsAvailable`/`cgWindowNotFound`; the still-running app's accessibility
tree was readable, but video/canvas surfaces captured black. This was not
counted as successful picture verification or diagnosed as an app crash.

The full frontend suite after this correction passed 4,349 tests (three existing
skips), plus the npm packaging/profiling/capture-policy checks. TypeScript and
scoped lint passed. Six audio-helper checks also passed against the exact
mounted `2026092104` helper and FFmpeg: generated silence/classification windows,
source identity, mutation, cancellation, nonzero source origin and invalid gaps.
This validates audio evidence transport, not music-label accuracy.

The local Qwen weights are now available and verified. Model answers remain
fallible: some raw smoke answers invented text or treated supplied dialogue as
visible text. Human review is required. The unavailable original reviewed video
has not been replaced by this generated-fixture evidence. Description/audio
persistence, music calibration and public/notarized distribution remain outside
this explicitly enabled internal-preview delivery.

### September 21 final internal-preview checkpoint — 2026092107

The next candidate adds a remembered picture-model selector (9B default,
optional 4B), source filename visibility, a settings gear on the existing mode
row, and All/Picture/Transcript/Audio evidence tabs. Picture observations and
supplied transcript text have separate response fields. Embedding, reranking
and sound-classification models are not selected by the picture dropdown.

The 4B artifact is `mlx-community/Qwen3.5-4B-4bit` at revision
`0e7ffd5c629ef7719d4cbc04069232580bfa9d9c`; every manifest file is size/hash
pinned. Downloads are explicit, and missing/changed receipts disable inference.
Model selection travels through native request validation into the worker and
is recorded with results. The runtime remains conservatively restricted to
24 GB Macs for picture reasoning; no lower-memory certification is claimed.

The software AV1 path now includes BSD-licensed dav1d 1.5.3 with the existing
LGPL FFmpeg 8.0.3 / PyAV 16.1.0 runtime. Its pinned source archive and license
ship with the worker. Real generated AV1, AVC, and AVCHD-container fixtures
retained all 48 frames and their 24000/1001 presentation times. The originally
unidentified user file has not been reproduced; this is not a claim that every
camera's AVCHD variant is certified. Decoder failures identify source, codec
and stage, with raw diagnostic detail collapsed in the UI.

Frozen-worker 9B offline checks on generated footage passed three trials and
termination at model-loading and shot-analysis phases. Full run times under
concurrent build/test load were 17.52, 15.56 and 14.65 seconds; termination was
0.004 and 0.086 seconds. These are smoke checks, not model-quality benchmarks.
4B weight download/offline execution and final packaged desktop checks are
recorded separately in the delivery report; pinning is not an inference test.

#### Prior 2026092107 archive

The archived DMG is `Sauce Bunny 0.5.0 (2026092107).dmg`, 364,016,943 bytes,
SHA-256 `f373a54a995f6f78d9d49ff515ad817c5cd5db2d3b6282744df62a66862eb6e5`.
DMG integrity, mounted build number, exact built/mounted executable equality,
strict deep signing and bundle/package checks passed. This uses the existing
application identifier and Apple Development identity; no permission reset,
new test-app identity, Home/NDI change, GitHub publication or `/Applications`
replacement was performed. The preview is open directly from its read-only DMG.

Automated verification before packaging:

- Every `npm run verify` gate passed: 4,361 frontend tests (three skipped),
  761 Rust tests (29 ignored), 458 Chromium browser tests (12 optional skips),
  plus native/sidecar, packaging and policy gates. The video Python suite ran
  74 tests with four optional skips using the pinned build interpreter.
- Six focused WebKit checks, TypeScript, lint, production frontend build and
  `git diff --check` passed. Browser checks include narrow panels, cut/chapter
  separation, duplicate-safe persistence, exact seeks and detached callbacks.
  Browser IPC fixtures are not native detached-window certification.
- The final mounted worker's network-denied, Homebrew-free Qwen smoke passed
  three two-shot trials (5.54, 4.85 and 4.85 seconds), plus termination on the
  observed loading/inference events (3.9 and 129.7 ms, no adoptable completion).
  A terminated inference emitted a Python resource-tracker semaphore warning;
  subsequent full runs succeeded. Report:
  `/private/tmp/sauce-qwen-dmg-2026092107/report.json`.
- Its model-free proxy smoke passed exact 48-frame, 24000/1001 fps PTS/time-map
  and cache-reuse checks with network denied and no downloads. Report:
  `/private/tmp/sauce-proxy-dmg-2026092107/report.json`.
- All six audio tests passed against the final mounted helper and FFmpeg:
  silence, classified full windows, short tails, source identity/mutation,
  cancellation, nonzero origins and rejecting collapsed timestamp gaps. Log:
  `/private/tmp/sauce-audio-dmg-2026092107.log`.

Native desktop verification used that exact mounted executable, not a browser
bridge. Desktop screenshot access was available again; the earlier black
automation captures are not counted as successful checks retroactively.

1. The generated 48-frame red/blue source completed Analyze through actual
   Tauri IPC and Qwen. It displayed **2 shots · 1 cut**, described both colors,
   and truthfully reported no audio track. Add cut markers created exactly one
   marker at 1.001 seconds; a second click reported that it already existed.
   Clicking the cut displayed blue at frame 24; clicking shot one displayed
   red at zero. The visible native picture, not just the timecode, was checked.
2. The generated 24.024-second source (eight alternating shots, PCM tone) was
   loaded with an explicitly imported synthetic SRT. Stop during the observed
   description phase returned to idle with no descriptions adopted and audio
   marked not analyzed. The worker had exited; a later observation remained
   idle with no late results. A new Analyze completed all eight descriptions.
3. The completed run retained supplied transcript disclosures on shots 1, 5
   and 6 only, matching cue overlap. Shot one's disclosure reproduced the
   supplied text verbatim. Source audio was analyzed separately: eight full
   three-second windows and a 24 ms unclassified tail. Ranked SoundAnalysis
   suggestions remain explicitly unverified, not music-genre facts.
4. Explicit adoption added seven cuts at 3.003-second intervals, without a
   marker at zero. Clicking the 15.015-second cut displayed the corresponding
   blue shot at frame 360 and the expected supplied caption. Bottom tick
   placement and the compact count/action/switch layout were inspected in
   the native window. No media playback or capture was started.

These checks complete the scoped internal-preview workflow and generated-fixture
desktop acceptance, not the broader rollout or model-quality gates. Qwen still
produced unsupported prose in some observations (for example calling the sampled
shot “four frames”); its descriptions are not a verified frame count or factual
transcript. Human review remains necessary. The unavailable original reviewed
705-frame video is still unverified. Description/audio persistence, calibrated
music labels, wider hardware/real-footage evaluation, native detached-window
certification and notarized public distribution remain separate unfinished work.
