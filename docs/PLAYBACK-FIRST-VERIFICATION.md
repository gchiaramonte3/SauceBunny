# Playback-first verification — 2026-09-09

Implemented for completed ordinary web review copies in the shared Clip/Preview
monitor. Local seek completion does not await a presentation seek. High-quality
promotion requires a matching confirmed source frame and contiguous playable
A/V buffer; it is restricted to paused transport. Play rechecks readiness.

## Automated gates

- Full `npm run verify`: passed TypeScript, unit tests, lint, Rust compile/tests,
  Clippy, Swift build/tests, licenses, and browser E2E.
- Final unit run after additional test-only coverage: **3,582 passed, 2 skipped**;
  packaging/profiling script tests also passed. Lint passed again.
- Rust: **484 passed, 21 ignored** (opt-in/native/nightly cases not asserted as run).
- Swift: **11 passed**. Browser E2E: **359 passed, 4 skipped**.
- `npm run build`: passed; existing large-chunk warning remains.
- Native harness TypeScript check and `git diff --check`: passed.

Coverage includes delayed resolution/seeking, stale completions, source refresh,
Play/Pause races, exact/fractional frame identity, buffer gaps and eviction,
repeated 105.7s/67.8s targets, no preparation during drag, duplicate fatal events,
HTTP 403/502 failures, local fallback, single-clock time publication, EOF,
volume/mute, StrictMode, and truthful active-engine speed reporting.

## Packaged WKWebView

Tested a separate unsigned **Sauce Playback Test.app** on macOS 26.5.1. This
imports the production players and uses the actual Rust/FFmpeg/MSE path, with a
completed 480p cached web clip and a matching 1080p test transcode of its existing
cached export. No Internet download, DMG, installation replacement, or publication.

Final 20 warm resumes (10 unresolved HQ source, 10 HQ fetch delayed by 1800ms):

| Measured after Play | p95 | Target |
| --- | ---: | ---: |
| First advancing canvas picture | 42 ms | <=300 ms |
| First nonzero rendered Web Audio PCM | 30 ms | <=300 ms |

Targets repeatedly exercised: 43, 67.8, 105.7, 68.3, and 20 seconds. Local
seek-to-frame completion in this run ranged from 15 to 55ms. Source resolution,
React state changes, and `play()` promise completion were not used as latency
proxies.

The separate recovery check promoted a buffered paused frame at **43.000s**,
started native high-quality playback, and withheld further bytes after 1.5MB.
A genuine native `waiting` event returned playback to local picture/rendered
audio at **46.013s**, about **3.294s after Play**—the time until the supplied buffer
ran out, **not** a measured 3.294s fallback delay. It did not await the 20s fatal
pipeline timeout. No synthetic `waiting` event was dispatched.

Reproduction: [native harness](../harness-playback/README.md).
Per-resume measurements and recovery diagnostics:
[results JSON](../harness-playback/results-2026-09-09.json).

## Limits

The harness uses the existing local-file proxy registration for deterministic
FFmpeg input; it does not exercise Internet CDN throughput or actual signed URL
expiry. Those failures have automated coverage. Audio measurement proves rendered
PCM, not acoustic output through a particular speaker/interface. Native HLS and
progressive adapters have automated readiness/preload coverage; the packaged
measurement uses the split/MSE path. These results are not a performance guarantee
for every Mac or media file. NDI, peer quality policy, exports, and original-media
resolution remain outside this change.
