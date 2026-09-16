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
