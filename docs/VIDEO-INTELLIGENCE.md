# Local video intelligence

Implemented in source and a standalone frozen Apple Silicon worker. Not yet
installed or published in a new DMG. This feature does not change Home, existing
transcription engines, text AI providers, or original media.

## Use

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
the original text-only UI. The newly pinned native runtime must be rebuilt with
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
unregistered MLX adapter matched the PyTorch reference over 24 windows, with
identical preprocessing; this is numerical parity, not classification accuracy.
No audio model or dependency was added to the installed app; source-time coverage,
classification policy, music integration and packaged validation remain open.

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
