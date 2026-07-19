# Peer Local-File Streaming ("Beam") — Design

**Repo:** `/Users/gchiaramonte/sb-ui-v3` (currently on `ui-polish-v3`). Branch this work fresh off `main` as `peer-beam`; per project memory the chip branches integrate into `main` sequentially because of `App.tsx` conflicts.

**Line-number corrections to the incoming reports (I re-verified; several were stale):**
- `PeerConn` is at `src-tauri/src/commands/session.rs:267-276`, not 215-221. It holds `id, member, name, epoch, send: SendStream` — **no `Connection`**. Confirmed.
- Peer-side `open_bi` is at `session.rs:368`; `Session::Peer { _conn: Connection }` at `session.rs:231` / assigned `:408`. Host `accept_bi` is at `session.rs:533` (single call, no loop). Confirmed.
- **ALPN is already `saucebunny/coreview/2`** (`session.rs:39`), not `/1`. Do not bump it again for this feature — use a capability field instead (below).
- `SessionMsg::LoadSource` (`session.rs:88-101`) **already** carries `from, kind, url, fingerprint, title, duration, review_key`, and the documented contract at `session.rs:92` is *"file → url is None; the guest resolves fingerprint on its own disk."* `SourceStatus { from, state, detail }` (`session.rs:103`) already has a `"missing"` state. This feature is precisely the answer to `state == "missing"` — it slots into an existing hole rather than inventing a new flow.
- `HostShared` at `session.rs:239-260` (has `presenter: AtomicU64`, `installs`, `epochs`) is the natural home for the file registry handle set.

---

## 1. End-to-end data path

```
HOST (has the file)                                  PEER (does not)
──────────────────────────────────────────────────────────────────────────
App.tsx local file loaded
  └─ beam_publish(path) ──► BeamRegistry            
       returns opaque 32-char handle                 
                                                     
session_broadcast LoadSource{kind:"file",            use-co-review.ts:209
  fingerprint, duration, beam:Some(handle)} ────────► resolve fingerprint locally
                                                       ├─ found  → today's path, done
                                                       └─ missing→ SourceStatus{"missing"}
                                                                   + invoke session_beam_url(handle)
                                                                     → "http://127.0.0.1:P/t/TOK/v1/<b64('beam://<handle>')>"
                                                     
                                                     Monitor.tsx:427 /^https?:/ passes
                                                       → <MSEStreamPlayer path=… />
                                                     MSEStreamPlayer.tsx:704
                                                       path.replace("/v1/","/fmp4/v1/")
                                                       + ?start=N&rung=720
                                                       → fetch()
                                                     
                                                     stream_proxy.rs serve() :221
                                                       decode_after("fmp4/v1/") → "beam://h"
                                                       → serve_beam()  [NEW]
                                                          └─ blocking→async bridge
                                                     
  beam accept loop on Connection  ◄────── conn.open_bi() + request line (1 line JSON)
    validate handle in BeamRegistry
    ffprobe epoch + color class
    spawn ffmpeg (VideoToolbox encode)
    ─── response header line (1 line JSON) ──────────►  becomes HTTP headers
                                                          X-Timeline / X-Stream-Epoch
    ─── raw fMP4 bytes ─────────────────────────────►  tiny_http chunked body
                                                       → fetch reader → appendBuffer
                                                       → blob: MediaSource → WebKit decode
```

### Components reused unchanged
| Component | Path | Role |
|---|---|---|
| MSE receiver | `src/components/MSEStreamPlayer.tsx` | Unchanged except one new prop (§1.2). Seek debounce (`:280`), in-buffer seek (`:260-275`), buffer-ahead backpressure (`:72`, `:747-750`), quota eviction (`:498`), generation guards, `X-Timeline`/`X-Stream-Epoch` math (`:709-735`) all carry over verbatim. |
| Player routing | `src/components/Monitor.tsx:427` | The `http(s)` regex already routes a loopback URL to `MSEStreamPlayer`. Zero change. |
| Proxy token gate | `src-tauri/src/stream_proxy.rs:194-205` | Applies to the new route for free. |
| Route dispatch | `stream_proxy.rs:221-230` | `/fmp4/v1/<b64>` shape reused; only the scheme branch is new. |
| Response shape | `stream_proxy.rs:651-685` | Same header set + `Response::new(200, headers, reader, None, None)` chunked body + kill-after-respond teardown. |
| Color routing | `src-tauri/src/commands/media.rs:1315-1325` (`classify_playback_color`), `:1364-1423` (`playback_video_quality_args`) | Filter chains reused for 10-bit dither and HDR tonemap. |
| iroh session | `session.rs` `Connection` + roster + presenter atomic | Media rides the existing connection. |
| ffmpeg/ffprobe sidecars | `src-tauri/binaries/` | Already on both machines. |

### New pieces
| File | Purpose |
|---|---|
| **`src-tauri/src/beam.rs`** (new top-level module, sibling of `stream_proxy.rs`) | `BeamRegistry` (handle → canonicalized path + duration + color class), wire types `BeamReq`/`BeamResp`, host-side `serve_beam_stream()` task, peer-side `BeamReader` (`std::io::Read` over `iroh::endpoint::RecvStream`), the rung ladder table, and the ffmpeg arg builder. Registered in `lib.rs` alongside `mod stream_proxy;`. |
| `stream_proxy.rs` — `serve_beam()` | ~60 lines: branch in `serve_fmp4`, open the iroh stream via the bridge, translate `BeamResp` → HTTP headers, hand `BeamReader` to tiny_http. |
| `session.rs` — beam accept loop + `conn` in `PeerConn` | Add `conn: Connection` to `PeerConn` (`:267`); spawn a `loop { conn.accept_bi() }` task on both sides (host accepts beam streams; peer's `_conn` at `:231` is already retained). |
| `session.rs` — `SessionMsg` additions | `beam: Option<String>` on `LoadSource`; new `Ping`/`Pong` variants (§5). Regenerate `src/bindings/SessionMsg.ts` with `cargo test --lib`. |
| `src-tauri/src/commands/session.rs` — commands | `session_beam_publish(path) -> String`, `session_beam_revoke(handle)`, `session_beam_url(handle) -> String`. |
| **`src/lib/beam-quality.ts`** (new) | Pure rung state machine (starvation → downshift, hysteresis), unit-tested. |
| **`src/lib/session-clock.ts`** (new) | Pure clock-offset estimator (min-RTT filter + median + EWMA), unit-tested. |
| `src/hooks/use-co-review.ts` | Beam fallback on `SourceStatus "missing"`; clock offset applied at `:280`; `decideChase` (`:610-624`) gains thresholds. |

### 1.2 The only frontend player change
`MSEStreamPlayer.tsx` opens the **raw** `path` twice with mediabunny — the codec probe (`:572-592`) and the scrub-preview decoder (`:421-439`). Both would fail on a beam URL, and the second fails *silently* while `setScrubPreview(true)` (`:242`) still paints `.cp-scrub-preview` (`src/styles/monitor.css:566-577`, `background: var(--bg-0)` — opaque) over the video on every scrub.

Fix: add one prop, `disableScrubPreview?: boolean`, gating `:242`. The codec probe needs no code change — pass `videoCodec="avc1.640028"` / `audioCodec="mp4a.40.2"` / `knownDuration` so the r79 fast path at `:553-568` fires and the probe never runs. The host always encodes to H.264 High + AAC, so declaring **High L4.0 for every rung** is correct (MSE accepts a declared level ≥ actual; measured actuals are L3.0–L4.0). No `X-Codecs` header needed.

`use-web-playback.ts:84-86` — `onMediaError` must return `false` for a beam source so it does not attempt the yt-dlp download fallback, which is meaningless here.

---

## 2. Wire protocol

### 2.1 URL shape (peer-local)
```
http://127.0.0.1:<port>/t/<token>/v1/<b64url("beam://<handle>")>
```
Deliberately the **raw `/v1/`** shape so `MSEStreamPlayer.tsx:704`'s `path.replace("/v1/", "/fmp4/v1/")` yields `/fmp4/v1/<b64>` with zero player change. Only `decode_after` (`stream_proxy.rs:510-523`) gains `beam://`; **`decode_upstream` (`:707-722`) keeps rejecting everything but http(s)**, so a direct hit on `/v1/<b64(beam://…)>` correctly 400s. Add a test beside the existing `file:///etc/hosts` regression test (`stream_proxy.rs:828`) asserting `beam://x` is accepted by `decode_after` and rejected by `decode_upstream`, and that `file://` is still rejected by both.

`handle` is 32 chars base64url from `/dev/urandom` — the same `mint_token()` construction at `stream_proxy.rs:67-94`. **The wire format cannot express a filesystem path.** This is the security invariant; do not relax it.

### 2.2 Stream open + request framing
Peer: `conn.open_bi()`, then **immediately** write one newline-terminated JSON line. iroh will not surface the stream to the host's `accept_bi` until bytes arrive (this is why `session_join` writes `Hello` inline at `session.rs:368-374`); an open with no write hangs silently.

```jsonc
{"v":1,"handle":"<32>","start":12.500,"rung":720,"gen":7}\n
```
- `start` — seconds, clamped `0.0..=86_400.0` host-side (mirror `parse_start_query`, `stream_proxy.rs:475-487`).
- `rung` — one of `1080|720|540|360`; anything else → 720.
- `gen` — peer's pipeline generation, echoed back for log correlation.

Header line cap: **64 KiB**, not `MAX_MSG_BYTES` (`session.rs:47`, 2 MiB). This is a fixed-shape control line; a large one is abuse.

### 2.3 Response framing
Host writes exactly one newline-terminated JSON line, then raw bytes.
```jsonc
{"ok":true,"timeline":"absolute","epoch":12.480,"duration":5423.100,
 "mime":"video/mp4; codecs=\"avc1.640028, mp4a.40.2\"","rung":720}\n
<fMP4 bytes …>
```
or
```jsonc
{"ok":false,"code":"gone|denied|unsupported|busy","msg":"…"}\n
```
`serve_beam` maps this to the HTTP response, byte-for-byte the same headers `serve_fmp4` emits at `stream_proxy.rs:652-669`:
```
Content-Type: video/mp4
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-Timeline, X-Stream-Epoch
X-Timeline: absolute
X-Stream-Epoch: 12.480
Cache-Control: no-store
```
`Response::new(200, headers, BeamReader, None, None)` — `None` length ⇒ chunked, exactly as `:670-680`. `ok:false` → HTTP 502 with the code in the body.

The header line exists **specifically** so the epoch is known before the first `appendBuffer` — `MSEStreamPlayer.tsx:731-735` sets `sb.timestampOffset` before any append and cannot be corrected later. The host has the file locally, so it runs the `probe_stream_epoch` equivalent (`stream_proxy.rs:380-459`, `ffprobe -select_streams v:0 -show_entries packet=pts_time,dts_time -read_intervals <start>%+#48`, 4s kill, memoized per `(handle,start,rung)`) before replying. If the probe fails or times out, reply `"timeline":"rebased"` with no epoch — the player degrades to keyframe-granularity landing, which is the working HLS path.

No per-chunk framing after the header. QUIC gives ordering and a clean FIN; framing would only add a copy.

### 2.4 Backpressure — one unbroken chain, no new buffers
```
MSE buffer ≥ BUFFER_AHEAD_SECONDS (MSEStreamPlayer.tsx:72, 30s)
  → pump() stops appending (:467-474) → the await at :747-750 stalls
  → fetch reader stops draining → tiny_http socket write blocks
  → BeamReader::read() is not called
  → QUIC receive window closes
  → host SendStream::write_all() blocks
  → ffmpeg stdout pipe fills → ffmpeg stalls
```
**`BeamReader` must be a lazy pull, driven only by tiny_http's `read()` calls.** Any spawned pump task with an unbounded channel between iroh and the response silently defeats this and the host's encoder runs away. This is the single easiest thing to get wrong.

**The blocking/async bridge is the sharpest implementation risk.** `stream_proxy.rs` is deliberately non-tokio — thread-per-request on plain std threads (`:177-181`) with the reqwest client built *inside* the thread so "no tokio context is in scope" (comment at `:154-156`). iroh is tokio. Implement `BeamReader` as:
```rust
struct BeamReader { rt: tokio::runtime::Handle, recv: RecvStream, buf: BytesMut }
impl std::io::Read for BeamReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        // drain self.buf first; else:
        match self.rt.block_on(self.recv.read_chunk(out.len(), true)) { … }
    }
}
```
`Handle::block_on` from a non-runtime thread is legal; calling it from *inside* a runtime thread panics. Assert at construction that `tokio::runtime::Handle::try_current().is_err()` on the tiny_http thread, and get the `Handle` from a `OnceLock` seeded at app setup in `lib.rs`.

### 2.5 Seek = cancel + rebuild (mirrors `/fmp4` exactly)
Seek out of buffer → `MSEStreamPlayer.tsx:280-293` debounces 280ms → `teardownPipeline` (`:511-529`) cancels the reader → fetch aborts → the tiny_http socket closes → `request.respond()` returns → `serve_beam` drops `BeamReader` → **`RecvStream::stop(0)`** → host's `write_all` returns `WriteError::Stopped` → host kills ffmpeg and drops the stream. Same guarantee as `stream_proxy.rs:681-685`, extended one hop.

Then a brand-new `open_bi` with the new `start` (and possibly a new `rung`). Because `MSEStreamPlayer.tsx:606-619` builds a fresh `MediaSource` + `addSourceBuffer` on every rebuild, **a rung change is mechanically identical to a seek** — no init-segment splicing, no SourceBuffer codec-change concern.

### 2.6 Clean EOF vs. failure — closing the silent-truncation hole
`MSEStreamPlayer.tsx:741` treats reader `done` as end-of-media and calls `ms.endOfStream()` (`:490`). If a dropped iroh stream surfaced as a clean `Ok(0)`, the peer's video would just **end early with no error and no fallback**.

Contract: the host sends FIN **only** when ffmpeg exits 0 having reached the file's end. Every other termination is `SendStream::reset(1)`. `BeamReader::read` maps `ReadError::Reset` / `ConnectionLost` to `Err(io::Error)`, tiny_http aborts the chunked body mid-stream, the peer's `fetch` throws into `MSEStreamPlayer.tsx:753-756` → `fail()` → `onMediaError`. Fix this together with the `onMediaError` return-false change (§1.2) or not at all — half-fixing gives "the movie ends at a random point, then tries to download from YouTube."

### 2.7 Stream priority and lock discipline
- `SendStream::set_priority(-1)` on every beam stream; the control stream stays at default 0. QUIC streams don't head-of-line-block each other, but they share one congestion window, so the 2 Hz `Transport` heartbeat must be prioritized.
- **Never** write media through `session_send` — it writes under the manager mutex (`session.rs:439-451`), and `session.rs:140-145` documents manager-then-peers lock order. Beam writes live in their own task, own `SendStream`, touching neither mutex. The only shared state a beam task reads is the `BeamRegistry` (its own `std::sync::Mutex`, never held across an await).

### 2.8 Version skew
`LoadSource` gains `beam: Option<String>`. An older peer deserializing an unknown field ignores it and falls back to today's "resolve on my disk / report missing" behavior — graceful. A newer peer receiving `beam: None` from an old host simply has no offer and reports missing, as today. No ALPN bump needed (`session.rs:39` is already `/2`).

---

## 3. No new crate

**Ride the existing iroh connection. Do not add `iroh-blobs`.**

- `iroh-blobs` is content-addressed: the provider must know the BLAKE3 hash up front. Our bytes are a live ffmpeg encode whose output differs for every `start` and every `rung`, and no hash exists until the last byte. Serving it via blobs means transcoding and hashing the whole file first — which is exactly the pre-processing the feature exists to avoid ("frames streamed on demand, never pre-processed").
- Version reality: `iroh-blobs` 0.103.0 does depend on `iroh ^1.0.0`, but its own docs say it is not production quality and direct you to 0.35, which targets `iroh` 0.35 — i.e. downgrading the core dependency. It also drags in `iroh-io`, `iroh-metrics`, `bao-tree`, `redb`.
- Everything needed is already in `iroh` 1.0.2: `Connection` is `Clone`, `open_bi`/`accept_bi` are free to open, `SendStream: AsyncWrite` with native flow control, `set_priority`, `stop`/`reset`.

Cargo.toml is untouched. This satisfies CLAUDE.md's no-new-deps rule on the merits, not by exception.

Keep `iroh-blobs` in mind for a *different, future* feature — "send my collaborator the actual file" (resumable, verified, dedup'd). It is the right tool there and the wrong one here.

**Not a WebRTC data channel:** `src/lib/rtc-mesh.ts` has no data channel today (no `createDataChannel` anywhere) — it is pure `addTrack` (`:191`) / `ontrack` (`:210`). So it is new code, routes bulk bytes through the JS heap twice, and swaps QUIC flow control for `bufferedAmount` polling. Its only real advantage (per-pair P2P, host stops relaying) is worth little at `MAX_PEERS = 3` (`session.rs:42`).

**WebRTC media track is the right *fallback*, not the primary** — see §6.

---

## 4. Adaptive quality

Peer chooses the rung (it is where starvation is observed); host executes it. No manifest, no ladder pre-generation, no bandwidth probe — the stream is the probe.

### Ladder (`beam.rs`)
| rung | scale | `-b:v` | `-b:a` | measured achieved | encode speed |
|---|---|---|---|---|---|
| 1080 | `-2:1080` | 4500k | 128k | 3.13 Mbps | 7.4× realtime |
| **720 (default)** | `-2:720` | 2500k | 128k | 1.80 Mbps | 14× |
| 540 | `-2:540` | 1200k | 96k | 0.90 Mbps | 22× |
| 360 | `-2:360` | 600k | 96k | 0.47 Mbps | 34× |

Audio holds at 96k on the bottom rung rather than dropping to 64k. **In a review tool, intelligibility outranks picture** — cut video first. Encode this in the table, deliberately.

### Host ffmpeg command
```
-hide_banner -loglevel error
-ss <START>
-i <canonical path from BeamRegistry>
-map 0:v:0 -map 0:a:0?
<COLOR_VF>
-c:v h264_videotoolbox -profile:v high -pix_fmt yuv420p
-b:v <VB> -maxrate <VB> -bufsize <2*VB> -constant_bit_rate 1
-realtime 1 -prio_speed 1 -g 60 -bf 0
-c:a aac -b:a <AB> -ac 2
-copyts -muxpreload 0 -muxdelay 0 -video_track_timescale 90000
-movflags frag_keyframe+empty_moov+default_base_moof
-frag_duration 200000
-f mp4 pipe:1
```
`h264_videotoolbox` (hardware) not `libx264` — precedent at `media.rs:1471` and `media.rs:248`. `-constant_bit_rate` requires macOS 13+; the app floor is 14. `-g 60` + `-frag_duration 200000` measured best (0.344s to 200 KB) because it keeps a bitrate-efficient 2s GOP while decoupling fragment cadence from it. `-bf 0` removes reorder delay (verified: 15 I / 885 P over 900 frames).

`<COLOR_VF>` branches on `classify_playback_color` (`media.rs:1315-1325`), reusing the chains from `playback_video_quality_args` (`media.rs:1364-1423`):
- **Sdr8:** `-vf scale=-2:<H>`
- **Sdr10:** `-vf "zscale=min=bt709:m=bt709:dither=error_diffusion,format=yuv420p,scale=-2:<H>"` — plain `-pix_fmt yuv420p` on 10-bit uses undithered swscale truncation and reintroduces the sky banding `media.rs:1288-1296` documents already fixing once.
- **HDR:** `-vf "scale=-2:<H>,zscale=tin=smpte2084:pin=bt2020:min=bt2020nc:t=linear:npl=100,tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv:dither=error_diffusion,format=yuv420p"` plus `-colorspace bt709 -color_primaries bt709 -color_trc bt709`. **Scale first** — measured 0.76s vs 1.41s tonemap-first, because the expensive zscale runs at 720p. Scaling in the PQ domain is technically less correct and invisible at proxy bitrates. Without this branch HDR renders washed-out grey; it is mandatory, not cosmetic.

**Architectural bonus worth stating:** the remote viewer gets a *better-supported* format than the host's own player. CLAUDE.md's ProRes/10-bit caveat exists because mediabunny must wrap samples in a WebCodecs `VideoFrame` and WKWebView has no 10-bit `VideoFrame`. The beam path never touches WebCodecs — ffmpeg decodes natively and emits 8-bit H.264 that WebKit decodes natively. Verified conversions: ProRes 422 HQ (yuv422p10le), HEVC 10-bit, AV1, HDR PQ bt2020 → all clean `h264/High/yuv420p` + AAC. PCM audio in ProRes .mov converts fine via the same `-c:a aac`.

### Rung state machine (`src/lib/beam-quality.ts`, pure + unit-tested)
- **Downshift:** two `waiting` events on the `<video>` within a 30s window → drop one rung, rebuild at the current position. Costs one pipeline rebuild (~330ms TTFB + RTT).
- **Upshift:** at most one rung, only after 60s with zero `waiting` events; never twice without a clean 120s.
- **Asymmetric hysteresis is not a refinement.** Without it, auto mode is worse than a fixed 720p, because each switch is a full rebuild.
- **Manual override:** a rung selector defaulting to Auto, matching the existing `previewMaxHeight: 480 | 720 | 1080` vocabulary in `SettingsModal.tsx:152-159` so it reads as one concept.

Concurrency is not a limit: 4 parallel 720p VideoToolbox encodes measured 5.31s wall vs 2.80s for one (~30× realtime aggregate). At `MAX_PEERS = 3`, per-peer encoding is affordable. Sharing one encode across peers on the same rung is a later optimization, not a prerequisite.

---

## 5. Sync

### 5.1 Prerequisite: fix the clock skew (this is a live bug today)
`use-co-review.ts:280`:
```ts
const expected = m.position + (m.playing ? (Math.max(0, Date.now() - m.atMs) / 1000) * m.rate : 0);
```
`Date.now()` is the **peer's** wall clock; `m.atMs` is the **host's** (`session.rs:~110`, "at_ms = sender wall clock"). There is no offset estimation anywhere in the codebase. Any NTP divergence becomes a **constant, permanent playhead offset** — and because it is constant it never trips a drift threshold, so it is invisible. The `Math.max(0, …)` clamp additionally masks negative skew by pinning elapsed to zero.

Add `SessionMsg::Ping { t1, seq }` / `Pong { t1, t2 }`, piggybacked on the existing 2 Hz `Transport` cadence (no new timer). On receipt at `t3`:
```
rtt    = t3 - t1
offset = t2 - t1 - rtt/2      // add to peer clock → host clock
```
`src/lib/session-clock.ts`: keep the **8 lowest-RTT** samples from a rolling 30s window (min-filtering beats averaging — the lowest-RTT sample has least queueing distortion), take the median of their offsets, EWMA α = 0.15. Discard any sample with `rtt > 3 × min_rtt`. Until ≥3 samples land, treat offset as 0 **and widen the deadband to 500ms** rather than chasing on garbage.

Then `use-co-review.ts:280` becomes:
```ts
const hostNow  = Date.now() + clockOffsetMs;
const elapsed  = Math.max(0, hostNow - m.atMs) / 1000;
const expected = m.position + (m.playing ? elapsed * m.rate : 0);
```

### 5.2 Three-zone correction
`decideChase` (`use-co-review.ts:610-624`) today corrects **exclusively by seeking**, at `> 0.5s` playing and `> 0.1s` paused-and-host-scrubbed. There is no `playbackRate` path. For a beam source a seek kills and respawns a remote ffmpeg — so 0.5s drift triggering a full teardown is exactly backwards.

Extend `ChaseInput` with `{ seekThresholdSec, nudge: boolean }` (keeps it pure and keeps the existing tests in `src/hooks/use-co-review.test.ts` valid by defaulting):

| zone | drift `d = expected − current` | action |
|---|---|---|
| deadband | `\|d\| ≤ 120 ms` | nothing. Below a 24fps frame (41ms) × safety, and below the offset noise floor. |
| nudge | `120 ms < \|d\| ≤ 2000 ms` | `playbackRate = 1 + clamp(d / 4000, −0.05, +0.05)` — correct over ~4s. |
| seek | `\|d\| > seekThresholdSec` | hard seek to `expected + 250 ms` (lead covers rebuild latency); reset rate to 1.0. |

`seekThresholdSec` = **2.0** for beam sources, **0.5** (today's value) for locally-resolved files where seeks are cheap. `nudge` = true only when the player supports rate without artifacts.

**±5% is the load-bearing number** — the perceptual threshold where pitch shift goes unnoticed; it matches Syncplay's `SLOWDOWN_RATE = 0.95`. Explicitly reject Jellyfin's 0.2×–2.0× clamp, which is audibly bad.

**Hysteresis:** once nudging, hold until `|d| < 40 ms`, then restore `playbackRate = 1.0` (mirrors Syncplay's `SLOWDOWN_RESET_THRESHOLD = 0.1`). Never leave rate ≠ 1.0 inside the deadband.

**Seek-storm guard:** at most one hard seek per 5s. If drift is still > 2s after a seek, the peer is bandwidth-starved, not desynced — **downshift a rung instead of seeking again**. This is the failure mode that otherwise makes the feature feel broken on a weak link.

**Paused:** keep the existing `hostScrubbed` logic (`:291`, `:620`) but widen its 0.1s threshold to **250 ms** for beam sources to absorb offset jitter.

Steady-state target: **≤150 ms** peer-to-host offset (Evercast's published global figure). Achievable with correct offset + a 120ms deadband; **not** achievable while §5.1 stands.

### 5.3 Echo suppression
1. Keep the RC3 latch — `localSeekHot`, 1200ms (`use-co-review.ts:289`), and the `commitHostPos` distinction at `:294-298` that correctly refuses to consume the scrub edge while yielding. Both already correct; do not touch.
2. **Enforce `seq` monotonicity.** `Transport.seq` exists (`session.rs:~112`) but is never validated on receive. Discard `seq ≤ lastSeenSeq` within a `Presenter.epoch`; reset `lastSeenSeq` when `epoch` increments (`Presenter { member, epoch }`, `session.rs:~108`, already documented as the ordering mechanism for presenter handoff).
3. Drop any `Transport` whose originator is self — matters once handoff exists.
4. Non-presenters never emit `Transport`. A guest's local scrub sets the latch and is purely local until it expires or the guest is granted presenter.

### 5.4 UX contract (matches Evercast/ClearView/Frame.io norm)
One presenter owns transport; viewers follow by default; a persistent "Following <name>" indicator. A guest scrubbing enters a **soft break** — "Out of sync" with a "Resume sync" affordance — rather than being silently yanked back. The existing latch already implements the right instinct; this just surfaces it.

---

## 6. Failure modes and fallbacks

| Failure | Detection | Behavior |
|---|---|---|
| **Peer on a bad network** | ≥2 `waiting` in 30s | Downshift a rung (§4). At 360p sustained-starved for 60s → offer the WebRTC-track fallback (below) with an honest "lower quality, follows the host, no independent scrubbing" label. |
| **20s no first byte** | `MSEStreamPlayer.tsx:687-691` stall guard | `fail()` → `onMediaError` → returns false (beam) → session recovery: retry once at rung−1, then surface "Couldn't stream from <host>". Note this constant may need raising for beam — iroh RTT + ffprobe epoch + ffmpeg spin-up stack on top of today's local budget. Measure before shipping; do **not** just raise it blindly, because a longer guard means a longer silent hang. |
| **Host CPU saturated** | Host tracks concurrent beam encodes + `ProcessInfo.thermalState` | Hard cap: 3 concurrent beam encodes (= `MAX_PEERS`). A 4th request → `{"ok":false,"code":"busy"}`. If Whisper or the diarizer is running, cap the default rung at 540 — CLAUDE.md's transcription sidecars contend for the same machine, and a review session should not starve a transcription the user started first. Surface a host-side "Streaming to 2 · quality reduced" chip; the host is the only one who can see the cost. |
| **Host quits / connection drops mid-stream** | QUIC reset or connection loss | `BeamReader::read` → `Err` (never `Ok(0)`) → chunked body aborts → peer `fetch` throws → `fail()` → `onMediaError` → "Host left the session." Handles are invalidated when the session ends. Explicitly *not* `endOfStream()` — see §2.6. |
| **File moved or deleted** | Host re-stats the canonical path on every beam open | `{"ok":false,"code":"gone"}` → HTTP 502 → peer shows "The presenter's file is no longer available." Host also emits `SourceStatus{state:"missing"}` for itself so the room agrees. Re-stat per open, not per publish — a scrub 20 minutes into a session must not stream from a deleted inode. |
| **Registry handle unknown / revoked** | Registry lookup | `{"ok":false,"code":"denied"}`. Handles are revoked on source change and on session end. Also validate the requesting member is in the current roster — the proxy token authorizes the *local* WebView, it says nothing about whether a remote member may read a given file. |
| **Orphaned host ffmpeg** | — | Every beam stream owns its child; killed on `WriteError::Stopped`, on peer disconnect, on handle revoke, and on session end. Copy the `ShareProcs` bookkeeping pattern (`stream_proxy.rs:1024-1048`, `:1339-1357`) **including the "don't clobber a newer pipeline's pids" guard at `:1354`**, keyed per `(member, gen)`. Without this, a scrubbing guest accumulates ffmpeg processes on the host's machine — where the host cannot see them. |
| **Relay-path bandwidth** | `Connection::stats()` — direct vs relay | When hole-punching fails, iroh falls back to n0's public relays. Today that carries a JSON trickle; beam would push megabits of the user's media through someone else's infrastructure (still E2E-encrypted). **Gate beam on a direct path by default**, with an explicit user-visible opt-in before relayed media flows. |

### Declared fallback: WebRTC media track
The precedent already works — `src/lib/share-stream.ts:71` does `video.captureStream()` on a hidden MSE-fed `<video>`, and `rtc-mesh.ts:127` `setVideoOverride` swaps that track onto every sender. Wire it as the *degraded* path only: it is a generational re-encode at ~360p (`rtc-mesh.ts:194-203`), costs continuous host CPU, and — fatally for the workflow — the peer cannot seek, scrub, frame-step, or pause to write a comment. Never make it the default; label it honestly when it engages.

### Two claims in the incoming research that are inferred, not measured
1. **End-to-end backpressure through tiny_http → QUIC → ffmpeg** is inferred from code structure (`stream_proxy.rs:672-673` comment + `MSEStreamPlayer.tsx:747-750`), not observed. Measure it in Phase 1 before the design leans on it.
2. **WKWebView MSE behavior with WAN-cadence fragments** is untested. The encoded output's box layout (`ftyp/moov/moof/mdat`) is structurally identical to today's `-c copy` stream, which is strong but not conclusive.

### Constitution change — do this visibly
`session.rs:6-7` states *"Media NEVER transits peers… only tiny JSON control lines cross the wire,"* and CLAUDE.md repeats it. This feature inverts that. Rewrite both comments in the same PR, and surface it in the UI at share time — this is the first feature that sends user file *content* off-machine. It stays P2P and user-initiated (compatible with the local-first rule), but it is a real change to the app's data-flow story and must not be buried in a session join.

---

## 7. Phasing

Each phase ends green on: `npx tsc --noEmit` · `npm test` · `npm run test:e2e` · `cargo check` · `cargo test --lib` · `swift build` (unaffected but in CI).

### Phase 0 — Sync foundation (frontend + 2 message variants)
No beam code. Fixes a live bug and de-risks everything downstream.
- `SessionMsg::Ping`/`Pong`; regenerate `src/bindings/SessionMsg.ts` via `cargo test --lib`.
- `src/lib/session-clock.ts` + tests (min-RTT filter, median, EWMA, <3-sample behavior).
- Apply offset at `use-co-review.ts:280`.
- Three-zone `decideChase` with `seekThresholdSec`/`nudge`; extend `use-co-review.test.ts` (deadband, nudge clamp ±5%, exit at 40ms, seek-storm guard).
- Enforce `Transport.seq` monotonicity within `Presenter.epoch`.
- **Bump `EXPECTED_BACKEND_BUILD_ID`** (`src/lib/build-id.ts`) and `BACKEND_BUILD_ID` (`src-tauri/src/commands/system.rs`).
- **Testable:** two machines on the *existing* web co-review. Drift should visibly collapse. Deliberately shippable on its own.

### Phase 1 — Thin vertical slice: beam an H.264 MP4
- `src-tauri/src/beam.rs`: `BeamRegistry`, `BeamReq`/`BeamResp`, `BeamReader`, host serve task, fixed 720p ladder rung, Sdr8 color branch only.
- `session.rs`: `conn: Connection` on `PeerConn` (`:267`); beam `accept_bi` loop on both sides; `set_priority(-1)`; `beam: Option<String>` on `LoadSource`; commands `session_beam_publish` / `_revoke` / `_url`.
- `stream_proxy.rs`: `beam://` in `decode_after` (`:518`) **only**; `serve_beam()` branch in `serve_fmp4` (`:529`); header translation; epoch probe on the host.
- Frontend: `disableScrubPreview` prop; beam fallback on `SourceStatus "missing"` in `use-co-review.ts`; `onMediaError` returns false for beam in `use-web-playback.ts:84-86`.
- Seek + cancel + teardown included (nearly free once the rebuild path exists).
- New Rust tests: `decode_after` accepts `beam://` / `decode_upstream` rejects it / `file://` rejected by both (beside `stream_proxy.rs:828`); `BeamReq`/`BeamResp` round-trip; registry rejects unknown handle, revoked handle, non-roster member, and a deleted path.
- New vitest: `beam-quality.ts` (Phase 2 logic can land as pure functions here early).
- **Testable end-to-end by the user on two Macs:** host opens a 1080p H.264 .mp4 the guest does not have; guest watches, scrubs, stays in sync. **Measure here:** rebuild latency, whether backpressure actually stalls the host's ffmpeg (`top` on the host during a peer-side pause), and iroh throughput on the real link. Re-tune `seekThresholdSec` and the 20s stall guard from these numbers before Phase 2.

### Phase 2 — Every format
- Sdr10 and HDR color branches wired from `classify_playback_color`.
- Rung ladder + `?rung=` parameter + manual selector in `SettingsModal.tsx` matching the `previewMaxHeight` vocabulary.
- Auto downshift/upshift from `beam-quality.ts`.
- **Testable:** host opens ProRes 422 HQ, HEVC 10-bit, and an HDR PQ file. Guest sees correct color, not grey and not banded. Throttle the guest's link (Network Link Conditioner) and watch the rung drop without oscillating.

### Phase 3 — Hardening
- Process-ownership audit against the `ShareProcs` pattern; leak test (scrub 50 times, assert zero orphaned ffmpeg on the host).
- Concurrency cap, thermal/sidecar-contention rung clamp, host-side "streaming to N" chip.
- Direct-path gate for relayed media + the disclosure UI.
- Re-stat-on-open for moved/deleted files; all `ok:false` codes surfaced with real copy.
- WebRTC-track fallback wired behind sustained-starvation detection.
- Rewrite the "media never transits peers" comments in `session.rs:6-7` and CLAUDE.md.
- e2e: add a beam-source boot case to `e2e/tauri-mock.ts` (mock the invoke returning a beam URL; assert Monitor renders `MSEStreamPlayer` and no pageerrors). Native transport stays manual-verified, consistent with the harness's stated scope.

**Build-ID discipline:** Phases 0, 1, and 2 each change the invoke surface or `SessionMsg`. Bump both build IDs and re-run `cargo test --lib` in each.