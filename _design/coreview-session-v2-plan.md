# Sauce Bunny co-review session layer — unified implementation plan

**Target checkout:** `/Users/gchiaramonte/sb-ui-v3` @ `355b946` (clean tree). A second near-identical checkout exists at `/Users/gchiaramonte/Desktop/Clip Pull`; all line numbers below were re-verified by reading `sb-ui-v3` directly. Confirm which checkout is being built before applying patches.

---

## 0. Conflict resolution (read this first)

The six reports proposed **five mutually incompatible `SessionMsg` shapes**. Resolved as follows — these decisions are binding on every phase.

| Conflict | Reports in tension | Decision |
|---|---|---|
| How to describe a local-file source | SOURCE SYNC (widen `LoadSource`) vs HANDOFF (new `LoadLocal` variant) vs CLEAR/SWITCH (new `UnloadSource`) | **One variant.** `LoadSource` is widened with a `kind` discriminator covering `"web" \| "file" \| "none"`. `"none"` *is* the unload/clear message. No `LoadLocal`, no `UnloadSource`. This keeps a single echo guard, a single join-replay path, and a single guest handler. |
| ALPN bump vs `#[serde(default)]` | HANDOFF (avoid bump) vs SOURCE SYNC / IDENTITY (bump) | **Bump once, to `saucebunny/coreview/2`.** `LoadSource` is breaking regardless, so `serde(default)` cannot save compatibility — and HANDOFF's own risk note says a defaulted `epoch` produces a peer that "appears connected but frozen". One clean connect-time failure beats a silent half-session. Nothing is distributed yet. |
| Floor/permission naming | HANDOFF (`Controller` / `RequestControl`) vs HOST TRANSFER (`Presenter`) | **`Presenter`.** Matches the product vocabulary and the badge UI. `RequestPresenter` (guest asks) is **deferred out of v1** — host-grants-only. |
| Where the source/transport permission is enforced | HANDOFF and HOST TRANSFER both say Rust; SOURCE SYNC is silent | **Rust, at `handle_peer_conn`'s relay match** (`session.rs:552-588`). It is the system's only trust boundary and already rewrites `from` on Rtc/Sharing/Reaction to prevent spoofing. |
| The dead `role === "guest"` branch | SOURCE SYNC (→ `"peer"`) vs HOST TRANSFER (→ `!isPresenter`) | **Neither string.** Drive the waiting state off `sourceStatus`/`pendingSource`, not off role. Never teach Rust to emit `"guest"` — the vocabulary is `"off" \| "host" \| "peer"` (`session.rs:130`, `:832`). |
| Doc re-seed | SOURCE SYNC (null-doc guard) vs CLEAR/SWITCH (flush-then-reseed on key change) | **CLEAR/SWITCH's version**, which strictly subsumes SOURCE SYNC's. Flush the outgoing doc *first*, then seed, then broadcast. Plus a null-doc fallback so a mid-session load seeds. |
| Cross-machine review key | SOURCE SYNC (broadcast `review_key`) vs HANDOFF (fingerprint) | **Both, unified:** the broadcast `review_key` **is** the fingerprint for `kind:"file"` and the `webpage_url` for `kind:"web"`. Guests resolve it locally via `resolveByFingerprint` and persist under *their* local key, never the host's path. |
| `room.css:22` | CLEAR/SWITCH says do not delete | **Do not delete.** It strips the sidebar/queue/bell deliberately (`edab1f8`). Add a purpose-built `RoomSourceBar` instead. |
| Mesh edits colliding | IDENTITY (epoch rebuild in `setMembers`, terminal states) vs CAMERA (transceivers in `connectTo`) | Sequenced: **Phase 4 touches `setMembers` + `onconnectionstatechange` + `dropPeer`; Phase 5 rewrites the `addTrack` loop inside `connectTo`.** Near-disjoint, but land 4 before 5 and re-run `src/lib/rtc-mesh.test.ts` between. |

**Compile-safety note (verified):** `peer_read_loop`'s match (`session.rs:706-736`) is **exhaustive with no `_` arm** — every new variant will fail `cargo check` until whitelisted. Good. But the host relay match (`session.rs:552-587`) **does** end in `_ => {}`, so new peer-originated arms are silently dropped unless added by hand. This is exactly where `LoadSource`/`Transport` die today.

---

## 1. FINAL `SessionMsg` — the complete wire contract

Location: `/Users/gchiaramonte/sb-ui-v3/src-tauri/src/commands/session.rs:71-114` (enum), `:119-124` (`PeerInfo`), `:126-136` (`SessionState`), `:39` (ALPN).

All of it lands in **Phase 1**, even where the frontend doesn't consume it yet — one ALPN bump, one binding regeneration, one build-ID bump for the whole programme.

```rust
const ALPN: &[u8] = b"saucebunny/coreview/2";   // was /1 (session.rs:39)

pub enum SessionMsg {
    // ── CHANGED ─────────────────────────────────────────────
    /// peer → host right after connect. `install` is a stable per-install
    /// UUID (localStorage saucebunny.installId) so a rejoining member
    /// RECLAIMS its member id instead of minting a duplicate slot.
    Hello { name: String, install: String },

    /// presenter → everyone: what the room is watching. ONE variant for all
    /// three cases; `kind` discriminates.
    ///   "web"  → url is Some, guest re-resolves it with its OWN yt-dlp
    ///   "file" → url is None, guest resolves `fingerprint` on its own disk
    ///   "none" → the source was cleared; guests unload
    /// `review_key` is the SHARED review-doc identity: the fingerprint for
    /// files, the webpage_url for web. Never a host-local path.
    LoadSource {
        from: String,                 // host-stamped
        kind: String,                 // "web" | "file" | "none"
        url: Option<String>,
        fingerprint: Option<String>,  // reviewFingerprint(), file kind
        title: Option<String>,
        duration: Option<f64>,
        review_key: String,           // "" when kind == "none"
    },

    /// presenter → everyone: transport truth. at_ms = sender wall clock (ms).
    /// `from`/`epoch` make ordering total across a presenter handover.
    Transport {
        playing: bool, position: f64, rate: f64, at_ms: f64, seq: u32,
        from: String,                 // host-stamped presenter id
        epoch: u32,                   // presenter epoch
    },

    // ── NEW ─────────────────────────────────────────────────
    /// any member → everyone: could I open the presenter's source?
    /// state: "loading" | "ready" | "failed" | "missing"
    SourceStatus { from: String, state: String, detail: Option<String> },

    /// host → everyone: who drives source + transport. NOT the network star,
    /// which never moves. `epoch` increments on every grant.
    Presenter { member: String, epoch: u32 },

    /// peer → host: explicit departure, so a leave is declared not inferred.
    Bye,

    // ── UNCHANGED ───────────────────────────────────────────
    Welcome { you: String, title: Option<String> },
    PeerList { peers: Vec<PeerInfo> },
    Rtc { from: String, to: String, payload: String },
    ReviewOp { op: String },
    ReviewDoc { doc: String },
    Presence { name: String, position: f64 },
    Sharing { from: String, on: bool },
    Reaction { from: String, emote: String, on: bool },
}

pub struct PeerInfo {
    pub id: String,
    pub name: String,
    pub epoch: u32,   // NEW: bumped on every claim/reclaim of this id, so the
                      // mesh rebuilds a slot whose peer reconnected
}

pub struct SessionState {
    // ... existing role/code/peers/self_id/title/error ...
    pub presenter: String,   // NEW: member id driving; "" while off
}
```

**Explicitly rejected variants:** `LoadLocal` (folded into `LoadSource{kind:"file"}`), `UnloadSource` (folded into `kind:"none"`), `RequestControl`/`RequestPresenter` (deferred), `Controller` (renamed `Presenter`).

**Mandatory mechanics for every phase that touches Rust:**
1. `cd src-tauri && cargo test --lib` regenerates `src/bindings/SessionMsg.ts`, `SessionState.ts`, `PeerInfo.ts` (ts-rs freshness is asserted by the test suite).
2. Bump **both** build IDs in the same commit — `src/lib/build-id.ts:10` and `src-tauri/src/commands/system.rs:715`, both currently `"2026-07-19-r123-onboarding"` → **`"2026-07-24-r124-coreview-v2"`**. `session_join`'s invoke signature changes in Phase 1, so this is required exactly once.

---

## 2. What genuinely cannot work — state it in the UI, don't paper over it

**Local-file bytes cannot be transferred.** `src-tauri/Cargo.toml` declares `iroh` + `iroh-tickets` only; `Cargo.lock` resolves iroh 1.0.2, iroh-base, iroh-dns, iroh-metrics, iroh-relay, iroh-tickets — **no blob crate**. The transport is one bi-di QUIC stream per peer carrying newline-delimited JSON capped at 2 MB/line (`session.rs:47`). Shipping a 4 GB ProRes file would mean adding `iroh-blobs` (a heavy dep, barred by CLAUDE.md without strong justification) or hand-rolling a second ALPN with chunking, resume, disk quota and progress UI.

**Honest fallback ladder** (Phase 3), cheapest first:
1. `resolveByFingerprint(fp)` (`src/lib/review.ts:195`) → the guest has already reviewed this exact content → `loadLocalPath(path)`. Zero bytes.
2. Library-folder probe: `scan_library_folder` (`src-tauri/src/commands/library.rs:231`) matched on name-stem + `size_bytes` → `loadLocalPath` + `linkFingerprint`. Cache the scan; do not walk the tree on every `LoadSource`.
3. Miss → `SourceStatus{state:"missing"}` and a named room state: *"Marco is reviewing `cut-v4.mov` — you don't have this file."* Two **grey chip** CTAs: **Open my copy…** (→ `loadLocalPath` → auto-`linkFingerprint`) and **Ask to share screen** (drives the already-built `share-machine.ts` → `start_screen_share` → `stream_proxy.rs:215-219` pipeline).

**Fingerprint hit-rate is lower than intuition suggests.** `reviewFingerprint` (`review.ts:185-192`) is `name|duration_tenths|WxH|size` — a guest's H.264 proxy of the host's ProRes master **will miss**. Treat tier-3 as the expected path in post workflows, not the exception.

**Second thing that cannot work:** the network star cannot move. `Session::Host` structurally owns the iroh `Endpoint` + `accept_task` (`session.rs:172-194`); moving it invalidates the already-pasted invite ticket. "Host transfer" is scoped as **presenter/floor passing within a live session**, never re-hosting. When the host leaves, `fail_peer_to_off` (`session.rs:755`) still tears everyone down. Name the feature accordingly.

---

## 3. Riskiest assumptions — validate these BEFORE building on them

Run these four checks first. Each is cheap and each invalidates a whole phase if wrong.

**A1 — Does the guest's independent yt-dlp resolve the same URL?** (Phase 1's entire premise.) Two machines, same plain YouTube URL, run `handleFetch` manually on each. Different `previewMaxHeight` (`App.tsx:232`), different cookie state (`App.tsx:299`), geo-routed CDN variants, and slightly different durations (ads/regional cuts) are all live divergence modes. If durations differ by >1s, positions do not mean the same thing on both screens and the chase is chasing a fiction. **Validate before building the `SourceStatus` UI.**

**A2 — Do fingerprints actually match across machines?** Put the same file on both Macs, log `reviewFingerprint(...)` on each. Byte size and duration-to-tenths must match exactly. If they don't, Phase 3 tier-1 is dead and tier-3 is the only path.

**A3 — What is the real ghost-timeout today?** IDENTITY's ~30s figure comes from quinn's `max_idle_timeout` default, not from this app. Force-quit a guest and time roster removal on the host. If it's already fast, skip the `max_idle_timeout` tuning in Phase 4 and rely on `Bye` + `RunEvent::Exit` alone.

**A4 — Does `addTransceiver` behave in WKWebView here?** Phase 5's whole design. Two machines, both joining **camera-off**, then both turning the camera on. If pre-negotiated transceivers don't associate correctly in this WebKit build, fall back to a renegotiation design — but note `handleSignal`'s catch (`rtc-mesh.ts:104-106`) would swallow the glare `InvalidStateError`, so renegotiation needs rollback handling that does not exist today.

---

## Phase 1 — The guest sees the host's source (headline fix)

**Value:** fixes the screenshot. Today a local file broadcasts *nothing* (the effect at `use-co-review.ts:339-341` early-returns on `!activeSourceUrl`, which is set only at `App.tsx:1858` in the web `handleFetch` and nulled at `App.tsx:1807`), and the guest's explanatory banner is dead code (`App.tsx:5020` tests a role string Rust never emits).

### Files and changes

**`src-tauri/src/commands/session.rs`**
- `:39` — ALPN → `b"saucebunny/coreview/2"`.
- `:71-114` — land the **complete** enum from §1 (all variants, including `Presenter`/`Bye`/`SourceStatus`, even those unused until later phases — one break, one bump).
- `:119-124` — `PeerInfo` gains `epoch: u32` (populate `0` for now).
- `:126-136` — `SessionState` gains `presenter: String`.
- `:198-213` — `HostShared` gains `presenter: AtomicU64` (init `0` at `:259-264`, mirroring `next_member: AtomicU64::new(1)` at `:261`). **Must be an atomic, not a `Mutex`** — the relay reads it and then `.await`s `relay_to_others`, and this file's lock-order doctrine (`:140-145`, `:210-211`) forbids holding a std guard across an await.
- `:286-291` — `session_join` gains an `install: String` parameter, forwarded into `Hello`.
- `:508` — `handle_peer_conn` still mints unconditionally in this phase; Phase 4 adds reclaim.
- **`:552-588` — the key edit.** Replace `_ => {}` (`:586-587`) with explicit presenter-gated arms:
  ```rust
  SessionMsg::LoadSource { .. } | SessionMsg::Transport { .. } => {
      if !can_drive(shared.presenter.load(Ordering::Relaxed), &member) { continue; }
      let msg = stamp_from(msg, &member);
      let _ = app.emit("session:msg", &msg);   // host follows too
      relay_to_others(&shared, id, &msg).await;
  }
  SessionMsg::SourceStatus { state, detail, .. } => {
      let msg = SessionMsg::SourceStatus { from: member.clone(), state, detail };
      let _ = app.emit("session:msg", &msg);
      relay_to_others(&shared, id, &msg).await;
  }
  _ => {}   // Presenter/Bye are host-only or handled elsewhere
  ```
- Next to `build_roster` (`:983-990`), add pure helpers for unit testing without a network: `fn member_num(id: &str) -> u64` (`m<N>` → N, malformed → `u64::MAX`) and `fn can_drive(presenter: u64, member: &str) -> bool`.
- `:384-435` `session_broadcast` — extend the `from: "m0"` stamping match to `LoadSource`, `Transport`, `SourceStatus`.
- `:706-736` `peer_read_loop` — add `SourceStatus | Presenter` to the pass-through whitelist. (`LoadSource`/`Transport` are already there at `:726-733`.) The exhaustive match will not compile until you do.
- `:805-840` `snapshot_state` — Host arm formats `m{presenter}`; Peer arm reads a new `presenter: Arc<Mutex<String>>` stored exactly like `roster`/`title` (`:341-343`); Off arm returns `String::new()`. Default `"m0"` for host, `"m0"` for peers until a `Presenter` line arrives.

**New: `src/lib/identity.ts`** (~15 lines, no new dep)
```ts
// saucebunny.installId — a stable per-install UUID so a rejoining member
// reclaims its roster slot instead of minting a duplicate.
export function loadInstallId(): string { /* localStorage + crypto.randomUUID() */ }
```
`crypto.randomUUID` is already used at `review.ts:99`; the `saucebunny.*` namespace matches CLAUDE.md's storage table. **Add a row to that table** — this is a new persisted cross-session identifier shared with other participants (see Risks).

**`src/App.tsx`**
- Beside `reviewSourceKey` (`:4522-4524`), add one memo — this is the change that unblocks local files, because it stops routing source identity through a web-only variable:
  ```ts
  const sessionSource = useMemo(() => {
    if (!metadata) return { kind: "none" as const, url: null, fingerprint: null, title: null, duration: null, reviewKey: "" };
    if (sourceKind === "file") {
      const fp = reviewFingerprint(metadata.title ?? localFilePath ?? "", metadata.duration ?? 0, metadata.width, metadata.height, localFileSize);
      return { kind: "file" as const, url: null, fingerprint: fp, title: metadata.title ?? null, duration: metadata.duration ?? null, reviewKey: fp };
    }
    return { kind: "web" as const, url: activeSourceUrl, fingerprint: null, title: metadata.title ?? null, duration: metadata.duration ?? null, reviewKey: metadata.webpage_url ?? "" };
  }, [sourceKind, metadata, localFilePath, localFileSize, activeSourceUrl]);
  ```
- `:4553-4568` — pass `sessionSource` into `useCoReview` **in place of** the bare `activeSourceUrl` (keep `activeSourceUrlRef` — the guest handler still needs it for the dedupe compare).
- `:5020-5022` — replace the dead `coSession.role === "guest"` branch. Drive it off the new `pendingSource`/`sourceStatus` from the hook, not off role:
  ```tsx
  {roomActive && !isPresenter && pendingSource && (
    <div className="cp-room-waiting">…</div>
  )}
  ```
  `.cp-room-waiting` already exists at `room.css:101`.
- `:4344` — `menu:open_url_bar` calls `setActiveView("clip")` unconditionally, ejecting a host from the room mid-session. Change to `openSourceView()` (`:2463-2465`). Sticky-workspace violation, unrelated to the rest but one line.

**`src/hooks/use-co-review.ts`**
- `:339-342` — drop the `!activeSourceUrl` guard; key on `sessionSource`; mirror into a `sessionSourceRef` (matching the existing `sessionDocRef` pattern) and read that ref in the join-time replay at `:350-352`. Route the send through the existing `sendSessionMsg` (`:192-195`) rather than hardcoding `invoke("session_broadcast")` — this is what makes Phase 6 a gate change instead of a rewrite.
- `:366-383` — same: `sendSessionMsg(msg)` instead of the hardcoded broadcast at `:378`. Add `from` + `epoch` to the payload.
- `:207-219` — branch the guest handler on `kind`:
  - `"web"` — today's `setUrl` + `handleFetch`, plus **harden the dedupe guard at `:210`**: compare `normalizeUrl(m.url)` to `activeSourceUrlRef.current`. It currently compares a raw wire value to a normalized local one and survives only because the host happens to broadcast a post-normalization URL (`App.tsx:1858`). One raw-URL caller turns every join re-broadcast (`:346-354`) into a room-wide resolve storm.
  - `"file"` — **do not fetch.** Set `pendingSource` state (Phase 3 builds the resolve ladder; Phase 1 just shows the waiting affordance).
  - `"none"` — clear: `setPendingSource(null)`, unload.
- Emit `SourceStatus{state:"loading"}` when `handleFetch` is invoked, and `{state:"ready"}` at the existing `justLoaded` edge (`:276-278`) — that edge already fires exactly once per source.
- **Doc seed rewrite** (`:315-336`), required independently of source sync. The current guard `coSession.role === "host" && prev !== "host"` (`:318`) is dead for any source loaded *after* the session starts, even though `reviewSourceKey` is in the dep array (`:336`) — because `prevCoRoleRef` is reassigned at the top of every run (`:317`). Replace with, in this order:
  1. **Flush the outgoing doc first** — reuse the leave-path save at `:328`: `const d = sessionDocRef.current; if (d?.sourceKey) saveReview(mergeReviewDoc(loadReview(d.sourceKey), d));`. Today role→`"off"` is the **only** save point; without this, a source switch destroys the whole thread.
  2. Seed: `if ((role === "host") && (!sessionDocRef.current || keyChanged) && reviewKey) { setSessionDoc(ensureVersion(loadReview(reviewKey), reviewKey, title).doc) }`.
  3. Broadcast `{kind:"reviewDoc", doc}` so guests converge (same message already used on join at `:354`).
  4. On a `"none"` source, `setSessionDoc(null)` **and explicitly** `setReviewMarkers([]); setReviewAnnotations([])` — the projection effect early-returns on a null doc (`:479`) and would otherwise leave stale markers, while App's solo reload has already disabled itself with `if (coSessionActive) return` (`App.tsx:4663`).
  5. Set `coReadyRef.current = false` on the host's own swap so the heartbeat can't publish the old player's position against a new video (the guest already does this at `:215`).

**`src/lib/review.ts:518`** — add a sourceKey guard at the top of `mergeReviewDoc`: when `local.sourceKey !== incoming.sourceKey`, return `incoming` verbatim with no comment union. Verified: the function currently does `{ ...incoming, comments: <union> }` with no identity check (`:518-544`), so a mid-session source change unions source A's comments into source B's on-disk doc on every guest. Cover it in `src/lib/review.test.ts`.

**`src/hooks/use-co-review.ts` + `src/lib/build-id.ts:10` + `src-tauri/src/commands/system.rs:715`** — `invoke("session_join", { ticket, name, install: loadInstallId() })` at `:432`; `joinCoReview(ticket, name)` stays unchanged at the `CoReviewLobby.tsx:94` seam. Both build IDs → `"2026-07-24-r124-coreview-v2"`.

### Gates
`npx tsc --noEmit` · `npm test` · `npm run test:e2e` · `cd src-tauri && cargo check && cargo test --lib` (regenerates the three bindings; add a `"loadSource"`/`"sourceStatus"`/`"presenter"` camelCase assertion to `variant_tags_are_camel_case` at `session.rs:920`, and a `can_drive`/`member_num` table test in `member_id_tests` at `:992-1025`) · `cd swift-sidecar && swift build`.

### Manual verification (two machines)
1. Both machines on the new build. Confirm no stale-binary banner (build-ID handshake).
2. Host starts a session, guest joins, **then** host pastes a YouTube URL. Guest's Monitor must load the same video — not "Paste a URL or drop a file."
3. Reverse order: host loads the URL **first**, then the guest joins. The join-replay at `:346-354` must still deliver it.
4. Host loads a **local file**. Guest must show the new waiting affordance naming the file, **not** the solo empty state.
5. Host clears the source (⌘K → "Clear source" works today). Guest must unload, and its timeline markers must go empty.
6. Leave the session on both. Check `~/Documents/Sauce Bunny/Reviews/` — the comment thread for each source must be intact, and no cross-contamination between the two docs. Watch for stray `.bak` files (the shrink guard at `review-store.ts:230-242` firing is a signal something collapsed a doc).

---

## Phase 2 — Playhead sync correctness

**Value:** three live bugs on the already-working host-only path. Ship before any transfer feature.

**`src/hooks/use-co-review.ts:270-304`**
- **Clock skew (verified live bug).** `:280` computes `expected = m.position + (Date.now() - m.atMs)/1000 * m.rate`, comparing the *sender's* `Date.now()` (`:375`) to the *receiver's*. A 2 s wall-clock offset between the two Macs is a permanent 2 s error, permanently exceeding the 0.5 s tolerance → a seek on **every** 500 ms heartbeat, and on the web path every seek rebuilds the ffmpeg stream. Fix with zero new messages: track a running **minimum** of `(recvLocalMs - m.atMs)` over a ~20-sample / 10 s ring (NTP-lite; the minimum is robust because network delay is one-sided). Use offset `0` and suppress corrections until ≥4 samples — the existing `justLoaded` snap (`:276-278`) covers the gap. Reset the window on session start and on presenter epoch change.
- **Rate is broadcast but never applied.** `coRateRef` (`:185`) is sent at `:374` and consumed only inside the `expected` extrapolation. Call `p.setPlaybackRate(m.rate)` — **guarded on `p.supportsPlaybackRate`**, which `MediaBunnyPlayer` returns false for by design (`src/components/player-handle.ts`).
- **Deadband + cooldown.** In `decideChase` (`:610-624`, pure and unit-tested): playing tolerance 0.5 → **0.75 s**; add `sinceLastChaseMs` to `ChaseInput` and suppress a correction within **1000 ms** of the previous chase seek (skip the cooldown when `justLoaded`). Keep the paused branch (`:620`) as-is — it is frame-accurate and correct. Keep the RC3 latch at `:289` and keep routing through `onChaseSeek` (`App.tsx:4100`), never `onSeek` — the omission of `markUserSeek` there is load-bearing.
- **Do NOT add playbackRate soft-sync as a drift mechanism.** CLAUDE.md's r82/r88 note retires exactly that, and it is unavailable on `MediaBunnyPlayer`.
- **Echo suppression** (latent today, mandatory before Phase 6): an `applyingRemoteRef` set around the `p.play()/p.pause()/onChaseSeek/setPlaybackRate` block (`:299-302`) and cleared on the next **macrotask** (`queueMicrotask` is too early — the player's state callback lands in a later task), plus a `(epoch, seq)` monotonic gate applied *before* the ref is set. Without the first, an applied remote pause reflects through `onPlayerStateChange` (`App.tsx:1622`) → `setIsPlaying` → `coPlayingRef` → re-broadcast.
- Optional polish: stash the last `Transport` in a ref at the `!p.isReady()` bail (`:274`) and replay it on the first ready tick, so a late-loading guest snaps immediately instead of waiting up to 500 ms.

**Gates:** as Phase 1. Extend `src/hooks/use-co-review.test.ts` (today it only covers `decideChase`, `:17-63`) with cases for the cooldown and a nonzero clock offset.

**Manual:** set one Mac's clock 3 s ahead (System Settings → Date & Time, disable auto). Play a 10-minute video for 2 minutes. The guest must stay locked without visible re-seeking, and the log must not show repeated chase corrections. Then set the host to 1.5× — the guest must actually run at 1.5×, not seek-correct once a second.

---

## Phase 3 — Local-file source handoff (the fingerprint ladder)

**`src/hooks/use-co-review.ts:207-219`** — on `LoadSource{kind:"file"}`, run the three-tier ladder from §2, reporting `SourceStatus` at each outcome.

**`src/App.tsx:4998`** — new grey-chip room affordance inside the existing `.cp-room-head-actions` (`room.css:88-93`), before "Copy join code" (`:4999-5008`). Two CTAs on a tier-3 miss: **Open my copy…** → `loadLocalPath` (`App.tsx:2467`) → auto-`linkFingerprint`; **Ask to share screen** → the already-built `share-machine.ts` pipeline. Grey chip + icon per house rules; green stays on `.cp-room-live` (`room.css:58-64`).

**`src/components/CoReviewLobby.tsx:179-183`** — replace the dead-end hint ("Local files can't be shared yet…") with the ladder's copy.

**`src-tauri/src/commands/library.rs:231`** — tier 2 uses `scan_library_folder`'s `LibraryItem { name, size_bytes, … }` (`:45-55`). **Cache the scan or build the index at idle** — walking the tree synchronously on every `LoadSource` stalls the room.

**Manual:** copy the *same file, byte-identical* to both machines (A2 must have passed). Host opens it → guest must auto-open its copy with zero prompting. Then rename the guest's copy and repeat (fingerprint is location-independent, so it must still hit). Then delete the guest's copy → the "Open my copy / Ask to share screen" state must appear, and screen-share must work from there.

---

## Phase 4 — Identity, rejoin, and mesh terminal states

**`src-tauri/src/lib.rs:294-299`** — highest value per line: `RunEvent::Exit` currently shuts down only `LlmServer`. Tear the session down alongside it so iroh's graceful close actually runs, converting the most common "leave" gesture from a ~30 s ghost into an instant prune. **Bound it with a short `tokio::time::timeout`** — iroh documents close as taking up to ~3 s on bad connectivity, and quit must never visibly hang.

**`src-tauri/src/commands/session.rs`**
- `session_leave`'s peer arm (`:793-800`) writes `SessionMsg::Bye` before `endpoint.close()`; the host read loop (`:552-588`) handles it by breaking to the existing removal tail (`:595-603`).
- `HostShared` (`:198-213`) gains `claimed: Mutex<HashMap<String /*install*/, String /*member*/>>`. In `handle_peer_conn` (`:507-535`) replace the unconditional mint at `:508`: on an install hit, **reuse the member id and evict any still-open `PeerConn` holding it** (close + `peers.retain`) so the roster can never hold two rows for one install; bump `PeerInfo.epoch`. **The reclaim path must bypass the `MAX_PEERS` checks at `:513-520` and `:528-533`** — a reclaimer replaces rather than adds, otherwise rejoining a full room is refused while your own ghost holds the seat. Session-scoped; deliberately not pruned on disconnect (that retention is what makes the slot reclaimable). Bounded by `MAX_PEERS = 3` (`:42`).
- **Guard against the clone case:** if the existing conn for that install is demonstrably alive (recent read), refuse the reclaim and mint fresh. Two machines sharing an install id (cloned disk, Time Machine restore) would otherwise evict each other in a loop.
- Converge every prune path through one `drop_peers(shared, dead) -> bool` helper. `relay_to_others` (`:608-624`) and `relay_to_member` (`:628-644`) currently prune write-failed peers **without** re-broadcasting — `:643`'s `let _ = dead;` defers it to "the next `broadcast_peer_list` pass", so every client's visible roster can lag the host's truth indefinitely. Have them report drops and run `broadcast_peer_list` + `emit_state_now`, the same treatment `session_broadcast` already gets at `:429-433`.
- Only after A3 says it's needed: shorten `max_idle_timeout` on the co-review endpoints (`:244-248`, `:303-306`) to **10–15 s, never below 10**. iroh's 1 s keep-alive makes this safe in the normal case; `Bye` + `RunEvent::Exit` are the primary mechanisms, this is only a backstop for crash/sleep/network-drop.

**`src/lib/rtc-mesh.ts`** — "connecting" is currently an absorbing state. Verified: `onconnectionstatechange` (`:214-234`) branches only on `"connected"` and `"failed"`; `"new"`, `"connecting"`, `"disconnected"`, `"closed"` fall through and there is no timer anywhere in the class.
- Arm a ~12 s deadline in `connectTo`; if still `"connecting"` when it fires, `setState(id, "failed")`. Clear it on connect, in `dropPeer` (`:160-164`) and in `close()` (`:150-154`) or vitest will leak timers between cases. This alone turns a ghost tile from "Connecting" forever into "No connection", which `PeoplePanel.tsx:153` already renders.
- Handle the full state set: `"disconnected"` → stay connecting but re-arm; `"closed"` → drop.
- `dropPeer` must notify the hook (widen `onState` to `(id, state | null)` or add `onPeerGone`), and `use-rtc-mesh.ts:117-119` needs a delete branch — `peerStates` is append-only for the whole session today.
- `setMembers` (`:70-81`) takes `{id, epoch}[]` and rebuilds any slot whose epoch changed (`dropPeer` + `connectTo`). **This part is not optional.** Shipping the identity fix without it produces a subtler bug than the current one: the roster looks correct (one row, same id) while every peer's tile for the rejoiner sits on the dead pre-rejoin `RTCPeerConnection`.
- Seed the new mesh with the current roster inside the lifecycle effect (`use-rtc-mesh.ts:81-133`) via a `memberIdsRef`. Today membership only arrives via a *separate* effect keyed on `[memberIds]` (`:136-138`); a rebuild driven by `selfId` alone (exactly what a rejoin does, `null → "m2"`) survives only because `coSession.peers` happens to be a fresh array each emit. Any future memoisation that stabilises it yields a memberless mesh and a full panel of permanent "Connecting".

**`src/hooks/use-co-review.ts`** — one effect keyed on `coSession.peers` intersecting `raisedHands` (`:159`) and `sharingMembers` (`:172`) with the live member-id set. Both are currently cleared only wholesale at session end (`:330-332`), so a ghost row keeps a raised hand or a "Sharing screen" badge forever.

**`src/components/PeoplePanel.tsx:66`** — `peerStates.get(p.id) ?? "connecting"` makes a *missing* mesh entry indistinguishable from a live handshake. Give the missing case its own rendering.

**Tests:** `session.rs` `member_id_tests` (`:992-1025`) — `rejoin_with_same_install_reclaims_member_id`, `different_install_same_name_gets_distinct_ids`, `reclaim_evicts_the_stale_conn` (assert no duplicate id in `build_roster` output). `src/lib/rtc-mesh.test.ts` — the `FakePc` at `:17-50` already exposes `fireConnectionState`, so the deadline and the disconnected/closed branches are directly drivable with `vi.useFakeTimers`.

**Manual:** two installs. Guest **force-quits** mid-session (⌘Q, then Force Quit) and relaunches → the roster must show exactly one row for them, the same member id, and the tile must reach `live` (or a terminal "No connection"), never a permanent "Connecting". Repeat with the guest's Wi-Fi toggled off/on.

---

## Phase 5 — Camera reconnect

**Root cause (verified at `rtc-mesh.ts:181-205`):** `connectTo` builds senders only from tracks present at PC-setup time. With an audio-only capture, `slot.videoSenders` stays `[]` forever, so `replaceLocalStream` (`:112-123`) and `setVideoOverride` (`:127-135`) iterate an empty array — the loop body never runs, `replaceTrack` is never even reached. There is no `addTransceiver` and no `onnegotiationneeded` anywhere in `src/`. Same root cause silently breaks **screen share** for anyone who joined camera-off.

`openCapture` (`media-devices.ts:176-186`) requests `video: false` whenever the persisted `cameraOff` is true, and `setEnabled("video", false)` persists that flag — so turning the camera off once makes every future acquire audio-only.

**`src/lib/rtc-mesh.ts`**
- Add `private outStream = typeof MediaStream === "function" ? new MediaStream() : null;` — the `typeof` guard is required, jsdom has no `MediaStream` constructor.
- Replace the `addTrack` loop (`:181-205`) with unconditional `pc.addTransceiver("audio", {direction:"sendrecv", streams:[outStream]})` **then** `"video"` — in that exact order, since both sides run identical code and the answerer's transceivers associate by kind in creation order. **Keep it unconditional**; making it conditional later breaks the invariant. Push `.sender` into the slot arrays and attach existing tracks via `replaceTrack`, honouring `this.audioOverride`/`this.videoOverride` as `:188-190` does today.
- `streams: [this.outStream]` is load-bearing: without it `e.streams` is empty at the remote and `ontrack` (`:211`) builds a separate `MediaStream` per kind, so the second `onRemoteStream` overwrites the first.
- Transceiver creation must precede `sendOffer` (`:236`) **and** the `setRemoteDescription` in the early-offer path (`:88-95`) — where the `addTrack` loop sits today satisfies both.
- Extract the resolution cap (`:194-203`) into `capVideo(sender, track)` and call it after **every** video `replaceTrack`. Today `scaleResolutionDownBy` is computed once from the first camera's height, so a re-acquired camera at a different resolution and a share track both inherit a stale value. Keep the existing try/catch — `getParameters()` before negotiation can return empty `encodings`.

**`src/hooks/use-media-capture.ts:142-145`** — the `bc785d7` guard tests `tracks.length === 0`, but per spec an **ended** track (camera unplugged, Continuity iPhone leaving, hardware preempted) stays in the stream with `readyState === "ended"`. Make it liveness-based:
```ts
const live = tracks.filter((t) => t.readyState === "live");
if (kind === "video" && enabled && live.length === 0) { void acquire(currentChoice); return; }
for (const t of live) t.enabled = enabled;
```
Also attach an `ended` listener to incoming video tracks in `setActive` (`:34-38`) that re-broadcasts to `listeners` — without it the user gets no signal at all: a frozen frame, and `choice.cameraOff` still false so `App.tsx:5273` renders "camera on" over dead hardware.

**`src/components/PeoplePanel.tsx:91`** — add `t.readyState === "live"` to `hasVideo`, and mirror the audio-track listener block (`:102-113`) for the video track (`mute`/`unmute`/`ended`). **Required by the transceiver change**: with pre-negotiated transceivers the remote video track exists from connect time in a `muted` state and merely *unmutes* when the camera turns on. `hasVideo` is a pure render computation with no subscription, so without the listener the remote tile stays on the avatar while frames are arriving.

**`src/lib/rtc-mesh.test.ts`** — `FakePc` needs `addTransceiver(kind, init)` returning `{ sender: new FakeSender(null) }` recorded into `senders`; `FakeSender` must accept a null track; the cap assertion at `:117-122` must move to after a `replaceTrack`. Add the currently-uncovered regression: `makeMesh("m0", { getLocalStream: () => fakeStream(["audio"]) })` → `setMembers(["m1"])` → `replaceLocalStream(fakeStream(["video","audio"]))` → assert a video sender received the new track. Same for `setVideoOverride` from a camera-off start.

**Separable, real, do not fold in:** `mixShareAudio` snapshots the mic at share start (`use-co-review.ts:537`) and `setActive` stops the old stream (`use-media-capture.ts:35`), so turning the camera on during a system-audio share **silences your voice to the room** — `this.audioOverride` (`rtc-mesh.ts:114`) keeps the stale mix on the audio senders. Fix with a `ShareController.remix(micTrack)` driven from `subscribeSessionCapture`.

**Manual:** both machines join **camera-off**, then both turn cameras on — each must see the other (this is A4). Then physically unplug a USB camera mid-session and toggle camera off/on — the local preview must come back. Then: start a system-audio screen share, turn the camera on mid-share, confirm your mic is still audible to the room.

---

## Phase 6 — Presenter transfer

Purely additive now: the Rust enforcement, the `presenter` atomic, the `Presenter` variant, and the `sendSessionMsg` routing all landed in Phase 1.

**`src-tauri/src/commands/session.rs`**
- `session_broadcast` (`:384-435`) — a dedicated `Presenter` block before the generic serialize (alongside the existing `Rtc` early-return at `:402-406`): validate the target is a live member or `m0`, `shared.presenter.store(n)` **before** fan-out, then re-emit `session:state` unconditionally so the host's own snapshot reflects it. Reject unknown members with `AppError::invalid("That person isn't in the session")`.
- Disconnect cleanup (`:598-603`) — before `broadcast_peer_list`: if the departing member held the baton, store `0` and fan out `Presenter{member:"m0"}`. Without this the room has no driver and the stage freezes forever.
- `Presenter` stays host-only by falling through the peer read loop's `_` arm — update that comment at `:586` to say a peer cannot self-promote.

**`src/hooks/use-co-review.ts`**
- Derive `isPresenter` near `coRoleRef` (`:186`) with an `isPresenterRef`; export `presenterId`, `isPresenter`, `canTransfer: coSession.role === "host"`, and `makePresenter(member)`.
- Re-gate the loadSource push (`:339-342`) and the heartbeat (`:366-383`) from `role !== "host"` to `!isPresenter`. **The loadSource re-gate is mandatory, not cosmetic:** if the host keeps pushing on its own source change while a guest presents, the host's fetch (triggered by the guest's `loadSource`) echoes straight back out. The dedupe guard at `:213` makes it *converge* rather than loop, so it will look fine in testing while doubling traffic and racing the presenter. This is the single most likely silent regression in the whole programme.
- The join-replay at `:350-352` stays **host-gated** (only the host reliably observes joins first) and already reads the ref, which the host now keeps in sync because it follows the presenter's `loadSource`.
- Leave host-gated: the reviewDoc snapshot (`:354`), the hand/share re-announce (`:357-363`), and `use-rtc-mesh.ts:91-95`'s `sendSignal` role-picker (must stay keyed on **network** role).
- Reset chase state on presenter change: `coLastHostPosRef.current = null; coSeqRef.current = 0;` keyed on `[coSession.presenter]`. A stale `coLastHostPosRef` suppresses the paused-scrub branch in `decideChase` (`:610-624`) and the first post-handover edge is lost.
- `screeningParticipants` (`:456-474`) — add `isPresenter: p.id === coSession.presenter` to both arms; add `coSession.presenter` to the dep array (`:474`).

**UI.** `Participant` (`PeoplePanel.tsx:9`) gains `isPresenter`. Badge goes in the meta row after the crown (`:159-163`) — **grey chip, not green**; the crown (gold, `room.css:242`) stays the permanent network host. Mirror the badge into the badge cluster (`:156-158`) or accept it vanishing in spine mode, where `room.css:256`/`:278` hide `.cp-person-meta`. The "Make presenter" action is a hover/focus-revealed inline chip **inside `.cp-person` but outside `.cp-person-meta`**, shown when `canTransfer && !p.isSelf && !p.isPresenter`; with `MAX_PEERS = 3` (4 people max) a single inline chip beats an overflow popover. **Wire it into both PeoplePanel mounts** — `App.tsx:4929-4938` (side column) and `:5316-5328` (theater strip) — or the action vanishes in theater. Add a "Take back control" grey chip to `.cp-room-head-actions` when `presenterId !== "m0"`, and extend `CoReviewLobby.tsx:245-247`'s existing `.cp-colobby-person-tag` slot with "Presenting".

**New TS test** in `src/hooks/use-co-review.test.ts` for the `isPresenter` derivation across host/peer/off and the `selfId == null` host fallback.

**Manual:** host promotes the guest. Guest loads a different YouTube URL → the **host's** screen must follow, and so must any third peer. Guest plays/pauses/scrubs → everyone follows. Host clicks "Take back control" → guest's controls go inert. Guest disconnects while presenting → the baton must return to the host and the room must stay drivable. Then: guest presents a **local file** — the honest failure is that they present nothing; surface the Phase-3 copy rather than handing them a baton they cannot use.

---

## Consolidated risk register

**Protocol / build**
- The ALPN bump makes v1 and v2 mutually unjoinable. Deliberate, once, in Phase 1. Note in `CHANGELOG.md`.
- Forgetting `cargo test --lib` drifts `src/bindings/*.ts` from Rust truth and the frontend type-checks a stale contract. Forgetting either build-ID bump gives every user a spurious stale-binary banner.
- The host relay match ends in `_ => {}` (`session.rs:586-587`) — new peer-originated arms are silently dropped unless added by hand. `peer_read_loop` (`:706-736`) is exhaustive and *will* fail the build, which is the desired asymmetry to remember.

**Data loss (highest severity)**
- Shipping any in-room source control without the Phase-1 flush-then-reseed **and** the `mergeReviewDoc` sourceKey guard is **worse than the current bug**: today you cannot switch sources; after a naive fix you can, and doing so discards the outgoing thread and permanently merges source A's comments into source B's on-disk doc on every guest. Land the doc protocol in the same commit as the wire change.
- Keying the shared doc on a broadcast `reviewKey` risks orphaning existing per-path docs in `~/Documents/Sauce Bunny/Reviews/`. Fall back to the existing key when no fingerprint match exists — `resolveByFingerprint` (`review.ts:195`) already has that shape.
- `review-store.ts:230-242`'s shrink guard **will** fire during testing and litter `.bak` files. That is the guard working; check the directory when validating.

**Privacy**
- `saucebunny.installId` is a new stable, persisted, cross-session identifier **shared with other participants**. It never leaves the E2E-encrypted iroh channel and reaches only people handed an invite ticket, so it does not breach the no-telemetry / no-accounts stance — but it is correlatable across sessions in a way the current name-only handshake is not. Document it in CLAUDE.md's storage-layout table and make it regenerable from the existing identity-reset path.

**Correctness**
- Guest-side resolve divergence (A1) is invisible to the protocol: different `previewMaxHeight`, cookie state, yt-dlp version, or a regional cut can give the two machines **different durations**, in which case a synced "position" means different frames on each screen. Surface each peer's resolved duration and warn on a >1 s mismatch rather than silently chasing.
- `presenter` must be an `AtomicU64`, not a `Mutex` — a std guard held across `relay_to_others`'s await is a real deadlock, not a style preference (`session.rs:140-145`, `:210-211`).
- Phase 6 makes the **host** a transport *follower* for the first time. `coReadyRef` / `coLastHostPosRef` / the `p.isReady()` gate (`:274`) have only ever run on peers. The code is role-agnostic, but this is where an integration bug will hide — specifically `justLoaded` (`:276-278`) firing on a host that has had a source loaded the whole time.
- Every peer connection now negotiates a video m-line even in an all-audio room (Phase 5). One unused m-line and a muted remote track per peer; ~zero bandwidth. That is the price of never renegotiating, and it is the right trade given `handleSignal`'s catch (`rtc-mesh.ts:104-106`) would swallow glare errors.
- Tearing the session down in `RunEvent::Exit` makes quit await a network close (up to ~3 s on bad connectivity). Bound it or quit visibly hangs.

**Scope**
- `npm run test:e2e` mocks IPC at `__TAURI_INTERNALS__` (`e2e/tauri-mock.ts`) and **cannot drive a real iroh session**. Cover the pure pieces in vitest instead: `mergeReviewDoc`'s sourceKey guard (`src/lib/review.test.ts`), `decideChase`'s cooldown and clock offset and the `isPresenter` derivation (`src/hooks/use-co-review.test.ts`), `can_drive`/`member_num` and the reclaim invariant (`session.rs` `member_id_tests`), and the mesh deadline + camera-off regression (`src/lib/rtc-mesh.test.ts`). Everything else is the two-machine manual pass.
- `handleClear` calls the raw `setQueueOpen(false)` (`App.tsx:3713`) rather than `setQueueOpenChoice`; harmless in-room (the drawer is forced open at `:5388`) but collapses the drawer with no persisted choice on leaving. Use a room-aware clear.
- In-session, `upsertReviewHistory` and `linkFingerprint` never run — they sit below the `coSessionActive` early-return at `App.tsx:4663`. Pre-existing, but source-switching makes it hit far more often. Fold into the Phase-1 re-seed.
- The focus-ring contract test (`src/lib/focus-contract.test.ts`) will fail if any new popover or field uses the green accent for focus. Brighten toward `--focus-ring`; use `:focus-within` on composed wrappers.
- Task #56 ("Co-review session v2: shared source, identity, host transfer, camera reconnect") is the existing pending umbrella — land all six phases under it.