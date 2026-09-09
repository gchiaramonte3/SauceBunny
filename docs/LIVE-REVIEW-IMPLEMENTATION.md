# Live review implementation — delivery 1

Date: 2026-09-05. Base checkout: `main`, `44c9565`, with the existing uncommitted download-first/playback work preserved.

**Subsequent delivery:** The user supplied the NDI SDK and the experimental native receiver/encoder, source picker and encoded program channel are now implemented. See [NDI prototype delivery](NDI-PROTOTYPE.md) for current verification and remaining gates. The missing-SDK statements below describe the earlier reliability-only delivery, not the current checkout.

This is the **session-reliability delivery**, not a completed NDI integration or a validated release candidate. No new approval workflow was added. No DMG was rebuilt in this delivery.

## Implemented

### Saved notes and source identity

- Additive deletion tombstones survive save/reload, old snapshots, and reconnects. Explicit undo records a restoration; a stale copy is not a restoration. Frame-based marks and existing documents remain readable.
- Review operations carry protocol, operation, review, version and session identities. The host assigns revisions and a logical timestamp, persists the document and index, then acknowledges storage. Duplicate retries replay the canonical committed operation.
- Outgoing operations are written to the local outbox **before** optimistic display or transmission. Successful IPC does not mean saved delivery. Failed writes keep the draft; failed network sends keep the operation. Corrupt existing outbox data is not overwritten.
- Pending delivery is visible as locally saved/waiting to sync; an acknowledged operation is synced. The queue is not silently truncated at its warning threshold.
- Late joins receive a targeted source/document/offer snapshot, without clearing the room's source or existing offer.

### Playback and room lifecycle

- Playback actions emit immutable commands directly; heartbeats repeat the command identity and report media state. Repeated heartbeats do not restart a pending seek.
- Programmatic file-review seeks use the shared playback controller, including the detached-panel seek adapter. Requested and confirmed positions are kept separate while seeking.
- Requested playback rate is separate from the engine's temporary correction rate. Correction restores the presenter's exact base rate after convergence. A slow landing does not trigger a hard-seek loop.
- Guest browsing preserves the paused-room/playing-room behavior. Command watermarks, clock estimates, and pending completions reset between rooms. A stale initial state response cannot overwrite a newer pushed state.
- Switching directly between rooms rebuilds camera/microphone connections even if member ids are reused. An existing share is stopped rather than carried into a different room.

### Program picture, conversation and notes

- The monitor selects the presenter's explicit program stream, not the first peer marked as sharing. Program video/audio have dedicated RTC senders/receivers, independent of camera and microphone tracks.
- Program audio has its own mute/volume controls. Screen sharing does not replace the microphone or camera, and microphone audio is not mixed a second time into the program feed.
- The underlying player remains mounted. While a remote program feed is visible, file transport/captions/proximity annotations are suppressed; file-time note actions are disabled.
- Live notes carry a program source identity and sequence/pass label, with optional **manual, unverified** sequence timecode. They never borrow the hidden file's clock and are excluded from automatic file markers. Markdown preserves their labels and manual timing.
- A draft composed before a monitor-source change is retained and requires an explicit re-anchoring action. Drawings on the previous picture are not silently moved to the new picture.
- Stale received tracks retain the video element and show a last-frame warning. This is not yet an NDI disconnect/recovery implementation.

### Performance and diagnostics

- Native control traffic uses independent per-connection writers with bounded queues (512 items / 4 MiB), 5-second write timeouts, and coalesced replaceable presence/same-command heartbeats. Durable operations are ordered; an overflowing peer is disconnected so its persisted outbox can retry.
- Background file transfers have lower QUIC priority and an aggregate 512 KiB/s budget. RTC sender replacement starts independently for each peer and coalesces obsolete track changes.
- The existing screen-share bridge limits its JavaScript read queue to 4 MiB, evicts old decoded buffer ranges, and catches up within decodable buffered media instead of dropping arbitrary encoded bytes. This does **not** establish a firm end-to-end latency bound.
- Review document subscriptions are keyed, row callbacks are stable, and the thread list skips unrelated composer edits. No virtualization was added without browser profiling evidence.
- On-demand received-program diagnostics show available resolution, frame rate, bitrate, dropped frames, and receive-buffer statistics. Receive-buffer time is not end-to-end latency. A/V drift explicitly reports “not measured.”

## Verification

- Full frontend suite: **3,306 passed**, 2 opt-in profile tests skipped in the normal run.
- Native suite: **390 passed**, 19 environment-dependent tests ignored; **1 documentation test passed**.
- Review-room/detached-panel Chromium checks: **18 passed**. Tauri IPC is mocked in this harness.
- TypeScript, ESLint with zero warnings, and production frontend build pass. Vite still reports its existing large-bundle and mixed static/dynamic import warnings.
- Focused tests include durable deletion, persistence failure/ACK retry, wrong review/session identities, duplicate/superseded transport, long landings, rate restoration, late joins preserving offers, consecutive rooms, independent sender queues, and live-note context changes.
- Opt-in React/jsdom composer profile after mounting the complete list:

| Comments | Input event elapsed | React render work |
| --- | ---: | ---: |
| 1,000 | 2.19 ms | 0.59 ms |
| 10,000 | 1.00 ms | 0.57 ms |

These are individual synthetic samples, not a before/after benchmark or evidence of native-media/browser-layout performance. Initial list mounting, scrolling, full snapshot transfer and video decoding are outside these numbers.

Commands:

```sh
npx vitest run
npx eslint src e2e --max-warnings 0
npm run build
cd src-tauri
cargo test --offline
```

The opt-in interaction profile runs from the repository root:

```sh
SAUCE_REVIEW_PROFILE=1 npx vitest run src/components/ReviewPanel.performance.test.tsx --maxWorkers=1 --disableConsoleIntercept
```

## Not implemented / delivery gates still open

1. **NDI native receiver and UI.** No SDK headers, runtime library, or installed Premiere NDI plugin were found in the checked standard locations or Spotlight results. An SDK path/download from the user is needed to compile against the vendor's actual ABI and distribution terms. No receiver, discovery picker, NDI audio meters, experimental setting, or working NDI input is being represented as shipped.
2. **Encode-once program media path.** The existing screen-share encode → hidden decode/capture → RTC encode chain remains. The dedicated hardware H.264/AAC encoder and encoded-media fan-out channel are still to be built and measured; the current RTC program path still encodes per peer. Raw NDI frames must remain native.
3. **Real media acceptance.** Premiere playback, scrubbing, parking, sequence changes, stereo audio, input loss/recovery, memory stability, end-to-end latency and A/V drift have not been measured. Run the four-person, one-hour soak with bandwidth constraints, reconnects and file transfers before broad release.
4. **Large document transport.** Control snapshots still have the existing 2 MiB message limit. A 10,000-comment UI profile is not proof that a 10,000-comment room snapshot fits. Snapshot chunking/compression and journal compaction need separate bounded implementations and tests before promising very large rooms.
5. **Compatibility limits.** Legacy transport is accepted and a new host accepts legacy note operations. A new guest connected to an old host cannot obtain the new durable note acknowledgement; edits stay pending instead of being declared synced. Use upgraded hosts/participants for the reliability guarantees. Local outbox storage is quota-bound; quota failures preserve the draft and surface an error.
6. **NDI review groups.** Live note timing/labels are implemented as groundwork on the existing review document. Dedicated NDI review documents and editor-owned, room-wide sequence/pass changes remain part of the NDI source implementation. No automatic sequence-timecode verification or Premiere marker/transport control is present.

The native NDI prototype should remain experimental until these real-media gates pass. The frontend-design skill was used to keep the added live-note, audio and diagnostics controls consistent with the existing review console, not to redesign the workspaces.

## Integration references

- [NDI for Premiere Pro / Mercury Transmit](https://docs.ndi.video/all/using-ndi/ndi-tools/plugins/ndi-for-premiere-pro)
- [Louper's NDI source workflow](https://docs.louper.io/setup-guides/premiere-pro/lde-ndi/add-source)
- [NDI dynamic runtime loading](https://docs.ndi.video/all/developing-with-ndi/sdk/dynamic-loading-of-ndi-libraries)
- [NDI send/timecode documentation](https://docs.ndi.video/all/developing-with-ndi/sdk/ndi-send)
- [NDI software distribution](https://docs.ndi.video/all/developing-with-ndi/sdk/software-distribution)

An NDI timestamp may be synthesized clock time; it is not by itself verified Premiere sequence timecode.
