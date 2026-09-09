# NDI prototype — SDK integration delivery

> Connection UX and bundled-runtime work is now in progress. See
> [current delivery status](NDI-CONNECTION-DELIVERY.md) for authoritative progress
> and remaining gates. The external-runtime-only packaging and Video Monitor
> discovery blocker described below are historical.

Updated: 2026-09-06. Continues [the session-reliability delivery](LIVE-REVIEW-IMPLEMENTATION.md), preserving the existing uncommitted playback work. Experimental only: this is not a validated Premiere release, and the proof-gated DMG has not been built.

## SDK and build

The user supplied `Install_NDI_SDK_v6_Apple.pkg`. The NDI SDK is now installed system-wide. Its `com.newtek.NDI.SDK` receipt reports **6.3.2.0.260413**, and both headers and the external runtime are present under `/Library/NDI SDK for Apple`.

Build with the installed SDK:

```text
/Library/NDI SDK for Apple
```

Set `SAUCE_NDI_SDK_DIR` when building the native app. Without it, Sauce Bunny still builds, and the picker explicitly reports that native NDI support is unavailable. The bridge compiles against the supplied headers and loads `libndi.dylib` dynamically; neither the SDK nor runtime is copied into the repository or bundled for distribution. Explicit user choices take precedence, followed by installed runtimes and then the standard SDK fallback. NDI Tools 6.3.2 provides a standard runtime at `/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore/NDI_Transmit_AdobeCC.bundle/Contents/Frameworks/libndi.dylib`; the resolver now checks that location before the SDK. This was verified by invoking Sauce Bunny's actual discovery bridge against that installed library. Complete vendor distribution/licensing requirements before redistributing any runtime.

From the repository root:

```sh
SAUCE_NDI_SDK_DIR='/Library/NDI SDK for Apple' npm run tauri -- dev
```

The SDK installer is not NDI Tools. The official NDI Tools installation completed on 2026-09-05. Its Tools, Adobe transmitter, and Video Monitor receipts report **6.3.2.0.260413**. The machine has the required Premiere Pro 2026 **26.3.2**, the Adobe NDI MediaCore output plugin, and NDI Video Monitor **6.3.2**.

Run the read-only gate at any time:

```sh
bash scripts/check-premiere-ndi-preflight.sh
```

Static preflight now passes. In Premiere 2026, Mercury Transmit and NDI video are enabled, Primary Audio Device is `NDI output`, and `Disable video output when in the background` is off. This version exposes NDI audio through the primary-device dropdown rather than a separate `NDI Audio` label. The active Program Monitor reports Full playback resolution. macOS Local Network access is already enabled for Premiere 2026, NDI Video Monitor, and Sauce Bunny.

The actual Sauce Bunny discovery bridge finds `GASPERS-MAC-STUDIO.LOCAL (Adobe Premiere Pro)` using the SDK runtime, the Tools-installed Premiere runtime, and Video Monitor's own runtime. However, NDI Video Monitor's source menu still reports `No Sources Found Yet`, including after restarting Video Monitor. No custom NDI access configuration is present. This is an unresolved Video Monitor/discovery discrepancy, not proof of a Premiere 2026 incompatibility. The first actual-picture gate remains pending; do not build the test DMG until it and the subsequent host/guest gates pass.

## Implemented path

- In a hosted review room: **Share → Live input → NDI → Enable experimental NDI input**. Refresh discovery, explicitly choose a source, then choose **Use selected source**. The first prototype requires the host to remain the presenter.
- Discovery, status and telemetry cross the native boundary as generated Rust/TypeScript contracts. Preflight distinguishes an uncompiled bridge, missing runtime, incompatible runtime, no discoverable source, likely Local Network denial, disappeared selection and unavailable hardware encoding. Refresh never auto-selects the first source.
- The app declares `NSLocalNetworkUsageDescription` and `_ndi._tcp` in its source `Info.plist`. Bundle verification now asserts that both reached the final packaged app.
- Native NDI discovery and receiving use the SDK's actual function table, not guessed FFI layouts. Selection resolves a discovered name; peers cannot supply arbitrary NDI network addresses or local library paths.
- Raw BGRA picture and PCM audio stay in native code. NDI frame synchronization feeds a single AVFoundation encoder: hardware-required H.264 video, native AAC stereo audio, capped at 1920×1080/30 fps, 48 kHz stereo. Input aspect ratio is preserved. Video targets 6 Mbps, audio 192 kbps; actual output varies.
- One encoder produces independently decodable half-second fMP4 fragments. The local monitor receives them through the token-gated loopback proxy; guests have a dedicated encoded-program substream. The browser decodes only. This NDI path does not invoke FFmpeg or use hidden-video/capture/re-encode forwarding.
- The native ring holds four media fragments plus initialization. Each peer has an independent bounded send queue and write timeout. Stale readers skip whole independent fragments. Program readers have reserved admission capacity separate from background transfers, with higher QUIC priority. Browser packet parsing bounds individual records, not arbitrary network read sizes.
- A single mounted NDI monitor survives Clip/Review navigation. Camera and microphone use their existing separate conversation channels. Local program audio starts muted and has an explicit monitoring control. Starting NDI stops another active program share, not camera/microphone.
- Input stalls retain the last picture with a stale indicator. Stream/decode failures retain the video element and offer picture reconnection; reconnect also holds a captured last frame when the webview permits it. Runtime/start errors are visible. Audio meters, input resolution, output frame rate, received frames, receiver drops, encoder drops, input age and encoded bitrate appear in the input panel. The monitor labels its playback buffer, which is not glass-to-glass latency.
- An NDI source has its own review-document identity. Live notes use general/manual, unverified timing and a sequence/pass label. Hidden-file transport, file keyboard actions, captions and proximity annotations are disabled while live input owns the picture. A late file play completion is paused again. No Premiere sequence time is inferred from NDI timestamps.
- Source/start generations, scoped stop identities and presenter/session changes cancel stale work. Former presenters cannot activate an NDI picture. Receiver shutdown is tied to session leave/presenter handoff and app exit.

The frontend-design skill kept the picker and live-note controls aligned with the existing console rather than redesigning the workspaces.

## Verification

- 2026-09-06 follow-up: **7 NDI unit tests passed**, followed by the separately enabled native discovery test (**1 passed**) using the updated runtime resolver. The strengthened static preflight, shell syntax, and patch hygiene also passed. This adds discovery evidence only; actual Premiere picture, audio, latency, and remote-guest gates remain pending. The Mac already restarted after the NDI Tools installation. The `Test` sequence was played and restored to its original paused position, `00:02:03:04`; no sequence edits were made.
- Full frontend suite: **3,321 passed**, 2 opt-in profile tests skipped.
- Native SDK-enabled suite: **406 passed**, 20 environment-dependent tests ignored, plus 1 documentation test passed.
- Production frontend build, TypeScript and zero-warning ESLint passed. Existing Vite bundle-size/mixed-import warnings remain.
- SDK-free native compilation also passed with no warnings; a guest does not need NDI headers or a runtime.
- Complete browser suite: **318 passed**, 1 real-capture test skipped without its opt-in fixture. With the native capture supplied, both NDI browser tests passed, including the DOM-identity canary proving Clip/Review navigation does not replace the NDI video element. Tauri and HTTP routing are mocked in these browser checks; the decoded MP4 itself was produced by the real native NDI receiver/encoder.
- Local real-SDK harness: synthetic 1080p30 moving picture plus distinct stereo tones was advertised through an actual NDI sender, discovered, received and hardware-video-encoded. The 14-second run deliberately stopped sending picture/audio for four seconds. It produced 27 independent media fragments, reported `live → stale → live`, recovered both audio meters, and reported zero receiver and video-encoder drops. FFprobe confirmed H.264 at 1920×1080/30 and AAC at 48 kHz/stereo. Telemetry also reported input age and actual encoded bitrate. Chromium decoded the output into the review monitor. This exercises a stalled sender, not destroying/recreating Premiere's output or changing network interfaces.

Reproduce native capture (only synthetic media; no screen, microphone or user source captured):

```sh
SAUCE_NDI_SDK_DIR='/Library/NDI SDK for Apple' bash scripts/test-ndi.sh
```

The harness prints its temporary `program.mp4` path. Use it for browser decoding:

```sh
SAUCE_NDI_CAPTURE='/absolute/path/printed/by/harness/program.mp4' npx playwright test e2e/ndi-input.spec.ts
```

## Still required before broader delivery

1. **Prove the picture in NDI Video Monitor:** installation, static preflight, Premiere output settings, and native discovery are complete. Resolve Video Monitor's empty source list and select Premiere there before opening the Sauce Bunny picker. If Premiere 2025 works but 2026 does not, record the upstream compatibility blocker and stop before the DMG.
2. **Actual Premiere + macOS webview validation:** playback, pause, J/K/L, rapid scrubbing, parking, the required frame-rate matrix, sequence changes, backgrounding, sender disappearance/reappearance, audio monitoring and permissions. Synthetic NDI reception and Chromium playback do not substitute for Premiere/WKWebView testing.
3. **Real one-guest networking:** exercise the native encoded substream with a second Sauce Bunny installation under constrained bandwidth and background transfer. Prove reconnect, late join, presenter handoff, source stop and room leave. The guest must not need NDI Tools or the SDK. Then run the later 2–4-user, one-hour soak before calling the feature pilot-ready.
4. **Latency and A/V sync measurement:** no glass-to-glass latency or A/V drift claim is made. The native frame synchronizer and common encoded clock are implementation choices, not proof of sync. Measure local and guest delay plus perceived offset with a flash/beep source and real hardware. No adaptive bitrate is implemented yet.
5. **Memory and real diagnostics:** profile the required 30-minute local run and later one-hour room soak. A bounded application queue does not bound QUIC/OS buffering or total end-to-end latency. Audio encode failures/drop telemetry and sustained hardware overload need additional coverage.
6. **Packaged proof:** only after the Premiere and one-guest gates pass, build with `SAUCE_NDI_SDK_DIR='/Library/NDI SDK for Apple' npm run build:dmg`. The packaged verifier now rejects a missing native bridge, missing privacy keys, a linked/bundled `libndi.dylib`, or existing signing/sidecar/CSP/license regressions. Install that DMG and repeat discovery, picture, stereo, stall recovery and Clip/Review navigation.
7. **Review groups and compatibility limits:** sequence/pass labels are currently reviewer-local, not an editor-owned room-wide pass-change command. A restarted receiver creates a new live-source identity. Screen sharing retains its older path; full review snapshots retain the 2 MiB limit; old hosts cannot provide the durable note acknowledgement. Automatic verified timing, Premiere marker insertion and remote Premiere transport remain excluded.

This prototype should remain opt-in until those gates pass. There is no approval workflow, bundled runtime or rebuilt DMG in this delivery.
