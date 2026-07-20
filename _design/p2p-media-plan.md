# DECISION DOCUMENT — Peer file sharing, media transport, and session data model

**Scope:** synthesis of four research reports into one committed plan. All line citations verified against `/Users/gchiaramonte/Desktop/Clip Pull` (the briefed path `/Users/gchiaramonte/sb-ui-v3` resolves to the same tree; two reports cited it, one flagged it. Use the Desktop path.)

---

## 0. The one-sentence story

**A source has an identity, not a location. When the presenter loads it, every peer answers one question — "can I open this?" — and the room converges on the fastest tier that produces the same frames on every screen.**

Three tiers, ordered by time-to-first-frame. The app picks automatically; the user is told which one they got and why.

---

## 1. THE THREE TIERS

### Tier A — "You already have it" (fingerprint match)

**What it is.** `SessionMsg::LoadSource` ships `{source_kind, url, fingerprint, title, duration, review_key}` (`src-tauri/src/commands/session.rs:97-105`). The guest calls `resolveByFingerprint()` (`src/lib/review.ts:195-197`) and opens its own copy. Zero bytes cross the wire; both machines decode a local original at full quality.

**When chosen.** Always first. `use-co-review.ts:301-313` already does this.

**Time to first frame.** ~0. Local file open.

**What the user sees.** Nothing. It just plays. (Correct — the best tier is invisible.)

**Built?** Yes, entirely. Two gaps: the linked-fingerprint path (`linkFingerprint`, `use-co-review.ts:770`) is only reachable through the manual "Open my copy" affordance, and the resolution outcome is broadcast but never rendered (see §4, bug B5).

---

### Tier B — "Watch it now, streamed from my machine" (NEW — the headline)

**What it is.** The presenter's ffmpeg remuxes or transcodes the local file into fragmented MP4 and pipes it over a **dedicated iroh QUIC substream** to the guest. The guest's loopback proxy re-serves those bytes on a new route, and the **existing `MSEStreamPlayer` consumes it unchanged**.

```
presenter disk file
  → ffmpeg -ss T (-c copy when possible, else h264_videotoolbox rung)
  → fMP4 → NEW iroh bi-stream (conn.open_bi(), separate from the control stream)
  → guest loopback proxy /peer/fmp4/v1/<id>?start=T&rung=R
  → fetch() → appendBuffer → blob: MediaSource → native WebKit decode
```

Everything downstream of the proxy already exists and is battle-tested (`stream_proxy.rs:529-686` `serve_fmp4`; `src/components/MSEStreamPlayer.tsx:694-757`).

**When chosen.** Tier A missed AND the guest is willing to watch now. This is the default fallback — it is what "Strada-style" actually means for this product.

**Time to first frame.** **~400 ms, independent of seek distance.** Measured on the bundled ffmpeg 8.1 sidecar: time-to-first-200KB was 405/404/402 ms at `-ss 0/60/90`. 1080p→720p VideoToolbox H.264+AAC to fMP4 pipe runs ~12× realtime; →480p ~23×.

**What the user sees.** Video plays. A small grey chip near the source title: `Streaming from Gasper`. Scrubbing works exactly as it does for web sources today. If the link degrades, the chip reads `Streaming from Gasper · 480p` — resolution drops, the timeline never does.

**What must be built.**
1. A `/peer/fmp4/v1/` route in `stream_proxy.rs`. **Do not loosen the existing `http(s)`-only guards** at `stream_proxy.rs:500`, `:518`, `:717` — those are the SSRF defense for the CDN route. Add a sibling route that resolves a **review key → local path via the fingerprint index**. A filesystem path must never appear on the wire or in a URL.
2. **The async→blocking bridge** — the one genuinely new primitive. tiny_http workers are plain std threads with no tokio context (`stream_proxy.rs:38-45`). Bridge with a bounded `tokio::mpsc` (≈64 × 64 KB) drained by a `std::io::Read` adapter using `blocking_recv`. **Never `Handle::block_on` in a tiny_http worker** — it deadlocks. The bound *is* the flow control: MSE stalls → tiny_http stops draining → channel fills → QUIC backpressures → presenter's ffmpeg stalls on its pipe write. The existing backpressure model propagates end to end for free.
3. A media substream protocol: `conn.open_bi()`, one JSON request line, one JSON response header line, then raw fMP4 to EOF.
4. Host-side authorization + `JobRegistry` registration for the spawned ffmpeg.
5. A `disableScrubPreview` flag on `MSEStreamPlayer` — the frame-accurate scrub overlay opens a *second* mediabunny pipeline over the raw path (`MSEStreamPlayer.tsx:426`) needing random access, which a peer stream does not have. `ensurePreviewSink` swallows the failure (`:433-435`), so the user would silently lose the feature. Disable it explicitly.

**Free win worth naming:** `MSEStreamPlayer.tsx:704` derives its fMP4 URL by string-replacing the **first** `/v1/`. Name the routes `peer/v1/<id>` and `peer/fmp4/v1/<id>` and that replace produces the correct URL with **zero frontend byte-path changes**. One naming choice, several hundred lines not written.

---

### Tier C — "Send me the file" (NEW — the fallback)

**What it is.** A whole-file copy over a second iroh stream into `app_cache_dir()`, BLAKE3-verified, then `linkFingerprint()` so Tier A hits forever after.

**When chosen.** Explicit user action, or automatic when Tier B is unavailable (relay-only path, presenter offline soon, guest wants to review later). Never automatic for multi-GB files without consent.

**Time to first frame.** Full transfer duration. Minutes.

**What the user sees.** A grey chip with a determinate progress bar in the source bar: `Receiving Reel_04.mov · 1.2 GB of 4.1 GB · 6 min left`. On completion it collapses into the normal player. A `Cancel` text button. If the presenter leaves mid-transfer, the partial is kept and resumable by offset.

**What must be built.** ~250 lines, **no new dependency**. `SessionMsg::OfferFile { name, size, blake3 }` → receiver `open_bi()`s a stream → header → `tokio::io::copy` to temp → verify hash → rename → `linkFingerprint`. `blake3` 1.8.5 is **already in the lock file** (`Cargo.lock:403-404`) as a transitive dep. Zero new crates.

---

### The ladder, as code

```
LoadSource(kind=file, fingerprint=F, review_key=K)
  ├─ resolveByFingerprint(F) hit?      → TIER A  (play, ~0 ms)
  ├─ presenter reachable, direct path? → TIER B  (stream, ~400 ms)
  ├─ relay-only or user chose keep     → TIER C  (transfer, minutes)
  └─ presenter declines to share bytes → today's "Open my copy…" message
```

---

## 2. TRANSPORT DECISION — committed

### **Reliable ordered bytes over the existing iroh QUIC connection. Not a WebRTC media track.**

**The argument is frame accuracy, and it is not close.**

The product's core promise is that a comment anchored at `00:48:37:19` means the same picture on both machines. That requires (a) both ends decoding the same frames and (b) a defensible mapping from `video.currentTime` back to source timecode.

WebRTC RTP breaks both, structurally:

1. **RTP drops frames under loss.** Host and guest do not see the same frames. Frame-accurate review is definitionally broken, not degraded.
2. **There is no seek.** You would signal seeks out of band and restart the sender's pipeline — reinventing the QUIC design's exact mechanism on top of a lossy pipe, keeping all its complexity and losing its guarantee.
3. **A receiving RTP track's `currentTime` is a reception clock, not a media clock.** The quantity the product depends on does not exist on that transport.

The QUIC path preserves it by construction: `-copyts` + `probe_stream_epoch` (`stream_proxy.rs:380-459`) + `timestampOffset = epoch` (`MSEStreamPlayer.tsx:731-735`) means `video.currentTime` **is** absolute source time, and the playhead is `baseTime + max(0, currentTime − clockOrigin)` (`:826-827`).

**The stall objection, answered.** Reliable transport stalls where RTP degrades. So we degrade deliberately, on a different axis: **a bitrate ladder, not a reliability ladder.** The stream stays reliable-ordered; the presenter produces fewer bytes per second. The 480p frame at source-time *t* is the *same frame* as the 720p frame at *t*, just softer. RTP degrades by dropping frames (destroying the comment anchor); the ladder degrades by dropping pixels (preserving it). For a review tool these are not equivalent.

**Rung switching costs nothing new.** A rung change is `?start=<currentTime>&rung=480` — byte-for-byte the same code path as an out-of-buffer seek: teardown (`MSEStreamPlayer.tsx:511-529`), rebuild (`:532`), fetch (`:695`), land at `pendingLandRef` (`:639-646`). Two constraints: every rung must produce the **same codec string** (`addSourceBuffer` MIME is fixed at `:619` — keep all rungs avc1 High + mp4a.40.2, vary only resolution and bitrate), and never rung-change during an active scrub (gate on `seekSettleRef` being null, `:233`).

**Rung selection signal already exists.** Buffer health is computed for backpressure at `MSEStreamPlayer.tsx:472-474`. Drop a rung when `ahead < 3s` for >5s while playing; try up when pinned at `BUFFER_AHEAD_SECONDS` (30) for >30s; 60s hysteresis; max two changes per minute. **The presenter also vetoes** — with N guests its upstream is N × rung, and that is usually the binding constraint, not per-guest buffer health.

**WebRTC keeps faces.** `rtc-mesh.ts` is right for camera/mic and should not change role. RTP is correct for people and wrong for the review subject.

**Also rejected: HLS.** mediabunny's HLS writer requires a disk-pathed Output (cannot pipe); native `<video src=…m3u8>` on the loopback proxy is the documented WKWebView dead end that `MSEStreamPlayer` exists to route around; HLS-via-MSE means reimplementing hls.js to arrive at "append fMP4," which we already do; and 2-6 s segment latency is 5-15× worse than the measured ~400 ms rebuild on the operation a review tool performs most.

---

## 3. iroh-blobs — **NO, not yet. Hand-roll.**

### Decision: ship Tiers B and C with **zero new crates**. Revisit iroh-blobs only if a specific, named requirement appears.

**The measured cost is real but not the deciding factor.** iroh-blobs 0.103.0 depends on `iroh ^1.0.0`, matching the pin at `src-tauri/Cargo.toml:68`. License is `MIT OR Apache-2.0`. With `default-features = false, features = ["fs-store"]` it is **19 new crates** (6 build-only) — not the 45 a naive `cargo add` pulls, because the default `rpc` feature drags a full TLS/cert stack (`rcgen, x509-parser, asn1-rs, der-parser, yasna, oid-registry, num-bigint, pem`) to stand up an RPC endpoint that is meaningless in-process. If it is ever adopted, `default-features = false` is mandatory.

**Why no anyway — three reasons, in order of weight:**

1. **It solves a problem this architecture does not have.** iroh-blobs' reason to exist is BLAKE3-verified *range* streaming — arbitrary seek into a partially-fetched blob via BAO range proofs. That is the right answer if watch-while-transferring is the design. **It is not our design.** Tier B streams *transcoded output* generated on demand, and seek is handled by restarting ffmpeg at `-ss T` — the same mechanism Plex and Jellyfin use for transcoded seek, and the same one `serve_fmp4` already implements. Blobs and Tier B would actively fight: blobs wants to seek within stored source bytes, Tier B wants to seek within a stream that does not exist until requested.

2. **Tier C genuinely is ~250 lines.** On an already-open, already-authenticated, already-hole-punched QUIC connection, a whole-file send is a header plus a copy loop. QUIC supplies ordering, flow control, congestion control, and encryption. Taking a dependency for a copy loop over a socket you already own fails the constitution's "no new deps without strong justification" on the merits, not on a technicality.

3. **0.x with a monthly breaking cadence.** 0.99 (Mar 17) → 0.100 (Apr 20) → 0.101 (May 8) → 0.102 (May 27) → 0.103 (Jun 15), while iroh core is 1.0-stable. Pinning a pre-1.0 crate into a notarized shipping app buys recurring migration work on a load-bearing path.

**Forward compatibility is preserved deliberately.** Tier C's `OfferFile` carries a BLAKE3 hash. That hash **is** an iroh-blobs `Hash`. If a future requirement demands verified-range fetch, the transport swaps underneath without a protocol break.

**If it is ever adopted:** do **not** call `iroh_blobs::provider::handle_connection` — it runs its own `accept_bi()` loop and `session.rs:555` already accepts on that Connection; both would race and steal each other's control messages. Use `handle_stream<R, W>(pair, store)`, which is generic over the stream pair precisely so callers can demux.

**Also rejected:** magic-wormhole (**EUPL-1.2, a hard license blocker** under CLAUDE.md's MIT/Apache/BSD rule), croc (Go CLI sidecar + third-party relay), WebRTC DataChannel (bytes land in the WKWebView JS heap then must cross Tauri IPC to reach disk — the exact path `stream_proxy.rs` exists to avoid; plus ~16 KiB message cap, no `ndata` so one large message head-of-line blocks the association that RTC signaling shares, and `rtc-mesh.ts` has **no** `createDataChannel` today so nothing is reused), rust-libp2p (duplicates iroh), Syncthing BEP (Go spec, not a library), Hypercore (append-only model, stale Rust port).

---

## 4. DATA MODEL — minimal change, no CRDT

### Design rule to write into the code

> **The room agrees on WHAT and WHEN. Each machine owns HOW it looks.**
> Four things are room-truth: **source, playhead, presenter, comments.** Everything else is deliberately local and must never be replicated.

### Is a CRDT warranted? **No.**

Automerge/Yjs/Loro buy offline convergence without a coordinator, intra-string concurrent text merge, and tombstoned deletes. You **have** a coordinator (the host; the star topology cannot move anyway — the invite ticket points at the host's endpoint, `session.rs:314`), comments are short and edited by their author, and the cap is `MAX_PEERS = 3` (`session.rs:42`) people who are on a video call together. The cost is a 200 KB-1 MB WASM/JS dependency, a binary doc format that breaks the human-readable `~/Documents/Sauce Bunny/Reviews/*.json` files, and a new persistence story. Not worth it.

**But the current model is genuinely broken in five places**, and four of them cause two participants to see different UI. These are the bugs behind the user's complaint.

### The five bugs

**B1 — presenter handover silently strands non-host guests. `epoch` is hardcoded to 0.**
`use-co-review.ts:540` sends `epoch: 0` in every `Transport`, unconditionally. `makePresenter` increments a *different*, host-local counter (`presenterEpochRef`, `:749-756`) that only appears in the `Presenter` message. The receiver dedups on `(epoch, seq)` (`:390-394`) where `seq` is a per-machine counter starting at 0 (`:217`). Concretely: host presents 200 s → seq ~400 → every guest's `coLastSeqRef = {epoch:0, seq:400}`. Floor passes to m1, who sends seq 1, 2, 3… all at epoch 0. The **host** accepts them (its `lastSeen` is still `{-1,-1}`); guest **m2 drops all of them for ~3.3 minutes.** Two guests in one room, one following and one frozen. Also `coClockRef.reset()` (`:393`) is gated on `epoch > lastSeen.epoch`, so it never fires and the clock estimator keeps the *old* presenter's offset samples.

**B2 — the shared review doc is seeded only on the role transition.**
`use-co-review.ts:459-465`: the guard is `role === "host" && prev !== "host" && reviewSourceKey`. Deps include `reviewSourceKey`, so the effect re-runs on a source change and the guard then fails. Consequences: (i) start a session with no source loaded → `sessionDoc` stays null forever → every guest sits on `connecting = inSession && !sessionDoc` (`ReviewPanel.tsx:595`) permanently; (ii) **switch source mid-session** — which `RoomSourceBar` exists to allow — and the doc keeps the OLD `sourceKey`/`versionId`, so comments file against the wrong source and merge into the wrong file on session end (`:471`).

**B3 — a guest's ops before the snapshot arrives are sent but not applied locally.** `postSessionOp` (`:255-258`) is `setSessionDoc(prev => prev ? apply(prev, op) : prev)` then sends unconditionally. If `sessionDoc` is null the op reaches everyone and vanishes on the author's own screen.

**B4 — `pendingSource` never clears on web-source failure.** `:286-291`: the `.catch` sends `sourceStatus: "failed"` but does not `setPendingSource(null)`. The guest renders `Loading …` (`App.tsx:5135`) forever, no retry, no error.

**B5 — `SourceStatus` is fully replicated and completely unrendered.** Produced at `use-co-review.ts:289, 303, 307, 311, 317, 774, 776`, relayed by Rust (`session.rs:720-729`), stored in state (`:243, 320-322`), returned from the hook (`:801`) — and **`grep -n sourceStatus src/App.tsx` returns nothing.** The one piece of state that would tell the presenter "m2 can't open this" is dead code. (Related: `applyingRemoteRef` is written at `:426/444` and never read — the documented echo guard does not exist.)

### Plus one confirmed divergence source: **cross-version silence**

`SessionMsg` parsing is fail-open on both sides: `let Ok(msg) = serde_json::from_str(...) else { continue; }` (`session.rs:852-854`, `:657`). An older build receiving a new variant tag skips the line silently; serde's default struct behavior ignores unknown *fields*, so a new `Welcome { you, title }` parses into an old `Welcome { you }` and drops the title, and the header falls back to `"Review session"` (`App.tsx:5080-5086`). **That is exactly the two-different-screens report.** Nothing about version crosses the wire today — `getVersion()` and `EXPECTED_BACKEND_BUILD_ID` exist but feed only the local staleness banner and diagnostics export (`App.tsx:3916`).

### The minimal change

**Change 1 — one logical clock, replacing wall-clock LWW.**
- `Transport`: **stop hardcoding `epoch: 0`.** Carry the presenter epoch the host actually granted; make `presenterEpoch` a replicated field on `SessionState` (Rust already holds the atomic at `session.rs:254`); reset `coSeqRef` on becoming presenter. Fixes B1.
- `ReviewOp`: keep `at` for back-compat, add `lamport` + `by`. Order on `(lamport, by)`, fall back to `at` when absent.
- **Per-field stamps** on `ReviewComment`: `bodyAt`, `resolvedAt` instead of one `updatedAt`. Today `setResolved` (`review.ts:315-320`) and `editComment` (`:270-275`) both write `updatedAt`, so a resolve at T+1 discards an edit at T+0 across two Macs with ordinary clock skew. This is a **granularity** bug, not a concurrency-primitive bug, and per-field stamps fix it outright. ~40 lines, no dependency, old docs read cleanly (missing stamp = 0).
- **Tombstone deletes**: `del` sets `deleted: true` rather than filtering (`review.ts:278-283`). Makes the snapshot fan-out idempotent, killing the delete-resurrection path where a late joiner's full `ReviewDoc` broadcast (`:516`) re-adds a comment another peer deleted.

**Change 2 — the doc follows the source, not the role transition.** Re-key the seed effect on `(role, reviewSourceKey)`; re-seed and re-broadcast whenever the presenter's `reviewKey` changes mid-session. Peers **replace** (not merge) when `incoming.sourceKey !== prev.sourceKey`. Fixes B2. Make `postSessionOp` buffer rather than silently drop (B3).

**Change 3 — render the divergence that matters.** Destructure `sourceStatus` in `App.tsx:4645` and render it. Costs nothing — the message, the relay, and the state all exist. Clear `pendingSource` on web failure (B4).

**Change 4 — version on the wire, with a visible warning.**
Add `app: String` (and `proto: u32`) to `Hello` and `Welcome`, surface as `PeerInfo.app`.

**Yes, show the warning.** The failure mode is *silent* — the older build does not error, does not log, and does not know it is missing the presenter badge and the room title. An unexplained missing badge reads as an app bug; a stated fact reads as something the room can act on. Constraints:
- One quiet grey chip in the room head. Not a modal, not a toast, **never green**.
- Fire only on **minor**-version difference or differing backend build id. Never on patch drift, or it becomes noise.
- Word it as capability, not error: `Nika is on 0.1.9 and will not see the presenter badge` — not "incompatible".
- Show it on **both** screens. The older build can only do this because serde ignores unknown fields, so the newer side's version reaches it via `PeerList`. This is the one place fail-open parsing works in our favor.
- **Bootstrap honesty:** an existing older build will never render this, because its `PeerInfo` predates the field. The warning helps from the release *after* it ships. State that plainly rather than expecting it to fix the current screenshots.

**Bump ALPN to `saucebunny/coreview/3`** when Change 1 lands (transport epoch semantics change). A hard refusal beats silent divergence — but `session_join`'s timeout path (`session.rs:390-395`) currently reports "couldn't reach the host," which would be actively misleading. Make it say "update Sauce Bunny."

**Explicitly NOT replicated** (write this into the model comment): panel widths and collapse state, theater/`screening`, comment sort/filter/search, collapsed threads, drafts, device selection, local `playbackRate` pref, `activeView`, waveform visibility, library roots, fingerprint index, reviewer color. And by design: resolved rendition/codec/fps, and each machine's own playhead within the 0.75 s chase tolerance (`use-co-review.ts:830`).

**Deferred, needs its own task:** `Presence` is keyed by display *name* (`use-co-review.ts:370-377`), as are comment authorship and `setLike` membership (`review.ts:339-368`). Two participants with the same or blank name collapse into one ghost and one reaction identity. Fixing this means member id on `Presence` and author id on `ReviewComment` — a larger identity change.

---

## 5. UI / UX

House rules observed throughout: grey chip CTAs, green reserved for primary/live signals only, `cp-` prefixed kebab-case classes, tokens from `tokens.css`, no strikethrough, focus = brighter white `--focus-ring` never green, **no em dashes in UI copy**.

### 5a. Per-tile camera/mic controls (the user's ask #2)

Each person tile in `PeoplePanel.tsx` gets a two-control cluster, bottom-left of the tile, revealed on hover and always visible when muted.

```
.cp-tile-controls          absolute, inset-inline-start, bottom, gap var(--space-1)
.cp-tile-ctl               28px square grey chip, icon only, radius var(--radius-sm)
.cp-tile-ctl.is-off        muted state: slashed icon, dimmed fill (NOT red, NOT strikethrough)
.cp-tile-ctl.is-remote     remote peer: local-only volume/hide, visually lighter weight
```

**Self tile:** camera and mic toggles act on the real device. Live = the icon at full opacity with a small green dot; off = slashed icon, dimmed. This is one of the few legitimate green uses (a live signal).

**Remote tiles:** the controls are **local-only** and must be labeled as such, because a remote mute is a social act the app should not perform silently. `Hide video` and `Mute for me`. Tooltip: `Only affects your screen.` No remote-mute capability in v1.

**Always-visible state:** a muted mic shows the slashed icon persistently at tile corner even without hover, since "is she muted or just quiet?" is the single most common confusion in a call.

### 5b. Share screen vs stream file — making the promise legible

These are two products with different guarantees. The UI must say so.

| | **Watch together** | **Share my screen** |
|---|---|---|
| Promise | Frames of a shared file, in sync | Pixels of your app, live |
| Seek | Yes, shared, instant | No |
| Timecode | Real source timecode, anchors comments | None |
| Quality | Each machine decodes full quality (Tier A) or a ladder rung (Tier B) | Lossy 4:2:0, ~half a second behind |
| Use for | The cut | A timeline, a browser, a plugin UI |

**Placement.**
- **`Watch together`** — primary, in `RoomSourceBar.tsx`. Present first; this is the app's thesis. Grey chip + icon (per house rule, not green). Empty state copy: `Everyone plays the same file, in sync. Scrub, pause, and comment on exact timecode.`
- **`Share my screen`** — secondary, in `RoomControlBar.tsx:60`. Copy: `Show your app live. No scrubbing, no timecode.`

**Enforcement, not just labeling:**
1. When a share starts, the shared surface **takes the main stage**, not a 208 px person tile. Today it renders in the self tile (`PeoplePanel.tsx:70-72`) with `object-fit: cover` inside a 16:9 aspect box (`room.css:135, 182, 191`) — a 16:10 screen is **cropped**, and the track additionally inherits the 220 px camera cap (`scaleResolutionDownBy = sourceHeight / 360`, `rtc-mesh.ts:194`) which `setVideoOverride` (`:141-149`) never resets. A shared NLE timeline today is transmitted at ~800×500 and displayed at ~208×117, cropped. **It is a presence badge, not a viewing surface.**
2. While a screen share is the active surface, timecode-anchored comments are **unavailable or explicitly stamped** `during screen share, no source timecode`. Never let a comment silently anchor to a timeline that is not shared.
3. If the presenter picks a window owned by a media player (QuickTime, VLC, IINA) and the room has no loaded source, offer one line: `Streaming the file keeps everyone frame accurate. Load it instead?`

### 5c. Transfer and stream progress affordances

**Tier B (streaming) — a status chip, not a progress bar.** There is no "percent" to a live stream.
```
.cp-source-tier-chip       grey chip, sits beside the source title in RoomSourceBar
  "Streaming from Gasper"                 normal
  "Streaming from Gasper · 480p"          after a rung drop, only when below default
  "Streaming from Gasper · relay"         when hole-punch failed (see risk R2)
```
The green live dot belongs here and only here, since it is a genuine live signal.

**Tier C (transfer) — determinate progress in the same slot.**
```
.cp-transfer-row           replaces the tier chip while a transfer runs
.cp-transfer-bar           thin track, accent fill (green is legitimate: active progress)
.cp-transfer-label         "Receiving Reel_04.mov · 1.2 GB of 4.1 GB · 6 min left"
.cp-transfer-cancel        text button, not a chip
```
On completion, collapse silently into the normal player. On presenter disconnect, keep the partial and show `Paused. Resumes when Gasper is back.`

**Sender side:** the presenter sees a matching row: `Sending to Nika · 30%`, with the same cancel. Consent is required before Tier C ever starts — a one-line dialog naming the file and its size, since this is a multi-GB write to someone's disk.

**Room-level source status (fixing B5):** one line under the source title.
```
"3 of 4 watching · Nika cannot open this file"
```
This converts an invisible split-brain into a shared fact, and every piece of it already exists on the wire.

---

## 6. PHASED PLAN

Each phase is independently shippable and must pass all six gates: `npx tsc --noEmit`, `npm test`, `npm run test:e2e`, `cargo check`, `cargo test --lib`, `swift build`.

Ordered by user value: cheapest thing that makes a real session work, first.

---

### **Phase 0 — Stop the desync (days, frontend + tiny Rust)**
The cheapest changes that make a real multi-person session actually work.

- Fix **B1**: replicate `presenterEpoch` on `SessionState`; send the real epoch in `Transport`; reset `coSeqRef` on becoming presenter; let `coClockRef.reset()` actually fire.
- Fix **B4**: clear `pendingSource` and surface the error on web failure.
- Fix **B5**: render `sourceStatus` in the room head (§5c).
- Fix **B3**: buffer ops instead of dropping them.
- Delete the dead `applyingRemoteRef` and the stale WEB-ONLY comment at `use-co-review.ts:12-13`.

**Gates:** unit test the dedup branch at `:390-394` with a synthetic handover. Bump `EXPECTED_BACKEND_BUILD_ID` both sides; `cargo test --lib` regenerates the ts-rs binding.
**User-visible value:** presenter handover stops freezing guests; the room can see who cannot open the file.

---

### **Phase 1 — Legibility and per-tile controls (days, frontend only)**
- Reset `scaleResolutionDownBy = 1` in `setVideoOverride` when a share track takes over; restore the tile cap on `null`. Extend `rtc-mesh.test.ts:125-129`.
- Set `contentHint = "detail"` on the share track (in `share-stream.ts` after `captureStream()` at `:71-73`) and `degradationPreference = "maintain-resolution"` on the overriding senders. Text stays sharp, frame rate absorbs congestion. There is currently **no `contentHint` anywhere in `src/`**.
- Cap the share bitrate in `share_encode_args` (`stream_proxy.rs:1115-1137`) — there is **no `-b:v`, `-maxrate`, or `-crf` today**. Synthetic worst case measured at ~12.7 Mbit/s, uploaded once per peer. **Land this with the resolution unlock, not after.**
- Promote the share to the main stage with `object-fit: contain`.
- Trim the MSE buffer in `share-stream.ts` — it appends forever with no `remove()`, so a long share eventually throws `QuotaExceededError`, which is caught at `:46` and routed straight to `died()`, killing the share. Serialize removes against appends in the existing queue at `:41-49` or the fix introduces the crash it prevents.
- Per-tile camera/mic controls (§5a).
- The two-button share/stream distinction with its copy (§5b).

**Gates:** e2e covers the tile controls render; `rtc-mesh.test.ts` covers the encoding reset.
**User-visible value:** a shared screen becomes readable; mute state becomes obvious.

---

### **Phase 2 — Tier C, transfer (days, Rust + frontend, zero new deps)**
`SessionMsg::OfferFile` → second `open_bi()` stream → `tokio::io::copy` → BLAKE3 verify → `linkFingerprint`. Progress events to the frontend. Consent dialog. Cancel. Resume by offset.

**Gates:** `cargo test --lib` on the framing and hash verify. Two-machine manual script (the user drives GUI tests; hand them a script).
**User-visible value:** "send my friend the file" works. Ask #4 closed.

---

### **Phase 3 — Tier B, streaming (the big one, ~2 weeks)**
Sub-ordered by dependency; each sub-step is independently verifiable.

- **3a.** `/peer/fmp4/v1/` route taking a **local path resolved from a review key**, with `-c copy`. Verify by having the presenter play *its own* local file through the fMP4 path — no network involved. Proves `serve_fmp4` works on local input.
- **3b.** The async→blocking bridge. Verify with a deliberate pause test: pause the guest, confirm the presenter's ffmpeg stalls rather than buffering unboundedly.
- **3c.** The media substream protocol + `JobRegistry` + host authorization.
- **3d.** Wire the guest: replace the Tier-3 dead end at `use-co-review.ts:315-317`, add `disableScrubPreview`. **Ship here at a fixed 720p rung.**
- **3e.** The ladder: rung arg sets, buffer-health signal, presenter upstream-budget veto.

**Gates:** all six, plus a two-Mac manual script covering seek, rung change, and presenter disconnect.
**User-visible value:** "stream my local file to my friend" works. Ask #3 closed.

---

### **Phase 4 — Data model hardening (~1 week)**
Lamport stamps, per-field `bodyAt`/`resolvedAt`, tombstoned deletes, doc-follows-source (Change 2), version handshake + cross-version chip (Change 4). ALPN → `/3`.

**Gates:** `review.ts` unit tests for resolve-vs-edit ordering and tombstone idempotence; verify against a real `~/Documents/Sauce Bunny/Reviews/` doc that the shrink guard (`review-store.ts:230-242`) does not fire on first rewrite.
**User-visible value:** comments stop losing edits; version mismatch becomes a stated fact.

*(Phase 4 could precede Phase 3 if the two-different-screens complaint is more urgent than streaming. Phases 0-2 must come first regardless.)*

---

## 7. RISKIEST ASSUMPTIONS — validate BEFORE each phase

**Before Phase 0**
- **R1.** B1's runtime behavior is a strong claim derived from static reading of `coSeqRef`/`coLastSeqRef`/`epoch: 0`. **Confirm with a 3-machine handover (host + 2 guests) or a targeted unit test around `:390-394` before treating it as settled.** If wrong, the whole phase re-prioritizes.

**Before Phase 1**
- **R2.** The ffmpeg encoder benchmarks used synthetic `testsrc2`, which is far higher-entropy than a desktop. VideoToolbox often does *worse* than tuned x264 on flat/text content at low bitrates. **Re-measure on a real captured screen** before committing to the encoder swap. The CPU halving (2.20 s → 1.01 s user) is the robust half of that result; the quality parity is not.
- **R3.** Promoting the share to main stage **collides with the presenter/transport model** — the stage currently belongs to the source driven by `SessionMsg::Transport`. What happens when someone shares while a source is playing is a product decision needing its own pass, likely a new `SessionMsg` state, not a CSS change.

**Before Phase 2**
- **R4.** A multi-GB transfer shares one congestion-control domain with the live A/V mesh and the `Transport` heartbeat. **Untested.** Rate-limit well below link capacity or pause during playback, and verify on two real machines.
- **R5.** Stream demux correctness. Getting the accept-loop dispatch wrong does not fail loudly — it **silently steals control-plane messages**, and the symptom looks like a co-review bug, not a transfer bug. Add an explicit stream-type discriminator and reject unknown types.

**Before Phase 3**
- **R6.** **iroh relay fallback is a cloud dependency in the failure path and a constitution question.** When hole-punching fails, media traverses n0's public relay. QUIC is E2E encrypted so the relay cannot read it, but *control* traffic through a relay is kilobytes while *media* is gigabytes. That is materially different from what was accepted for the control channel and deserves an explicit decision. **Verify the iroh 1.x API for querying direct-vs-relay path shape** (the older `conn_type` API predates the 0.96 multipath work and was not confirmed). Recommendation: on relay, force the lowest rung with a visible badge, or refuse Tier B and offer Tier C.
- **R7.** **Can the loopback `/peer/` route sustain ffmpeg's Range read pattern without stalling MSE?** Unverified. Test in 3a/3b before building 3c-3e on top.
- **R8.** `probe_stream_epoch` has a 4 s kill and falls back to a rebased timeline (`stream_proxy.rs:635-647`). On a local file it should be fast, but **if it fails the guest silently drops to keyframe-precision landing** — exactly the frame-accuracy property this whole design exists to protect. On the peer path, treat a probe failure as a **visible error**, not a silent degrade.
- **R9.** `-c copy` GOP is not under our control. A delivery master with a 10 s keyframe interval makes every out-of-buffer seek decode up to 10 s of hidden video. Probe keyframe interval at `LoadSource` and demote to a re-encode rung above ~4 s. Easy to miss because it looks like "seeking is slow on this one file," not a bug.
- **R10.** Rung changes and the fixed `addSourceBuffer` MIME (`MSEStreamPlayer.tsx:619`). The H.264 level appears in the codec string (`avc1.640029` vs `avc1.64001f`). Either pin one level string across rungs or rely on teardown recreating the MediaSource. **A silent mismatch surfaces as a decode error and dumps the user to the download fallback.**
- **R11.** Authorization scope. A peer media route is a remote-triggered read of the presenter's filesystem. Constrain three ways: resolve only via review-key → fingerprint index (**never a path from the wire**); serve only the file currently loaded via `LoadSource`; serve only to authenticated session members. The loopback token (`stream_proxy.rs:62-94, 188-205`) protects the *guest's* route and does nothing for the presenter side. **That gate is entirely new and must be written.**
- **R12.** Do not copy `serve_share`'s one-at-a-time singleton (`stream_proxy.rs:1029-1048`). Peer media is inherently N-at-once; use a keyed `streamId → child` map, and ensure a seek's teardown kills only its own child. The clobber bug already fixed at `:1351-1357` will recur if written carelessly.

**Before Phase 4**
- **R13.** Bumping ALPN to `/3` means a 0.2.0 host and a 0.3.0 guest cannot connect at all. Must land in the same release on both sides, with a failure message that says "update Sauce Bunny."
- **R14.** Tombstones grow docs monotonically. Irrelevant at this scale, but plan a compaction pass on session end rather than forgetting it.

---

## 8. THINGS EXPLICITLY NOT TO DO

- **No custom UDP transport** (Parsec BUD, Sunshine ENet+RTP+FEC, Jump Fluid). These exist to shave 7 ms for people moving a remote mouse. Nobody in a review session controls a remote cursor; the latency budget is set by human conversation. Rewriting transport is the most expensive way to fix a problem this app does not have.
- **No whole-display-only capture or virtual displays.** The reference tools do this because their capture APIs force it. Sauce Bunny already has single-window capture (`swift-sidecar/Sources/saucebunny-capture/main.swift:251`) plus region crop (`:265-272`), which is *better* for this use case. Do not regress it chasing their architecture.
- **No HDR capture.** macOS 15 only, and WKWebView cannot paint 10-bit `VideoFrame`s — the codebase already has a scar (`d1da322`).
- **No 4:4:4 chroma.** Correct in principle for text, but High 4:4:4 Predictive almost certainly will not decode in the WKWebView MSE path. This limitation is itself an argument for keeping screen share as the *fallback* surface, not the review surface.
- **No RTP for the review subject**, no HLS, no `iroh_blobs::provider::handle_connection`, no media on the control stream, no reintroduction of the hidden-`<audio>` twin clock.
- **No CRDT.**