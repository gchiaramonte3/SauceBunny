# Session recording — research and plan

Five-pass audit of the repo (capture, session bus, UI/UX, storage) plus a
synthesis pass, then spot-verified by hand. The load-bearing claims were
re-checked directly against the tree before this was filed:

- the `saucebunny-capture` ScreenCaptureKit sidecar ALREADY exists and ships
  (`src-tauri/binaries/saucebunny-capture-aarch64-apple-darwin`)
- the session's mic track is post-gain, so recording it captures SILENCE
  while muted (`media-devices.ts`: `gained.enabled = !c.micMuted`)
- the whole-buffer write ceiling really is `2 ** 32` (`export-capacity.ts`)
- WKWebView really has no `getDisplayMedia` (`commands/media.rs`)
- dictation already chose native ffmpeg capture over `getUserMedia`, for
  stated reasons (`commands/transcript.rs`)

NOT YET IMPLEMENTED. This is the plan, including the spikes that must run
before Phase 2 is designed.

---

# Session Recording — Implementation Plan

Repo: `/Users/gchiaramonte/sb-ui-v3`. Everything below is anchored to code that exists today; line numbers were re-verified against the working tree at `fc701ab`.

---

## 1. What is actually possible

### The capture decision: go native. Do not build this on `MediaRecorder`.

**Recommendation: both halves of the feature capture bytes in a native child process — ScreenCaptureKit (`saucebunny-capture`) plus bundled `ffmpeg` for the stage, AVFoundation for the webcam. The WebView records nothing.**

This contradicts the pre-existing plan in `_design/prompts-live-presence.md:202-258`, which specified `MediaRecorder` + a chunked `append_session_recording` command. I think that plan is wrong, and here is the case, ordered from "certain" to "needs measuring":

**Verified in the repo, no platform guessing required:**

1. **The session stream's audio track is not a microphone.** `src/lib/media-devices.ts:212-233` builds mic → `GainNode` → `createMediaStreamDestination()` and returns `new MediaStream([...video, gained])`. Recording `getSessionCapture()` records post-gain audio, and records *literal silence* whenever the user is muted, because mute is `gained.enabled = false` (`:228`). The app has already been bitten by this: `src/components/AvSettingsPane.tsx:102-108` force-enables tracks for the mic check with the comment *"Join muted leaves track.enabled=false, which records SILENCE"*. The raw mic is in a module-private `WeakMap` at `media-devices.ts:90` with no exported accessor.
2. **"Local quality" is not available on that stream.** `media-devices.ts:200` constrains capture to `width: { ideal: 1280 }, height: { ideal: 720 }`. That *same track* is what `replaceTrack` feeds to peers, so raising the constraint changes what the other side sees. A MediaRecorder path either records 720p (not "local quality") or degrades the mesh.
3. **There is no append/streaming write to disk.** Both byte-writing commands are one-shot whole-buffer writes: `write_text_to_path` (`src-tauri/src/commands/system.rs:776`) and `write_raw_to_path` (`:797`), the latter deliberately atomic (temp + fsync + rename). The only `OpenOptions::append` in the tree is the peer-transfer receive loop at `session.rs:2240`, which is not a command. `src/lib/export-capacity.ts:17-20` names the missing incremental writer as unbuilt work.
4. **Buffering the take is arithmetically impossible.** `export-capacity.ts:24`: `BUFFER_TARGET_MAX_BYTES = 2 ** 32` (4 GiB ArrayBuffer ceiling). A 90-minute 1080p take at 6 Mbps is ~4.05 GB. The blobs themselves may be fine; the single `arrayBuffer()` needed to hand bytes to `write_raw_to_path` is not.
5. **The repo already made this exact call once and wrote down why.** `src-tauri/src/commands/transcript.rs:297-301`: *"we capture the mic with the bundled ffmpeg (avfoundation) rather than the WebView's getUserMedia (WKWebView's capture-permission path is unreliable on this stack)."* Dictation is a native recorder with a graceful finalize (`dictate_start` at `transcript.rs:497`, `dictate_stop` writing `q` to stdin at `:679`).
6. **`getDisplayMedia` does not exist in WKWebView.** Stated flatly at `src-tauri/src/commands/media.rs:2596`. There is no in-page route to the screen at all — which is why `saucebunny-capture` exists.

**Platform claims — flagged honestly:**

- **`MediaRecorder` works in this WebView for audio.** Verified: shipping call site at `AvSettingsPane.tsx:112-114`, with the repo's own note *"WKWebView records audio/mp4 (never webm)"*. **Video has never been tested here.** The spike that would test it (`src/components/MediaSpikePanel.tsx:91-127`, steps d and d2) has never been run: `_design/prompts-live-presence.md:272-282` has all four checkboxes empty, and the doc says prompts 1-3 *"stay locked until every line below has a verdict"*.
- **My belief, medium confidence:** WebKit's MP4 `MediaRecorder` writes a conventional moov-at-stop container, so naïvely concatenating `start(timeslice)` chunks yields an unplayable file until the last chunk lands. I cannot verify this from the repo and I am not certain of it. The spike's own failure text (`MediaSpikePanel.tsx:126`) spells out the consequence: *"Crash-safe chunked recording NOT viable (prompt 3 must buffer whole-blob)"* — and per point 4, buffering a whole blob does not fit.
- **The decisive argument does not depend on that unknown.** A `MediaRecorder` take lives in the WKWebView content process for its entire 90 minutes. That process can be reloaded or jetsammed by the OS. A recording that cannot be repeated should not live in the most disposable process on the machine.

**The one real risk in the native path, and it must be spiked on day one:** can `ffmpeg -f avfoundation` open a camera/mic that WKWebView is already holding for the mesh? macOS relaxed exclusive camera access some releases ago and I believe concurrent multi-process capture works on 14+, but **confidence: medium, and I have not verified it on this stack.** Test it before Phase 2 starts. Phase 1 does not touch the camera at all, which is deliberate.

### Design consequence

Phase 1 needs **zero** unanswered platform questions. Phase 2 has exactly one, and it is a ten-minute test.

---

## 2. Phases

| Phase | Ships | Blocked on |
|---|---|---|
| **0** | Two spikes, half a day | nothing |
| **1** | Host records the stage, natively. Button, red frame, wire announcement, Sessions folder. | nothing |
| **2** | Every member records their own camera + mic locally. | Spike B |
| **3** | Ship-to-host, Sessions shelf, transfer UI. | user decision (§8) |

**Phase 1 is genuinely useful alone:** the host walks away from a review with a watchable MP4 of exactly what was on the stage and everything they heard through the app, including the remote participants' voices, filed under a dated session folder. It also builds the entire signalling, UI and storage skeleton that Phase 2 reuses unchanged.

---

## 3. Per phase

### Phase 0 — two spikes (do these first, they are cheap)

**Spike A — the recorded, never-run one.** Set `localStorage.setItem("saucebunny.devMediaSpike", "1")`, run `MediaSpikePanel` (`src/components/MediaSpikePanel.tsx:5`) in **both** `npm run tauri dev` and a built `.app`. Fill in every box at `_design/prompts-live-presence.md:272-282`. Even though the plan does not build on `MediaRecorder`, steps d and d2 are the fallback's viability test and the doc is currently a lie by omission.

**Spike B — device sharing.** With a live session holding the camera:

```bash
src-tauri/binaries/ffmpeg-aarch64-apple-darwin -hide_banner \
  -f avfoundation -framerate 30 -video_size 1920x1080 -i "0:0" \
  -t 10 -c:v h264_videotoolbox -b:v 8M -c:a aac \
  -movflags frag_keyframe+empty_moov+default_base_moof -y /tmp/spikeB.mp4
```

Enumerate indices with the pattern already in `transcript.rs:358` (`-f avfoundation -list_devices true -i ""`). **If this fails while WKWebView holds the camera, Phase 2's design changes** — see the fallback at the end of Phase 2.

**Spike C (30 min, do it with A and B)** — SCK crop geometry. Use the existing sidecar directly:

```bash
src-tauri/binaries/saucebunny-capture-aarch64-apple-darwin stream \
  --kind window --id <id from `... list`> --crop 100,100,640,360 --fps 30 > /tmp/raw.bgra
```

Confirm whether `sourceRect` on a **window** filter is window-relative and top-left-origin. `swift-sidecar/Sources/saucebunny-capture/main.swift:265-272` maps `--crop` straight onto `cfg.sourceRect`. **Confidence: medium** that window-relative is what you get; if it turns out to be display-relative, Phase 1 falls back to whole-window capture and the crop moves to Phase 1.5.

---

### Phase 1 — host records the stage

**Sidecar (one flag, one bug fix)** — `swift-sidecar/Sources/saucebunny-capture/main.swift`

- Add `--include-own-audio`. Line `287` hardcodes `cfg.excludesCurrentProcessAudio = true`. For a self-capture our process's audio *is* the programme audio plus the remote participants' voices as the app renders them. Flip it only under the new flag; the share path keeps the current behaviour (it must, or share echoes).
- Fix the own-window filter at `:97` / `:102`: `ProcessInfo.processInfo.processIdentifier` is the **sidecar's** pid, so the comparison never excludes the app's windows. Convenient for us (we need to capture our own window), but it means the *share picker* currently offers Sauce Bunny's own window — a mirror tunnel. Pass the app's pid in as an argument and exclude it for `list`, include it for the recording path.
- Build with `npm run build:capture` (`scripts/build-capture.sh`); the `otool -L` guard rail runs there.

**Rust — new module `src-tauri/src/commands/recording.rs`**

Three commands, thin wrappers, `Result<T, AppError>`:

- `recording_start(app, RecordStageArg { crop: Option<String>, audio: bool }) -> Result<RecordingHandle, AppError>`
- `recording_stop(app, id: String) -> Result<RecordingResult, AppError>`
- `recording_status(app) -> Result<Option<RecordingHandle>, AppError>`

Spawn shape — copy `stream_proxy.rs:1962-1998` almost verbatim, because it already solves the awkward parts:

```rust
// sidecar binary resolution: stream_proxy.rs:1857-1870 (`cap_bin`)
cc.arg("stream")
  .arg("--kind").arg("window")
  .arg("--id").arg(window_id.to_string())
  .arg("--fps").arg("30")            // NOT --max-width; full res
  .arg("--include-own-audio");
if let Some(c) = crop { cc.arg("--crop").arg(c); }
if let Some(f) = &fifo { cc.arg("--audio-fifo").arg(f); }
```

Read the one `meta:{"width":W,"height":H}` line off stderr with a deadline (`stream_proxy.rs:1988-2000` has the helper-thread pattern already written), then pipe the tight-packed BGRA stdout into ffmpeg:

```
-f rawvideo -pix_fmt bgra -s WxH -r 30 -i pipe:0
[-f s16le -ar 48000 -ac 2 -i <fifo>]
-c:v h264_videotoolbox -b:v 12M -maxrate 16M -bufsize 24M -pix_fmt yuv420p -g 60
-c:a aac -b:a 192k
-movflags frag_keyframe+empty_moov+default_base_moof
-y <sessionDir>/stage.mp4.part
```

Non-negotiables:

- **`-movflags frag_keyframe+empty_moov+default_base_moof`.** `src-tauri/src/lib.rs:412-414` hard-kills every `JobRegistry` job on `RunEvent::Exit` (`for id in registry.active_ids() { … child.kill() }`). A moov-at-stop muxer loses the entire take there. The proxy already uses fragmented MP4 for exactly this reason (`stream_proxy.rs:842`, `:1902`).
- **Register both children in `JobRegistry`** and keep stdin open on ffmpeg so `recording_stop` can write `q` for a clean finalize — the exact mechanism `dictate_stop` uses (`transcript.rs:679`, `registry.write_stdin(&job_id, b"q")`), with the `-nostdin` warning at `transcript.rs:533` applying identically.
- **Do not route this through the loopback proxy.** `serve_share` ties the pipeline's lifetime to an HTTP response: after `request.respond(...)` it unconditionally kills the children, comment *"Client gone …"* at `stream_proxy.rs:2126`. A recording bound to a fetch dies on reload. CLAUDE.md also forbids growing the proxy into an app backend.
- **Do not reuse `share_encode_args`** (`stream_proxy.rs:1877-1902`): `-preset ultrafast -tune zerolatency -b:v 6M`, plus `--max-width 1600` at `:1968`. Those numbers exist because the share is uploaded once per peer. Baking them into a master file bakes a transport compromise into an archive.
- **`.part` until finalize**, renamed on clean stop — same discipline as the peer transfer's `{blake3}.part` at `session.rs:2175`. A crashed take must look unfinished in Finder, not look like a recording that will not play.
- **Free-space precheck.** Nothing in this codebase checks disk space anywhere (`grep -rn "free_space|statvfs"` finds one doc comment, `session.rs:2979`). This is the first feature that can eat 20 GB unattended. `statvfs` + a refusal with a number.

**Permissions** — Screen Recording TCC is already plumbed end to end: `screen_recording_preflight()` at `media.rs:2628`, `screen_capture_access(request)` at `:2638`, the Settings checklist row at `AvSettingsPane.tsx:201-205`, the deep link at `use-co-review.ts:1085-1095`. Reuse the failure path verbatim, including the two quirks the code already documents (`media.rs:2630-2637`): CoreGraphics cannot report "denied" without prompting, so non-granted reads as *undetermined*; and **a fresh grant only takes effect after the app restarts**. Say that in the UI or a first-time user will click Record and get nothing.

**What could go wrong in Phase 1**

- Crop geometry lands in the wrong place (Spike C). Fallback: whole-window capture.
- The red frame, captions, annotations and the reaction layer are all *inside* the captured region if you window-capture. Decide deliberately (§8) — and if the frame must not appear in the take, inset the crop inside the border rather than trying to hide the overlay.
- `capturesAudio` with `excludesCurrentProcessAudio = false` may pull in **all** system audio, not just ours. Verify; be honest in the UI copy about what gets recorded.
- Theater mode (`App.tsx:4117`) resizes the stage mid-recording. A crop rect captured at start goes stale. Either recompute (SCK allows `updateConfiguration`, more work) or lock the layout while recording and say so.
- `h264_videotoolbox` availability in the bundled static ffmpeg — check with `-encoders`; fall back to `libx264 -preset veryfast -crf 20` if absent.

---

### Phase 2 — per-member camera + mic

**If Spike B passes (expected path):** add a `record-av` mode to a sidecar, or spawn ffmpeg directly per `transcript.rs:497-560`:

```
-f avfoundation -framerate 30 -video_size 1920x1080 -i "<cam>:<mic>"
-c:v h264_videotoolbox -b:v 10M -pix_fmt yuv420p -c:a aac -b:a 192k
-movflags frag_keyframe+empty_moov+default_base_moof -y <sessionDir>/<member>.mp4.part
```

This is what "local quality rather than degraded stream quality" actually means: 1080p from the device, not the 720p-capped `replaceTrack` source, and the true mic rather than the post-gain WebAudio destination. It is also independent of whether the user is muted in the room — which is a **product decision, not a bug** (§8): Riverside records you even when the room cannot hear you.

Device selection reuses `loadDeviceChoice()` (`src/lib/media-devices.ts`) for the label, but avfoundation wants its own index — enumerate with the `-list_devices` pattern at `transcript.rs:358` and match on name. Expect fuzziness here.

**If Spike B fails** (ffmpeg cannot open a camera WKWebView holds): the honest options are (a) a Swift `AVCaptureSession` → `AVAssetWriter` sidecar mode, which has the same contention problem and probably fails identically, or (b) fall back to `MediaRecorder` and accept its limits. If you fall back, then and only then build `append_session_recording` — modelled on the peer-transfer receive loop (`session.rs:2240-2317`: `OpenOptions::new().create(true).append(true)`, 256 KiB chunks per `TRANSFER_CHUNK` at `:123`, progress every 250 ms, `flush` + `sync_all` at the end). Pass the chunk as a **raw IPC body** — `invoke(cmd, uint8Array, { headers })`, the `write_raw_to_path` convention at `system.rs:797-819` — never as a number array, which `src/lib/invoke-contract.test.ts:105-132` fails the build over (*"~2s of frozen UI and ~2.2 GB peak for a 100 MB clip"*). And build the raw-mic accessor in `media-devices.ts`, because recording `getSessionCapture()` records silence when muted.

---

## 4. The signalling

**No websockets.** There is not one in this app's source; the only `tokio-websockets` in `Cargo.lock` is a transitive dep of `iroh-relay`. The transport is iroh QUIC with newline-delimited JSON, one `SessionMsg` per line, ALPN `saucebunny/coreview/2` (`session.rs:59`), star topology, `MAX_PEERS = 3` (`:62`), 2 MiB line cap (`:67`). Adding a second transport violates CLAUDE.md. `Sharing { from, on }` is the exact structural precedent.

**Add one variant.** `Recording { from: String, what: String, on: bool }` where `what` is `"camera"` or `"stage"`. One boolean is not enough: the user asked for two different recordings with two different consent asks, and "someone is recording" without saying which is not informed consent.

**Every edit site — miss one and the message silently vanishes:**

| # | File:line | What |
|---|---|---|
| 1 | `src-tauri/src/commands/session.rs:246` | New variant after `OfferFile` in the `#[serde(tag = "kind")]` enum |
| 2 | `src-tauri/src/commands/session.rs:669-670` | Host-stamp arm in `session_broadcast` (`from: "m0"`), beside `Sharing`/`Reaction` |
| 3 | `src-tauri/src/commands/session.rs:974-983` | Host read-loop arm: stamp `from: member`, `app.emit("session:msg", …)`, `relay_to_others`. **Miss this and the host's own UI never sees a guest's flag** — the catch-all `_ => {}` at `:1042` swallows it |
| 4 | `src-tauri/src/commands/session.rs:1630-1638` | Peer forward list. **Miss this and no guest ever sees anything** |
| 5 | `src/bindings/SessionMsg.ts` | **Generated** — `cd src-tauri && cargo test --lib`. Never hand-edit (ts-rs header, line 1) |
| 6 | `src/hooks/use-co-review.ts:411` | `case "recording":` in the switch, beside `case "sharing"` at `:564` |
| 7 | `src/hooks/use-co-review.ts:282` | `recordingMembers` state, mirroring `sharingMembers` |
| 8 | `src/lib/session-msg-contract.test.ts:6-12` | The test **passes automatically** (it scrapes variant names from the binding and only needs a `case`), but its prose says *"Fifteen variants"* and *"the other eleven"*. Update to sixteen/twelve or the test documents a protocol that no longer exists |
| 9 | `src/lib/build-id.ts:10` + `src-tauri/src/commands/system.rs:1323` | Both currently `"2026-08-24-r165-frame-folders"`; `build-id.test.ts` asserts equality |
| 10 | `src-tauri/src/lib.rs:185` | New commands into `generate_handler!` — `ipc-surface-contract.test.ts:34` has `ALLOWED_UNCALLED = []`, so registered-but-uncalled fails, and called-but-unregistered fails too |

No new Tauri event is needed — this rides `session:msg`, so `event-surface-contract.test.ts` is unaffected.

**Fix the staleness that `sharing` and `hand` both have, because a recording light cannot afford it.** Neither `sharingMembers` nor `raisedHands` is ever pruned against the roster; they clear only when the whole session ends (`use-co-review.ts:1278`, `:741`). Rust holds no per-member flag state, so nothing clears server-side either — the disconnect path just does `peers.retain(...)` + `broadcast_peer_list` (`session.rs:1057-1059`). And member ids are **reclaimed by install id** (`session.rs:881`), so a peer that drops while flagged and rejoins comes back still flagged. For "Sharing screen" that is cosmetic. For a recording light it is a lie.

Two frontend-only fixes, no extra Rust:

1. **Prune on roster change** — an effect that intersects `recordingMembers` with `coSession.peers`. Three lines.
2. **Everyone re-announces on roster growth**, not just the host. The current re-sync (`use-co-review.ts:838-870`) is host-only, self-only, and edge-triggered on peer *count* rising, so "guest B is recording, guest C joins" tells C nothing. Have each member re-send its own `Recording{on:true}` when the roster grows. Each member's own send is host-stamped with its own id correctly — the host **cannot** re-announce on someone else's behalf, because `session_broadcast` rewrites `from` to `"m0"` (`session.rs:669`).

**Where I disagree with pass 2:** it argued the flag belongs on `PeerInfo` (`session.rs:285`) so a disconnect clears it structurally, and it verified that is mesh-safe (`use-rtc-mesh.ts` keys on `id:epoch`, `setMembers` is idempotent). That *is* the more structurally correct answer, and it is the right refactor if you also fix `sharing` and `hand`. But it needs a new flag map in `HostShared` under the fixed lock order, and it gives up the ability to carry `what` on the event. I would ship the variant plus the two frontend fixes now, and take `PeerInfo` as a follow-up that fixes all three flags at once. Name this trade-off in the PR; a reviewer will ask.

**Two things to say out loud rather than engineer around:**

- **Build skew.** An older peer that cannot parse a new variant logs and continues (`session.rs:1586-1597`) — the recording notice is dropped and that person is never told. Making "ALL parties know" a real guarantee means bumping ALPN to `saucebunny/coreview/3` (`session.rs:59`, whose comment says exactly this), which refuses every existing pairing outright. **That is the user's call, not a default** (§8).
- **It is an honour signal.** Nothing in the protocol proves anyone is or is not recording; a modified build simply does not send the flag, and QuickTime on the whole Mac is invisible to this app. Do not ship copy implying the red frame is a consent guarantee.

**Wire hygiene:** the `Recording` message must carry **no filesystem path** — not the output path, not a filename with a user directory in it. `src/lib/wire-path-contract.test.ts:45` only scans `kind: "reviewDoc"` send sites, so CI will not catch this. It is on you.

---

## 5. UI

### The button — `src/components/RoomControlBar.tsx`

Insert after the screen-share button (the block at `:57-77`) and **before** `<span className="cp-room-bar-sep" aria-hidden />` at `:107`. Reuse `className="cp-room-bar-btn"` (32×30 at `src/styles/room.css:339-348`, so `hit-target-contract.test.ts` is satisfied) with a new `.recording` modifier.

Two buttons, not one overloaded control:

- **"Record me"** — visible to everyone (both parties record their own camera).
- **"Record the stage"** — host only. `RoomControlBar` currently takes no role prop; thread `isPresenter` from `App.tsx:3738` through the mount at `:4813`. Alternatively this one lives in `.cp-room-head-actions` (`App.tsx:4450`) beside Copy join code and End session, which is where host-scoped verbs live per `RoomControlBar.tsx:15`.

Copy must satisfy `control-naming-contract.test.ts` (`title` and `aria-label` must contain one another after stripping parentheticals — see the compliant example at `RoomControlBar.tsx:60-63`) and `voice-contract.test.ts` (no em dash U+2014, no en dash U+2013, tooltips and aria-labels count).

State styling: copy `.cp-review-tool.recording` (`src/styles/review.css:705-714`) — `--danger-text` glyph on `rgba(255,107,107,0.16)`, `0.45` border. **Do not copy its `cp-mic-pulse` animation onto the room bar** unless you also add the `@media (prefers-reduced-motion: reduce)` block (`review.css:822-827`); `reduced-motion-contract.test.ts:98-120` scans for exactly that, and it names *"an INFINITE pulse on the live-session dot"* as a prior offender.

### The icon — `src/components/Icons.tsx`

**Correction to one of the research passes:** the claim that the icon set "structurally cannot draw a filled red dot" is wrong. The wrapper sets `fill="none"` on the `<svg>` (`Icons.tsx:20`), but children override it freely — `Icons.tsx:46`, `:51`, `:294` already do `fill="currentColor" stroke="none"`. Add:

```tsx
export const IconRecord = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="7" fill="currentColor" stroke="none" /></Icon>
);
```

**On the "R":** be blunt with the user. A red letterform has no precedent in this app — every control icon is a 24-viewBox stroke glyph, and the only glyph-in-a-box is `.cp-keycap` (`src/styles/base.css:115`), a keyboard affordance. A filled disc is the platform-standard record mark and fits the set. If the R is non-negotiable, it must be **knocked out of a filled red disc** in `--fg-0`/`--bg-0`, never drawn as a red glyph on the near-transparent button face: `tokens.css:68-73` states outright that `--danger` (#E82626) *"is heavy for a glyph and fails against dark greys"*, and `e2e/contrast.spec.ts` measures the effective background.

Focus: `border-color: var(--focus-ring)` (`base.css:95`), never the green accent — `focus-contract.test.ts` has no allowlist.

### The red monitor frame — `src/components/Monitor.tsx`

`.cp-monitor` is rendered at **four** call sites: `:297` (empty), `:353` (fetching), `:381` (error), `:426` (loaded). Thread the prop to **all four**, or the frame vanishes the moment a source refetches or errors — which is exactly when a recording is still running.

It cannot be a border or inset shadow on `.cp-monitor` itself: the player's `<video>` fills the box at 100%/100% and paints over it, `.cp-monitor` already carries `border: 1px solid var(--line-1)` plus `box-shadow: 0 0 0 1px rgba(0,0,0,0.4)` (`src/styles/monitor.css:30-47`), and an outer ring clips because `.cp-monitor-area` is `overflow: hidden` (`:20-28`).

So: a dedicated absolutely-positioned child.

```css
/* app.css / monitor.css, under a "recording" section comment */
.cp-monitor-rec-frame {
  position: absolute;
  inset: 0;
  border: 2px solid var(--danger);
  border-radius: var(--r-sm);
  pointer-events: none;
  z-index: 9;
}
```

`z-index: 9` clears everything already inside `.cp-monitor`: `.cp-prep-banner` z4, `.cp-stream-loading` z5 (`monitor.css:446` — the frame must stay visible over the loading scrim, since a recording keeps running while a source reloads), `.cp-caption-overlay` z6, `.cp-annot` z6, `.cp-tc-hud` / `.cp-shuttle-badge` / `.cp-stream-rung` z8. The z20/z40 rules in that file (`:530`, `:733`, `:813`) are transport popovers, not children of `.cp-monitor`. `ReactionLayer` is a **sibling** of `<Monitor>` under `.cp-main` (`App.tsx:4787`, `room.css:535`) and does not fight.

**Static, not blinking.** The only persistent state-border precedent in the app is `.cp-person.speaking` (`room.css:235`), a non-animated ring. `--danger` as a *border* is exactly what that token is for (`.cp-room-end`, `room.css:375`), unlike as a glyph.

### The tile badge — `src/components/PeoplePanel.tsx`

Add `.cp-person-rec` beside `.cp-person-share` at `:307` (top-left; top-right is taken by `.cp-person-hand` at `:308`). Derive self state **locally**, mirroring `:132`: `recording={p.isSelf ? localRecording : recordingMembers.has(p.id)}` — otherwise your own indicator lags a network round trip behind your own click. Do **not** copy `.cp-person-presenting` (`room.css:805`); that is a role badge keyed on a single member id, not a live-state Set.

### Other contracts that apply

`class-prefix-contract` (new classes must be `cp-`), `css-classes.test.ts` (every styled `cp-` class must actually be rendered — a typo'd selector fails rather than silently doing nothing), `component-reachable-contract` (a new component file must be imported, no allowlist), `important-contract` (the `!important` count may shrink, never grow), `design-tokens-contract` (any elapsed-time readout using `var(--font-mono)` must also declare `font-variant-numeric: tabular-nums`).

### Test seam

`e2e/tauri-mock.ts:296` exposes `emitTauriEvent`, so a Playwright spec can push a `session:msg` recording line into the running frontend with no backend and assert the badge and frame render. No session command is mocked today, which is fine for a receive-side test.

---

## 6. Storage

**Path:** `~/Documents/Sauce Bunny/Sessions/<yyyy-mm-dd-hhmm>-<slug>/`, containing `session.json` plus `stage.mp4` and one `<member-name>.mp4` per recorded participant. This is the layout `_design/prompts-live-presence.md:213-224` already specifies; do not invent a new one.

**Why it is safe from the cache, precisely:**

- The 24h sweep only walks `app_cache_dir()` and explicitly skips the media subtree (`system.rs:634`, `:672`, `:692`). Documents is untouched.
- `enforce_media_cache_cap` walks `cache.join(MEDIA_CACHE_DIRNAME)` only (`system.rs:410-420`) — and `App.tsx:351` calls it **at boot with `exclude: []`**, deleting oldest-first under size pressure with no idea whether a file is finished, in flight, or the only copy. A multi-GB take in the media cache is a take that gets deleted by a boot-time size check.
- Clear-on-quit and the Settings Clear buttons reach the cache too.

**Do the whole thing in Documents, including the `.part`.** The prompt doc says to stage in the media cache; I disagree, for the reason directly above. The cost is that a crashed take leaves visible `.part` debris in Finder — which is the correct failure mode for an unrepeatable artifact.

**While you are in that quit handler, fix a live bug:** `src-tauri/src/lib.rs:425` joins the literal `"saucebunny-media"`, but the layout migration renamed it — `system.rs:209` is `MEDIA_CACHE_DIRNAME = "media"` and `:211` `LEGACY_MEDIA_DIRNAME = "saucebunny-media"`. On any install that has run `migrate_cache_layout`, clear-on-quit silently does nothing. One string, one file, and it is exactly the path-drift failure that argues for keeping recordings out of the cache.

**Copy the Frames pattern, which is fully worked out:**

- `sessions_dir()` off Tauri's `document_dir()` (`frames.rs:67-72`) so a localized Documents works, and it does **not** create the directory.
- **No top-level index file.** The directory is the truth (`frames.rs:100-101`, `:106-120`) so a Finder rename or move can never desync a sidecar. A `session.json` *inside* its own session folder is fine — it describes one session and dies with it. This deliberately diverges from `Reviews/` and `Screenings/` (`src/lib/screening-store.ts:147`), which do carry index files; Frames is the better precedent because recordings are large opaque media, not small JSON docs.
- **Exactly one recursive asset-scope grant for the Sessions root**, never per file — `frames.rs:104-120` spells out why: `Scope::is_allowed` is a linear glob scan on **every** asset request, so per-item grants put that scan on the playback byte-range path. Mint URLs via `assetUrl()` (`src/lib/asset-url.ts:33`). A denied asset read is 403 with an empty body, so a miss renders as a black video and never as an error.
- A missing folder is an **empty shelf**, not an error (`frames.rs:100-101`).

**Size math** (rule of thumb: MB/min ≈ Mbps × 7.5):

| Stream | Bitrate | Per minute | 90 minutes |
|---|---|---|---|
| Stage, real quality (recommended `-b:v 12M`) | 12 Mbps | 90 MB | **8.1 GB** |
| Stage, at the share encode's 6M/1600w (do not) | 6.2 Mbps | 46 MB | 4.2 GB |
| Webcam 1080p30 H.264 + AAC | 10 Mbps | 75 MB | **6.75 GB** |
| Webcam at today's 720p mesh constraint | 4 Mbps | 30 MB | 2.7 GB |

A 90-minute two-party session: **guest ≈ 6.8 GB**, **host ≈ 15 GB** (stage + own camera). If the guest later ships its take to the host, the host holds ≈ 22 GB, and the shipped copy transits `app_cache_dir()/media/transfers/` (`session.rs:2169`) on the way. Add a Tier C keep-copy of the film under review and one session can cost 30 GB. **Confidence: medium** — these are standard encoder rules of thumb, not measurements on this hardware; the 6 Mbps / 1600w / 30 fps figures for the share path are read straight out of `stream_proxy.rs:1893-1899` and `:1968`.

**Docs that must change in the same commit:** CLAUDE.md's storage-layout table and `docs/DATA-MODEL.md`'s storage map. `docs-contract.test.ts` treats both as load-bearing prose.

---

## 7. What NOT to build

- **A websocket.** There is none in this app. The session bus over iroh QUIC is already open, authenticated and encrypted before any of this runs, and CLAUDE.md forbids a second transport.
- **WebRTC or GStreamer for recording bytes.** WebRTC stays confined to the live webcam/mic mesh over iroh signalling.
- **`monitor.captureStream()` into a MediaRecorder.** Three separate reasons: for a guest the monitor shows a rung-limited re-encode, so you would record the degradation, which the co-review rule forbids in substance; the monitor is three different elements depending on source and only `MSEStreamPlayer`'s blob-backed `<video>` is proven capturable (`MSEStreamPlayer.tsx:403`), while `LocalMediaPlayer`'s is `asset://` — a separate origin in the CSP, and notably the *only* player with no `getPosterDataUrl`, with `App.tsx:2542-2557` routing local frame grabs through mediabunny instead (**medium confidence** that captureStream there yields an isolated track — unproven either way); and `canvas.captureStream()` has never run in this WebView at all (the only use is `e2e/tauri-mock.ts:338`, in Chromium).
- **Recording through the loopback proxy.** `serve_share` kills the whole pipeline when the fetch client disconnects (`stream_proxy.rs:2126`). CLAUDE.md: *"It is a media primitive, not an app backend."*
- **`share_encode_args` for a master file** (`stream_proxy.rs:1877-1902`): 6 Mbps CBR, 1600px cap, `ultrafast`, `zerolatency`. Tuned for a stream uploaded once per peer.
- **Buffering a whole take in the WebView.** 4 GiB `ArrayBuffer` ceiling (`export-capacity.ts:24`) versus a 4-8 GB take.
- **`append_session_recording` — for now.** Build it only if Spike B fails and you fall back to `MediaRecorder`. A native recorder writes its own file; adding an IPC append path you do not need is a whole command surface, an `ipc-surface-contract` entry, and a build-ID bump for nothing.
- **A top-level `Sessions/index.json`.**
- **A new Tauri plugin or npm dependency.** `saucebunny-capture` and `ffmpeg` are already bundled; the fs plugin is deliberately absent (`App.tsx:2452-2456` says so).
- **A recording indicator in the popped-out panel window** — for now. `PanelSnapshot` (`use-panel-bus.ts:47-79`) carries zero co-review fields and `panel-snapshot-contract.test.ts` sits on that shape. Decide before building the UI, not after (§8).

---

## 8. Open questions for the user

1. **Does the guest's recording get sent to the host afterwards, or stay on the guest's machine?** The pre-existing plan (`prompts-live-presence.md:227-244`) says ship it, over a dedicated iroh bi-stream, with a wrap-up session state. That doubles the host's disk cost (≈22 GB per 90-minute session) and adds a whole new session phase. Both takes are already safe locally on both machines. My lean: v1 keeps them local, and "collect takes" becomes an explicit later action.
2. **Does the red frame mean "I am recording" or "someone in this room is recording"?** One 2px frame cannot say both, and the answer decides whether it is driven by self-state or `recordingMembers.size > 0`. The app solves the analogous problem per-tile, never room-wide.
3. **ALPN bump, or not?** Without it, a mixed-build session silently drops the recording notice and someone is recorded without being told. With it, every existing pairing breaks on the first release. This is a product call.
4. **Is there a refuse path?** Today the flag is announcement-only. `PeoplePanel` already carries the position that a remote mute *"is a social act the app must not perform silently"*. Recording deserves the same conversation, and refusal is a second message plus a policy about what the host does when someone says no.
5. **Does the stage recording include the app's chrome and overlays** — the People tiles, captions, annotations, the red frame itself? Window capture includes them; a crop to `.cp-monitor` does not. This changes the crop geometry, so settle it before the capture command is written. It also changes what the `"stage"` flag *means* for a guest: if the tiles are composited in, the host is recording your face.
6. **`~/Documents` or `~/Movies`?** Documents is iCloud-synced by default for many users, which would try to upload a 15 GB session. `docs/DATA-MODEL.md:51-53` says `~/Movies/Sauce Bunny` is *"output, not a store"* and the app never reads it back — but a session archive the app lists and manages *is* a store. Options: keep Documents and drop a `.nosync` marker, or make the Sessions root user-relocatable like `default_export_path` (`system.rs:1299`).
7. **Should recording your own camera keep going while you are muted in the room?** Riverside says yes — the local take is yours, the mute is a courtesy to the room. It is also surprising if nobody tells you.
8. **Retention.** Sessions accumulate at 7-15 GB each with no cap, no age policy and no Settings surface. At minimum the Settings cache panel should report a Sessions size, even if the only eviction is a human deleting a folder.
9. **Does the red frame need to reach the popped-out panel window?** New `PanelSnapshot` field plus a contract change if yes.
10. **Should `sharing` and `hand` be fixed at the same time?** They have the identical staleness bug. Fixing recording correctly while leaving two neighbours broken is defensible; a reviewer will ask.

---

## Where the research passes disagreed, and what I believe

- **MediaRecorder vs native.** Passes 1, 3 and 4 all treated `MediaRecorder` as the default for the webcam half and made the whole design contingent on an unrun spike. **I do not.** The mute-silence trap, the 720p mesh constraint, the missing append command, the 4 GiB ceiling, and the app's own written precedent at `transcript.rs:297` are five verified-in-repo reasons that hold regardless of how the spike lands. Native is the plan; `MediaRecorder` is the documented fallback for one specific spike failure.
- **Where the flag lives.** Pass 2 wants it on `PeerInfo` (structurally self-clearing); passes 1 and 3 want a `Sharing`-shaped variant. Pass 2 is more correct and I said so above, but it cannot carry `what` and costs new `HostShared` state. Ship the variant plus a frontend roster-prune and self-re-announce; take `PeerInfo` as the follow-up that fixes all three flags together.
- **Riding `Reaction { emote: "recording" }`** (pass 2's zero-Rust prototype) is a real option and degrades gracefully against older builds. It also inherits a 250 ms send throttle and a variant contracted as never replayed to late joiners. Fine as a one-afternoon prototype; wrong as the shipped design.
- **"The icon set cannot draw a filled dot"** (pass 3) is factually wrong — `Icons.tsx:46`, `:51` and `:294` already set `fill="currentColor" stroke="none"` on children. Verified in the working tree.
- **Line-number drift.** Several citations across the passes were a few lines off (`serve_share`'s kill block is at `stream_proxy.rs:2126`, not 2162; `PeerInfo` is at `session.rs:285`, not ~304). Everything cited in *this* document was re-checked against the tree today.
- **The genuinely unknown things**, restated plainly: whether Safari's `MediaRecorder` timeslice chunks concatenate (Spike A); whether ffmpeg can open a camera WKWebView holds (Spike B); whether SCK `sourceRect` on a window filter is window-relative and top-left-origin (Spike C). Half a day answers all three, and none of them blocks Phase 1.

---

## Before every commit

```bash
npx tsc --noEmit
npm test                       # vitest, incl. every contract test named above
cd src-tauri && cargo check && cargo test --lib   # regenerates src/bindings/*.ts
cd swift-sidecar && swift build
npm run tauri dev              # no console errors
```

Commit points, following the repo's `area: change` convention:

```
sessions: record the stage natively, announced on the wire
sessions: each member records their own camera and mic
sessions: ship takes to the host and archive them
```
