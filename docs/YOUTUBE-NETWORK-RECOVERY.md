# YouTube download network regression

## Reproduction (September 8, 2026)

The reported review download did eventually finish: the first track completed,
then audio arrived and the merger produced a playable file. The apparent hang
was a connection delay, not evidence of a rejected sign-in. A later remote
presentation seek also failed. yt-dlp 2026.08.19 was already the current stable
release and was also the user's active override.

An isolated comparison used the same public 149-second source and the same
H.264/AAC formats (135 + 140), without browser cookies:

| Route | Video transfer, including connection | Audio transfer, including connection |
| --- | --- | --- |
| Default, 15-second socket timeout | 30 seconds | 15 seconds |
| IPv4 | Under one second | Under one second |

Fragmented video was fast without IPv4, but its audio still took 60 seconds.
Changing the format order alone therefore did not fix the cause and was **not**
shipped. The existing quality cap, codecs, and format fallback order stay intact.

The IPv4 file was 854 × 480 H.264 with stereo 44.1 kHz AAC and a duration of
148.793 seconds. Decoding its first 12 seconds measured -24.0 dB mean audio,
not silence. A fresh IPv4 1080p presentation resolve also fed the bundled
FFmpeg successfully at 0 and 68 seconds (4.5 and 5.2 seconds respectively to
produce a short muxed sample); both samples contained video and stereo audio.
These are local observations, not guaranteed download or seek times.

## Shipping boundary

`ytdlp(app, url)` applies the shared network policy to both the updated and
bundled executable. YouTube, youtu.be, youtube-nocookie and googlevideo hosts
use IPv4 for extraction and downloading so signed URLs use the same address
family. Other sites, including IPv6-only sources, retain their normal routing.
No macOS networking, browser credentials, security permissions, NDI code, or
media format selection is changed.

Preview downloads also have bounded socket retries, reject missing fragments,
retain the actual downloader error, and settle the frontend on unexpected
event-channel closure. A per-track 100% does not mean the merged copy is ready.
Timeouts and HTTP 429 do not trigger another full download without cookies.

This does not bypass private-video restrictions, sign-in requirements, or
rate limits. Those are reported separately and still require the appropriate
user/site action.

## Regression checks

- `youtube_network_tests`: real-host matching, lookalike-host rejection,
  non-YouTube routing, both binary selection paths, and error classification.
- `src/hooks/use-web-playback.test.ts`: no cookie retry on timeout/rate limit;
  existing source-change, cancellation, completion, and recovery tests remain.
- The existing ignored `nightly_ytdlp_recognizes_every_long_flag_we_pass` test
  checks these flags against the actual bundled executable's help output.
- Before handing off a build, cold-load an uncached public YouTube URL in the
  packaged app. Verify video **and** audio finish, the merger completes, and
  playback plus seeking work. A cached open or a successful metadata resolve
  alone is not this acceptance test.

For future diagnosis, compare the exact same formats with and without
`--force-ipv4`, retain the socket timeout, and inspect the completed file with
the bundled FFprobe. Keep signed media URLs and browser cookies out of reports.
Do not infer a bot block just from a quiet downloader.

## Native app acceptance caught a second failure

Build 2026090902 cold-loaded the uncached `youtu.be` alias through the real
installed app. Initial source/cookie loading took about 20 seconds, but both
tracks transferred and merged at 22:36:16 in less than one second. The resulting
local file passed FFprobe and a non-silent AAC decode. This was not a cache hit.

The follow-up Play/seek check exposed a separate presentation handoff stall.
One unsafe wait in the paused native layer required a **new compositor frame** while hidden
behind the review copy. A seeked/decoded frame was insufficient for the old
code to finish that wait. Repeated Play retried the same handoff. This matches
the [rVFC contract](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback):
the callback observes new compositor submissions, not every available frame.

`confirmDecodedFrame` now prefers the compositor timestamp but has a guarded
event-turn decoded-frame fallback: HAVE_CURRENT_DATA, not seeking, nonzero video
width, and the same source/seek generation. An MSE landing also requires no
pending rebuild/landing and a clock within 250ms of the requested position.
An already-landed zero-distance request can complete without a new seeked
event. There is no fixed delay; missing data never becomes a successful seek
merely because time passed.

If the high-resolution seek actually reports unavailable, the wrapper reports
the fallback and continues with the completed review copy. Pause supersedes
an in-flight handoff; a late callback must not restart playback. High-resolution
presentation remains the preferred playback path, not a disabled feature.

Native re-testing also found a stream-replacement race: cancelling a reader
resolves its pending read with EOF. The loop checked generation before that
await but not after it, so the cancelled stream could end the replacement
MediaSource. A controlled-reader test reproduced this against the old code.
Generation checks now guard read results and buffer callbacks; an
AbortController also cancels requests that have not returned headers yet.

Regression coverage includes the real MSE component with controlled buffer
delivery (zero-distance, superseded and undecoded seeks), callback generation
guards, no-rVFC fallback, a failed high-resolution landing, and Pause mid-handoff.
It also exercises late cancelled EOF and teardown before response headers.
These simulated media events supplement, not replace, installed WebKit testing.

## Test installer: 0.5.0 (2026090903)

The final test image is `Sauce Bunny 0.5.0 (2026090903).dmg`.
SHA-256: `f4445181d59613ab9f30b9e3315225abaffed46008918b3b490dad8b5bb76b47`.
It contains Premiere companion 0.1.6 and the verified NDI runtime 6.3.2.0;
this batch does not alter the previously committed NDI continuity code.

The image passed `hdiutil verify`, read-only mounting, and strict deep
signature verification of the app inside. That exact app was installed and
its signature verified again. Staging uses `ditto --norsrc --noextattr` so
Finder metadata from the build folder does not invalidate the sealed app.
The standard package-content and sidecar checks passed as well.

The installed final image resolved the public test source to 1080p split
presentation, played from the start, rebuilt at 110.4 seconds and resumed
past 131 seconds without a no-data timeout or fallback to the 480p review
copy. This final open used the previously verified downloaded copy; the
cold-download evidence above is separate. The installed executable SHA-256
matches the mounted image:
`a113921b3b711106f7a6f958153dc7c2794778e28a8b82bd8bdd64c94a5c8f4d`.

This is **ad-hoc signed and not notarized**. It is an internal test installer,
not a Developer-ID-signed public release. No release/tag or GitHub upload was
created by this batch.

Verification: 3,540 frontend tests passed (2 skipped), lint and TypeScript
passed, and the browser suite passed 359 tests (4 skipped). The earlier full
native gate passed 480 tests (21 ignored); the native network implementation
has not changed since that run. Both new cancellation tests failed against
the previous implementation before passing against the fix.

## Review verdict: Ship it for internal testing

Scope: the download-network and playback delta after `62e6b3b`, not a new
audit of every pending change on the branch or a long-run NDI acceptance test.

### Bugs

Fixed the cancelled-reader EOF ending its replacement stream, cancellation
before response headers, stale buffer callbacks, and a hidden/paused layer
waiting indefinitely for a new compositor submission. Source changes also
invalidate local frame confirmations.

### Principles

The network policy remains in the existing command factory for both binary
selection paths. Frame confirmation is shared by the two native players;
there is no new playback transport, clock, or persistence format.

### The "no" list

The initial fixed 100ms frame wait was removed during pre-push review.
Readiness now uses decoded media state after the actual event, with no
delay-based success. Download timeouts bound a real network operation, and
failures remain visible rather than being silently retried as sign-in errors.
