# Local-first playback with automatic high-quality promotion

Implementation build ID: `2026-09-10-local-first-auto-quality`.
This batch does not publish a DMG or push GitHub changes. It does not change
NDI, folder styling, playback layout, exports, or persistent media formats.

## Transport ownership

`presentation-playback.ts` owns the active engine and a separately mounted
standby. Play and settled seeks use the completed local copy without waiting
for a source resolver, FFmpeg, streaming seek, or high-quality buffer.

The standby is muted from its first render. Once actual buffered media permits
it, the controller makes one in-buffer alignment to a near-future frame, then
runs the standby silently. Promotion during forward 1× playback requires:

- Fresh, advancing decoded-frame observations, synchronized within one source
  frame of local playback.
- Five contiguous seconds ahead, or the available remainder near EOF.
- A current generation, no seek/failure, and an observed required audio track.

The old output is muted and paused before the new output is unmuted. Only the
selected engine can publish clock/transport events to captions and transcripts.
The user's mute preference is stored separately from internal standby muting.

Paused promotion remains exact-frame with two seconds of playable headroom.
A qualified already-active high-quality engine survives Pause/Play, including
native adapters that invalidate callback generations on Pause. Readiness is
rechecked, including buffer eviction, when Play is pressed.

Preparation has a 20-second deadline. An unsuccessful attempt or playback
fallback suppresses further attempts for that playback run. Pause, a new settled
seek, or a new source permits another attempt. Dragging unmounts the standby.
There is no per-tick network seek/rebuild, second full-resolution download, or
persistent high-quality cache. The existing approximately 30-second MSE
backpressure ceiling remains in place; native preload is only a browser hint.

## Failure and acquisition behavior

- A genuine high-quality `waiting`, decoding failure, stale decoded picture,
  or clock/frame desynchronization returns to local playback. Recovery cannot
  reverse the already-reported playhead.
- Source resolution, buffered readiness, and active high resolution have
  separate diagnostics. Fetches include an opaque request identity and source/
  pipeline generation, never a signed URL.
- FFmpeg stderr drains independently of backpressured stdout, retaining only
  an 8 KiB tail and at most 1,200 sanitized diagnostic characters. Cancellation,
  upstream rejection, expiry, rate limiting, timeout, local proxy errors, and
  premature stream completion are distinguishable. Known audio-URL expiry is
  considered as well as video expiry.
- Metadata/resolution requests coalesce matching in-flight work and short
  repeated requests. Rate-limit failures are retained for at least a minute;
  no automatic retry is scheduled. Downloader resolve timeouts kill/reap their
  process instead of leaving the timed-out resolver running.
- Ordinary public YouTube loads try without cookies first. Only an explicit
  authentication failure permits a selected-browser retry. Generic 403, 429,
  timeout, cancellation, and permission failures cannot cycle authentication.
- Optional high-quality resolution waits for local-copy completion. Refresh
  results cannot replace a working active stream; a known expired URL permits
  one fresh resolution. An already-expiring replacement does not cause a loop.

## Safari, signing, and runtime

Safari access is `checking` in the UI, then `readable`, `denied`, `missing`, or
`error`. The backend checks yt-dlp's legacy and container cookie locations.
Missing files are not permission denial. Focus rechecks reject stale results.
Neither public/cached loading nor these checks automatically open privacy
settings. Cookie readability/selection is not presented as proof of valid login;
observed downloader extraction is reported separately.

Deno 2.8.0 is checksum-pinned and explicitly passed to yt-dlp. Setup fetches it
from the official release; the bundle carries it and its license. The existing
verified yt-dlp updater and rollback remain intact.

Local app build entry points require a stable signing identity instead of an
ad-hoc fallback. The internal playback harness uses Apple Development, a
separate `com.saucebunny.playback-test` identifier, and no production URL scheme.
Distributed releases require the Developer ID/notarization preflight. Moving
from an ad-hoc build can require a new user-granted macOS permission; no privacy
database reset or automatic grant is implemented.

## Verification

Automated coverage includes the 4,610-second / 24 fps source with 1,919.0 and
repeated 2,113.9-second seeks, plus 105.7/67.8-second regressions. It checks
matching pending requests (including a still-empty initial pipeline), drag
suppression, decoded readiness, missing audio, buffer gaps/eviction, source
changes, stale callbacks, non-1× playback, exact paused frames, isolated clocks,
volume/mute, EOF, fallback suppression, and native pause-generation changes.

The full verification entry point is `npm run verify`: TypeScript, unit tests,
lint, Rust compile/tests/Clippy, Swift build/tests, licenses, and browser E2E.
The final run passed all gates: 3,599 JavaScript tests (2 skipped), 493 Rust
tests (20 ignored), 11 Swift tests, and 359 browser E2E tests (4 skipped).
The production frontend also built successfully.

Native checks use `harness-playback/` with production components in a packaged
WKWebView, a real completed 480p cached web copy, and matching H.264/AAC 1080p
test media through the existing Rust FFmpeg/MSE route. Initial measured runs:

| Check | Result |
| --- | --- |
| 20 warm resumes, initial native run | picture p95 41 ms; rendered PCM p95 29 ms |
| 20 warm resumes, independently identified signed build | picture p95 40 ms; rendered PCM p95 28 ms |
| 20 warm resumes, final signed executable with focused window | picture p95 41 ms; rendered PCM p95 28 ms; 0 redundant rebuilds |
| Initial-target redundant rebuilds in those 20-run batches | 10 before correction; 0 after correction |
| Running promotion with delayed high-quality fetch | passed on both earlier runs and the final executable |
| Withheld delivery until genuine buffer starvation | returned to local picture and rendered audio on all three runs |
| Two consistently signed builds, reported public YouTube source | 3840×2160, 24 fps, 4610 seconds resolved while Safari was denied |

The approximately 31-second interval in starvation reports is **buffer drain
time after withholding delivery**, not a 31-second recovery timeout. Warm-resume
audio measurements observe rendered PCM, not a physical speaker/interface.

Two unfocused attempts on the final executable timed out while sampling
advancing picture/audio (runs 18 and 7). They are retained in the native report,
not counted as successful batches. After explicitly focusing the test window,
all 20 samples completed. This is consistent with background/occlusion
throttling, but does not establish background-window latency guarantees.

The final tested executable SHA-256 is
`4dcf537839b6d28b375a916619f03cf61aa6c5d8cc17f44b13b7762708bd5ed9`.
Its designated signing requirement matches the preceding Apple Development
test build. The installed production app remains build `2026090905`; it was
not overwritten by the isolated verification bundle.
The final app was launched with `PATH=/usr/bin:/bin`. Its bundled Deno 2.8.0
was also invoked directly under that PATH. This verifies the pinned runtime is
usable without Homebrew on PATH, not that Homebrew was uninstalled from the Mac.

### Limits that remain explicit

- Safari was genuinely denied in the test app. Public acquisition succeeded
  anyway, but retention of an already-granted Safari permission across two
  signed upgrades still requires a user-granted permission test. Denied→denied
  is not evidence of grant retention.
- No Developer ID identity/notarization credentials were available for a
  distributed build; the internal app is not a notarized release.
- The native throttling fixture verifies real WKWebView/FFmpeg handoffs, not
  long-duration playback from every live CDN. External YouTube restrictions
  remain possible and must leave the working local copy intact.
