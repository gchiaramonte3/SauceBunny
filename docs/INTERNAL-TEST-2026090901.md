# Internal test: 0.5.0 / 2026090901

September 8, 2026 local build (September 9 UTC). This is a numbered internal
test installer, not a new public semver release. NDI remains experimental.

## Verified installer

`Sauce Bunny 0.5.0 (2026090901).dmg` is archived in the Desktop's
`Sauce Bunny Builds` folder. The release builder completed; automated bundle
and packaged-resource checks passed. Read-only mounting independently confirmed
build 2026090901, the exact compiled executable, companion 0.1.6, and the approved
NDI 6.3.2.0 runtime. The app inside the DMG passed strict deep signature
verification, and the DMG's checksum verified. Signing is ad-hoc, not Developer ID.

The build-directory app acquired Finder metadata after signing and failed its
strict check; the actual mounted installer app did not contain that detritus
and passed. The installer itself, not that mutable build folder, is the artifact
verified here. No installed application or Premiere project was replaced.

SHA-256:

```text
10c001e79c33be4d58fceaa0214d955931506f007c98225b8ac596117cc0e212
```

## NDI continuity correction

- Preserve the next retained encoded fragment after a brief reader delay.
  Previously, falling three fragments behind discarded two available fragments
  and introduced holes in both picture and sound. The native ring now retains
  eight complete fragments, matching the decoder queue's bounded capacity.
- Let ordinary append/seek delays settle before requesting another catch-up
  seek. The old policy produced 47 seeks in 20 seconds in the native webview.
  Catch-up still handles actual gaps and sustained overload, but never seeks
  backward when playback reaches the live tail.
- Wait for buffered media before starting playback. Playing the first 100 ms
  fragment immediately could exhaust the sound before the next append finished.
  Startup is driven by SourceBuffer updates, not an arbitrary sleep.
- Keep one media element and its common audio/video clock. No extra audio
  pipeline, source auto-publication, or Premiere timeline edit was introduced.

## Regression evidence

- Original code failed the retained-fragment test and the delayed-seek model.
  The original startup also failed the real-media sustained-audio test.
- Full frontend suite: 3,525 passed, two skipped. Native suite: 476 passed,
  21 ignored. Browser suite: 359 passed, four opt-in cases skipped. TypeScript,
  lint, Clippy, Swift build/tests and license checks passed. The 35 companion
  tests also passed.
- Native 24-fps and 60-fps synthetic captures exercised the actual NDI receiver
  and H.264/AAC encoder. The final 60-fps run verified contiguous packet
  timestamps for both tracks, including the concurrent preview capture.
- Three sustained browser runs per capture replayed actual encoded stereo
  tones with repeated 200-ms delivery interruptions. The 24-fps capture had
  no observed silence, frozen clock, seeks or waiting events. The 60-fps
  capture had no seeks, waiting events or frozen clock; the longest quiet
  observation was 22 ms, below the 100-ms failure threshold.
- Native WKWebView with parked Premiere input: 601 encoded frames over
  20 seconds, no seeks, waiting, stalls or pauses. A separate 15-second moving
  Premiere check during build activity had one gap-recovery seek/wait and
  otherwise advanced normally. This is not a zero-drop guarantee under load.
- GitHub's unit-test job now also runs the runtime-packaging/profiling tests.
  The SDK-dependent sustained-media gate remains an explicit local command in
  [NDI media acceptance](NDI-MEDIA-ACCEPTANCE.md).

## Review verdict: Ship it for internal testing only

The continuity regression has targeted failing-before/passing-after coverage.
This review covers the continuity fix and packaging path, not an exhaustive
independent re-review of every earlier feature included in the snapshot.

### Bugs

The confirmed retained-fragment, catch-up-loop and startup-starvation defects
were corrected. A full long-running moving-source and second-Mac guest soak
remains outstanding; the single native gap recovery under load is recorded above.

### Principles

The existing transport, source-selection lifecycle, media clock, privacy gates
and cancellation ownership are preserved. No parallel transport was introduced.

### The "no" list

The queue is a bounded memory/backpressure boundary; packet and time budgets
are documented beside the code and checked against real native append delays.
No production sleep was added to wait for decoding. Test timers deliberately
model network interruption and measure continuity; they are not shipped code.

## Distribution limits

Apple Developer ID/notarization credentials are not configured on this machine.
The requested DMG is therefore ad-hoc signed and must not be advertised as a
notarized release. No public GitHub Release or version tag is created. Source
updates are pushed separately; private media, pairing credentials, SDK files,
generated installers and build caches are not committed.

The included Premiere companion is 0.1.6. Automatic timeline-marker placement
and verified sequence timecode remain disabled/unproven. These continuity tests
do not establish end-to-end delay, A/V offset, or a one-hour real-room soak.
