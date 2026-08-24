# Live co-review: the build review

An adversarial audit of the live screening path, both source kinds. Five
dimensions (local-file flow, web-URL flow, sync and presence, frontend
performance, backend performance) audited in parallel, every finding then
independently attacked by a verifier told to refute it: 39 findings, 35
survived, 4 were killed. Everything below carries file:line evidence in the
full result; this document is the ranked summary plus what has been done
about it.

## The verdict


Live co-review is architecturally sound but operationally brittle. The happy path - one host, one local file, one presenter, nobody disconnects - works and honors the transfer contract, and the one invariant re-audited (asset-scope glob scan stays off the playback byte-range path; allow_asset_read's single call site is probe_local_file at media.rs:1044) is intact. But nearly every transition off that path hits a verified dead end: a dying peer stream routes into yt-dlp against the 'peer://' marker and strands the guest with no recovery chip; offering a second cut leaves the host's transfer state stuck at 'hashing' and permanently kills the offer button; a full room deterministically exhausts MAX_TRANSFERS so guests lose their promised copies and a busy seek ends a watch outright; floor handover breaks the entire file-sharing tier; a drop ends the session with no rejoin despite the install-reclaim machinery existing for exactly that. Web-source sessions are strictly worse - the whole Tier A/B/C rescue ladder is gated off, and the host is structurally blind to guest failures because the 'failed' report hangs off a promise that cannot reject. Sync fidelity fails at the core review gesture: paused frame-steps fall under both chase thresholds, so rooms silently review different frames while the UI promises 'frame accurate'. One privacy-contract violation stands out: a mid-watch relay flip keeps a multi-GB Tier C copy flowing through n0's relay, against CLAUDE.md's own rule. Perf is a second-order problem with first-order fixes - presence/ghost churn re-renders the whole keep-alive App tree ~3-11x/sec for the entire session (even paused, even host-alone), and the control-plane broadcast head-of-line-blocks the whole room behind one congested peer during Tier C - both fixable with patterns this repo already established (playhead-store, and a per-peer outbox). Recommendation: a focused stabilization pass before this feature is demoed externally; the majority of the highest-harm items are small, mechanical fixes to seams that already exist.


## What is missing, ranked by harm to a real screening

| # | Finding | Cost |
|---|---------|------|
| 1 | Paused frame-stepping never reaches guests - the room silently reviews different frames | small |
| 2 | A dead Tier B peer stream falls into a yt-dlp download of the 'peer://' marker - guest dead-ends with no recovery affordance | small |
| 3 | Guest 'Get the file' completion races a presenter source switch: loads the outgoing film, reports 'ready' for the new one, and the orphaned multi-GB transfer becomes uncancellable | medium |
| 4 | session_offer_file never emits a terminal transfer event - after one source switch the host can never offer a file again for the rest of the session | small |
| 5 | MAX_TRANSFERS couples long-lived live streams with keep copies: a full room deterministically hits 'busy', the keep treats it as permanent failure, and a busy seek kills the watch | medium |
| 6 | The keep's relay refusal is sampled once at watch start - a mid-watch relay flip pulls the rest of a multi-GB copy through n0's public relay | small |
| 7 | The host is never told a web guest failed or succeeded - 'failed' is wired to a promise that cannot reject, 'ready' is never sent on the web path | small |
| 8 | Web sessions have no rescue ladder - the entire Tier A/B/C offer/transfer machinery is hard-gated on kind 'file', including the host's own cached copy | medium |
| 9 | Mid-session download fallback silently freezes or desyncs the room - no narration crosses the wire in either direction | small |
| 10 | No reconnect after a drop: teardown to Off with no auto-rejoin (despite install-id reclaim existing for it), and the leaked keepTarget fires a spurious 'Could not save a copy' into a dead session | medium |
| 11 | Floor handover breaks the whole file-sharing tier: a non-host presenter's local file has no Tier B/C path, and the UI shows the presenter an offer button that always errors | small |
| 12 | Rate-mismatch chase stutter: guests on a cached web copy default to MediaBunnyPlayer, which can't match the presenter's rate, so they get seek-corrected every ~1.5s | small |
| 13 | Guests get a live, unguarded transport that silently self-reverts; no follow/unfollow, no resync button, no request-control | medium |
| 14 | Presence ghost cursors are keyed by display name, not member id - same-name guests merge into one flickering cursor | small |
| 15 | Late joiners never see other guests' raised hands or screen-share badges - and the broadcast protocol cannot replay them | medium |
| 16 | No sighted join/leave notification - roster changes surface only in the pipeline log, the People column, and the theater strip | small |
| 17 | No quality parity or reporting for web sessions: each member silently streams a different encode at their own private height cap | small |
| 18 | The web-session contract ('each person streams this URL themselves, with their own cookies and extractor') is never stated anywhere in the UI | small |
| 19 | Offer hashing and host-side sending have no usable progress: one static 'hashing' event for a multi-GB blocking hash with no cancel, and a single transfer slot that concurrent sends overwrite | medium |
| 20 | No live pointer/telestration and no session chat - drawings cross the wire only as committed comments | medium |
| 21 | The guest's web waiting affordance clears on metadata hydration, not playback - and can render a stub 'Loading Loading……' | small |


Each row's mechanism and evidence, in harm order:

### 1. Paused frame-stepping never reaches guests - the room silently reviews different frames

Frame-stepping while paused is the core review gesture. A 24-30fps step moves 0.033-0.042s, under both the 0.25s scrub threshold and the 0.1s drift threshold, and commitHostPos on every paused heartbeat prevents deltas accumulating - so guests freeze on the previous frame while notes get made about a frame half the room is not seeing. Silent, no error, happens in essentially every session; RoomSourceBar promises 'frame accurate'.

Evidence: hostScrubbed = |Δ| > 0.25 at use-co-review.ts:618; paused branch seeks only when hostScrubbed && drift > 0.1 at use-co-review.ts:1376-1382 with commitHostPos applied at :591-592; 2 Hz sender broadcasts faithfully at use-co-review.ts:882-904; 'frame accurate' copy at RoomSourceBar.tsx:47

### 2. A dead Tier B peer stream falls into a yt-dlp download of the 'peer://' marker - guest dead-ends with no recovery affordance

Any mid-watch failure (host quits, network drop, 'busy' refusal on a seek rebuild → 502, 20s no-data watchdog) routes MEDIA_ERROR into startDownload against the peer:// marker, yielding a misleading 'Preview unavailable' toast and a terminal failed state. The Get/Watch chips cannot reappear because pendingSource was cleared; the designed reset path is dead code (the comment at App.tsx:3683-3685 describes a branch that never runs). Only recovery is the presenter reloading for the whole room.

Evidence: Reset requires resolving{fresh:true} (use-web-playback.ts:167-175) but fresh is only reachable from fromCache:true (web-playback-machine.ts:143-145) and loadPeerStream dispatches fromCache:false (use-web-playback.ts:184); failure entry points: stream_proxy.rs:1014-1021 (502), session.rs:1434-1440, MSEStreamPlayer.tsx:863-867; yt-dlp on marker at use-web-playback.ts:285-289; chips gated on pendingSource (App.tsx:4473-4536) which watchOfferedStream cleared (use-co-review.ts:1204)

### 3. Guest 'Get the file' completion races a presenter source switch: loads the outgoing film, reports 'ready' for the new one, and the orphaned multi-GB transfer becomes uncancellable

fetchOfferedFile captures the offer at click time and unconditionally loadLocalPath + 'ready' on completion with no staleness check, while the host serves the old bytes to EOF. The guest silently watches the WRONG film driven by the presenter's transport heartbeats (coReadyRef tracks readiness, not which source loaded) - the exact 'looks like it worked' failure the review contract exists to prevent - and Cancel is a no-op because cancelFetch keys off offeredFileRef, which the switch nulled.

Evidence: use-co-review.ts:1169-1184 (no post-await check), :443-445 (switch clears offer), session.rs:1163-1171 + 2056-2058 (serve-to-EOF), coReadyRef guard defeated at use-co-review.ts:422-426/595-599, dead Cancel at :1262-1265; adoptPendingSource has the same race at :1267-1282

### 4. session_offer_file never emits a terminal transfer event - after one source switch the host can never offer a file again for the rest of the session

Only a 'hashing' event is emitted; the frontend self-clears only done/sent/cancelled, and a source switch clears offeredFile but not transfer. On the flagship multi-cut screening flow (offer cut A, switch to cut B) the 'Send them the file' button is permanently hidden behind phase==='hashing', a stale 'Preparing the file…' chip shows forever alongside 'File offered to the room', and a failed hash has no retry. Tier B/C silently dies for the session.

Evidence: session.rs:2013-2015 emits 'hashing' with no terminal on return (:2050) or error (:2027-2029); self-clear whitelist use-co-review.ts:1138-1140; button gate App.tsx:4401-4403; chips App.tsx:4422-4434; transfer reset only at session end use-co-review.ts:762

### 5. MAX_TRANSFERS couples long-lived live streams with keep copies: a full room deterministically hits 'busy', the keep treats it as permanent failure, and a busy seek kills the watch

3 guests on 'Watch now (saves a copy)' = 6 substreams against a budget of 4; the refused keep maps 'busy' to terminal 'failed' with no retry edge ('Could not save a copy'), and once 4 slots are held any seek's 5th substream gets the busy header → 502 → the peer-stream dead end above ends that guest's playback. This is the flagship scenario failing deterministically, worsened by the 24 MB/s pacing holding keep slots for minutes.

Evidence: MAX_TRANSFERS=4 at session.rs:110, slot held for the watch (Guard, session.rs:1091-1118); busy error session.rs:2184-2186 → terminal at use-stream-keep.ts:135-152, 'retrying will not fix' stream-keep.ts:74-75; seek race acknowledged at session.rs:117-121; pacing session.rs:129

### 6. The keep's relay refusal is sampled once at watch start - a mid-watch relay flip pulls the rest of a multi-GB copy through n0's public relay

Direct violation of CLAUDE.md's 'a relayed session… keeps no copy at all' for someone's unreleased cut, silently: the keep chip keeps showing 'Saving a copy · N%' while gigabytes cross third-party infrastructure. The inverse also loses value: a briefly-relayed start parks the keep at 'relayed' forever even after hole-punching lands. The rung ladder already re-decides on every path flip; the keep just needs the same event.

Evidence: relayed consulted only in the 'watch' event (stream-keep.ts:152-155); onStreamInfo updates relayedRef without re-dispatch (use-stream-keep.ts:73-75); host re-reads path per request because paths flip (session.rs:1685-1702); rung ladder reacts per flip (use-stream-rung.ts:66-69); the 'not saving' badge (stream-keep.ts:254) never shows for mid-watch flips

### 7. The host is never told a web guest failed or succeeded - 'failed' is wired to a promise that cannot reject, 'ready' is never sent on the web path

handleFetch swallows every error internally and real failures happen later in the decoupled web-playback machine, so the guest reports 'loading' indefinitely; blockedMembers (the '{names} can't open this' badge and the offer-button gate) is structurally unreachable for web sources. A host screening a YouTube cut narrates to a guest staring at a solo 'Update yt-dlp & retry' overlay, with a frozen ghost cursor as the only clue.

Evidence: 'failed' only in handleFetch(m.url).catch (use-co-review.ts:457-463); errors caught internally at use-fetch-source.ts:370-408 and :161-164; machine failures never touch the session (use-web-playback.ts:235, :319); 'ready' only from the four file paths (use-co-review.ts:480, 1180, 1205, 1278); blockedMembers counts only missing/failed (App.tsx:3790-3798)

### 8. Web sessions have no rescue ladder - the entire Tier A/B/C offer/transfer machinery is hard-gated on kind 'file', including the host's own cached copy

A guest who can't fetch the URL (age-gate, cookies, extractor rot, region lock) has zero fallback while the host may hold a complete verified copy of exactly those bytes in webPlayback.cachePath; every guest also re-downloads the full video from the CDN independently. The backend needs none of the gating - offer/fetch are keyed only by path and BLAKE3.

Evidence: Host button gated isPresenter && sourceKind==='file' && localFilePath (App.tsx:4400-4401); guest chips gated pendingSource.kind==='file' (App.tsx:4501, 4524, 4536); web fingerprint ships null (App.tsx:3500); backend indifference: session.rs:1980-2054, :2082; cachePath exists at use-web-playback.ts:310 / App.tsx:4599

### 9. Mid-session download fallback silently freezes or desyncs the room - no narration crosses the wire in either direction

Host-side MSE death freezes every guest at a paused playhead with zero explanation for the minutes a yt-dlp download takes; guest-side fallback silently drops that guest out of live sync while the room plays on and the presenter narrates to someone not watching. The wire already carries a free-form detail field on sourceStatus; nothing sends it on this transition and the host UI wouldn't render it if sent.

Evidence: Host freeze path App.tsx:4745 → heartbeat broadcasts playing=false (use-co-review.ts:883-904) → guests paused (:652-654); 'Downloading a playable copy instead…' is host-local (use-web-playback.ts:382-383); guest transport discarded while player absent (use-co-review.ts:595); detail field exists at src/bindings/SessionMsg.ts:4; contrast the Tier B transfer rows (App.tsx:4421-4427 sender, 4474-4493 receiver)

### 10. No reconnect after a drop: teardown to Off with no auto-rejoin (despite install-id reclaim existing for it), and the leaked keepTarget fires a spurious 'Could not save a copy' into a dead session

Laptop sleep or a QUIC idle timeout kicks a guest out mid-take; recovery is a manual re-join while the room waits (the ticket usually survives in the lobby input, so it's one click - but nothing retries automatically). The backend explicitly supports reclaiming the same member slot, and the doc/transport layers already tolerate replay. Separately, role-off cleanup clears everything except keepTarget, so the keep's next tick fetches into the dead session and renders a false failure badge.

Evidence: fail_peer_to_off spawns at session.rs:1565/1578, body 1653-1668; install-reclaim map session.rs:879-891; role-off cleanup clears pendingSource/offeredFile/transfer but not keepTarget (use-co-review.ts:729-766; setKeepTarget only at :432, :445, :1200, :1252); failure badge Monitor.tsx:584-604; lobby ticket transient CoReviewLobby.tsx:44. Related: MAX_PEERS=3 caps the room at 4 people (session.rs:62)

### 11. Floor handover breaks the whole file-sharing tier: a non-host presenter's local file has no Tier B/C path, and the UI shows the presenter an offer button that always errors

makePresenter hands the floor to anyone, but session_offer_file rejects non-hosts and substreams only serve host-side - so a presenting guest clicks 'Send them the file' and gets 'Only the session host can offer the file', while members without a local copy sit at a permanent 'That file lives on their Mac'. Cheap mitigation: hide the button unless role==='host' with a hint; the correct fix (peer-side substream acceptor) is the large deferred v1 item.

Evidence: Host-only guard session.rs:1988-1992; serve_substreams host-only session.rs:928-933; peer OfferFile discarded session.rs:1041-1042 (documented :242-245); button rendered for any isPresenter App.tsx:4401-4411, error surfaced :4417-4421; fingerprint ladder (use-co-review.ts:474-487) only helps members who already hold a copy

### 12. Rate-mismatch chase stutter: guests on a cached web copy default to MediaBunnyPlayer, which can't match the presenter's rate, so they get seek-corrected every ~1.5s

At a presenter rate of 1.5x (routine for dailies) the guest drifts 0.5 s/s, crosses the 0.75s tolerance every ~1.5s, and each corrective mediabunny seek is a full decode-and-paint hitch - the picture lurches instead of playing. The code comments document this exact failure as why rate application was added; the capability gate reintroduces it for the one player that can't comply. Fix is small: flip cached-web to LocalMediaPlayer for the session, or chase on slope.

Evidence: Cached web defaults to mediabunny (App.tsx:695, :1474, :4599; warm boot use-fetch-source.ts:266-268); supportsPlaybackRate:false at MediaBunnyPlayer.tsx:874; rate skipped for such players use-co-review.ts:649-651 (comment :646-648); PLAYING_TOLERANCE_SEC=0.75 at :1353, CHASE_COOLDOWN_MS=1000 at :1355, chase :1369-1374; LocalMediaPlayer supports rate (LocalMediaPlayer.tsx:194)

### 13. Guests get a live, unguarded transport that silently self-reverts; no follow/unfollow, no resync button, no request-control

Every room member sees working play/pause/step controls whose effects evaporate on the next 500ms heartbeat - it reads as broken playback, not 'the presenter has the floor'. There is no sanctioned way to leave sync (beyond browsing while the presenter is paused) and no way to request the floor except the informal ✋. Every comparable tool (Frame.io watch party, Evercast, ClearView Flex) locks or badges the transport and offers follow/request-control.

Evidence: Transport rendered ungated at App.tsx:4785-4825; play-state revert use-co-review.ts:652-654 on the 2 Hz heartbeat (:902); guest seek survives only the 1.2s latch (:625) before the 0.75s chase (:1353, 1363-1383); no RequestFloor kind in SessionMsg (src/bindings/SessionMsg.ts:4-9); makePresenter host-gated use-co-review.ts:1116-1117; relay drops non-presenter transport session.rs:1002/:1013; hand-raise plumbing at session.rs:237 is the template

### 14. Presence ghost cursors are keyed by display name, not member id - same-name guests merge into one flickering cursor

The roster contract explicitly permits name collisions, yet Presence carries no member id, the receiver dedupes by name, and colors are name-derived: two 'Alex'es become one ghost teleporting between two playheads at 3 Hz, and presence - the feature meant to answer 'who is looking where' - reports fiction. The name field is also peer-chosen (unlike every other stamped message), so any peer can overwrite another's cursor. The empty-name → 'Guest' fallback makes collisions likelier still.

Evidence: Presence wire shape {name, position} session.rs:229; relay does not stamp from (session.rs:962-971); dedupe by name use-co-review.ts:583-589; colors name-derived :1022-1030; roster contract 'names… can collide' session.rs:280-282, PeoplePanel.tsx:7-8; stamping pattern to copy at session.rs:936-940

### 15. Late joiners never see other guests' raised hands or screen-share badges - and the broadcast protocol cannot replay them

The newcomer rebroadcast re-sends only the host's own hand/share, and session_broadcast structurally rewrites the sender to m0, so guest state cannot be relayed with correct attribution; hand/share state lives only in ephemeral frontend Sets. Room state silently forks by join time on the app's designated request-attention channel. (A late joiner does receive the share's video via RTC renegotiation - only the badges and hands are missing.)

Evidence: Rebroadcast effect use-co-review.ts:849-881 (host-only despite its comment); sender rewrite from:'m0' at session.rs:669-670; ephemeral Sets use-co-review.ts:278/291; badges PeoplePanel.tsx:130-131 (rendered :305-306)

### 16. No sighted join/leave notification - roster changes surface only in the pipeline log, the People column, and the theater strip

A host watching the picture has no active cue that the client just joined or that a guest dropped mid-note; a director can present to a silently emptied room. An aria-live announcer with the exact roster diff already exists (screen-reader-only), so the fix is wiring pushNotification (and optionally a chime) to a diff that is already computed and tested.

Evidence: Roster diff logged only via slog at use-co-review.ts:673-679; pushNotification never called for roster changes (session-adjacent uses only at :950/:956 and App.tsx:4452); existing SR-only announcer PeoplePanel.tsx:79-101/:108 (rosterAnnouncement :28-35, cp-visually-hidden room.css:593-599); dropped peer badges 'No connection' PeoplePanel.tsx:248-249

### 17. No quality parity or reporting for web sessions: each member silently streams a different encode at their own private height cap

Host at 1080p and a guest capped at 480p can disagree about banding or softness that exists only in one member's transport, and neither can discover why from the UI. Not a violation of the letter of the transport invariant (each encode is fixed-quality, -c copy remuxed) - but the parity/visibility the Tier B rung ladder provides (X-Rung header + badge) has no web equivalent. Cheapest fix rides the resolved height on the sourceStatus 'ready' report once that channel works.

Evidence: Per-machine previewMaxHeight (SettingsModal.tsx:172) → get_direct_stream_url (use-web-playback.ts:208-211) → yt-dlp [height<={h}] (download.rs:1330); rung reporting exists only on peer/v1 (stream_proxy.rs:1030-1048, stream-rung.ts:241-245); divergence arises on the DASH tier (>360p), identical encodes only on muxed ≤360p

### 18. The web-session contract ('each person streams this URL themselves, with their own cookies and extractor') is never stated anywhere in the UI

A host with browser cookies screens a members-only video that plays fine locally; every fresh-install guest bot-checks and dies, and the host cannot anticipate it - the lobby's only source-sharing guidance covers local files. Combined with the dead sourceStatus channel, the failure is invisible end to end. One lobby/room hint plus surfacing guest auth/rot failures through sourceStatus.detail covers it.

Evidence: Guest resolves with own cookies (use-web-playback.ts:210 → App.tsx:1450) and own yt-dlp; auth recovery and rot CTA are guest-local (use-web-playback.ts:234/:318; arming effect App.tsx:1491-1508); lobby guidance is file-only (CoReviewLobby.tsx:213-226); guest web failures report 'loading' indefinitely, never 'failed' (blockedMembers unreachable, App.tsx:4392)

### 19. Offer hashing and host-side sending have no usable progress: one static 'hashing' event for a multi-GB blocking hash with no cancel, and a single transfer slot that concurrent sends overwrite

Offering a 50-100 GB master means minutes of a frozen 'Preparing the file…' chip with no percentage and no way to back out (fetch_cancels covers only guest fetches); once guests pull, up to four concurrent send loops overwrite one 'Sending to X · N%' scalar, so the host can't tell who is actually receiving - on the machine whose CPU and uplink are being spent.

Evidence: One 'hashing' event before blocking BLAKE3 session.rs:2013-2029; no host-side cancel (fetch_cancels session.rs:1970-1974); scalar TransferProgress use-co-review.ts:356 vs per-guest 'sending' every 250ms session.rs:1220-1226; single chip App.tsx:4425-4429; 'sent' overwrite briefly shows 'File offered to the room' (App.tsx:4430-4434) over a running send

### 20. No live pointer/telestration and no session chat - drawings cross the wire only as committed comments

'This, here' with a live circle is the presenter's most natural gesture and only their own screen shows it until a comment is committed (committed drawings do auto-project to guests within ±0.6s of their time via ProximityAnnotation). Voice-off participants have only four emotes. Notably, the live-draw plumbing already exists unwired: a shared scratch-drawing CRDT relayed as {t:'draw'} over reviewOp, with App.tsx never destructuring liveDraw/postDrawOp - this is wiring a seam, not building a protocol.

Evidence: Annotations travel only inside committed ReviewComments (review.ts:~44-56, op union :478-489); 'show drawing' is App-local state (App.tsx:5049, state :3860-3861); no pointer/stroke SessionMsg kind (session.rs:156-271); unwired seam: use-co-review.ts:390-407 + src/lib/draw-ops.ts, unused at App.tsx:3729-3739; auto-fade window Monitor.tsx:183-212

### 21. The guest's web waiting affordance clears on metadata hydration, not playback - and can render a stub 'Loading Loading……'

The session-framed waiting line vanishes while the guest is still ten seconds to minutes from a first frame (and even when metadata silently failed, since handleFetch swallows errors), leaving only solo-framed chrome; a guest joining during the host's optimistic-stub window gets the literal stub title, never corrected because the guest drops corrective rebroadcasts as 'Already on that URL'. Truthfulness fix: keep pendingSource until onPlayerReady, as the file paths already do.

Evidence: pendingSource cleared in handleFetch().then (use-co-review.ts:456); resolves on metadata (use-fetch-source.ts:296-311), errors swallowed (:370-408); waiting text App.tsx:4499, stub title use-fetch-source.ts:179 via App.tsx:3499-3503; double guard against correction: deps use-co-review.ts:845-846 AND the same-URL drop at :447-450; room container requires pendingSource (App.tsx:4472)


## Performance plan

Every item names its mechanism and the measurement that proves the win -
a perf change without a proof method does not ship in this repo.

### P1. Two-line idle-churn fix: bail the ghost prune when nothing expired, and gate the presence sender on playhead change (keeping a ~5s keepalive beat) (small)

Mechanism: The 350ms interval always runs setCoGhosts(prev => prev.filter(...)) - filter allocates a fresh array even when it removes nothing, so the updater never bails and App re-renders at 2.86Hz forever, including a host alone in a room (use-co-review.ts:907-918). Fix: `const next = prev.filter(...); return next.length === prev.length ? prev : next;`. The sender half (:912) emits unconditionally; gate it on frames-changed like use-panel-bus.ts:236-244, but keep a periodic keepalive beat because the 5s staleness prune (:586, :914) would otherwise drop a paused peer's ghost everywhere.

Proof: React Profiler App commits/sec and session:msg presence deliveries/sec in a paused room, before/after: host-alone 2.86/sec → 0; 3-person paused ~8.6/sec → keepalive-only. A useRef render counter in App logged once/sec gives the same number without the Profiler.

### P2. Ghost store: move presence cursors out of App state into a playhead-store-style subscription store consumed by a Timeline leaf (medium)

Mechanism: Every presence message runs setCoGhosts in useCoReview, which lives in App (use-co-review.ts:583-590, App.tsx:3740), so each 350ms tick per peer is a full App commit reconciling all five keep-alive hidden views - including two unvirtualized TranscriptViewers (QueueDrawer.tsx:887-898, App.tsx:4248). This is the exact App-wide render the playhead store was built to eliminate (playhead-store.ts:6-16). A ghost-store.ts keyed by member id, written from the presence handler without setState; a <GhostCursors> leaf inside Timeline subscribes (the PlayheadCursor pattern, Timeline.tsx:60-107). Also deletes the coGhostMarkers memo and its two localStorage reads per tick (use-co-review.ts:1022-1030, review.ts:809-812).

Proof: React Profiler commit counter during a 2-person session with a ~2h transcript open in the drawer: presence-attributed App commits ~5.7/sec (worst case ~11.4/sec at MAX_PEERS=3) → 0; per-commit ms of the 10-30k-element reconcile disappears from the flame chart.

### P3. Multi-threaded BLAKE3 with mmap plus a (path, len, mtime) hash memo for offers and guest-resume rehashes (small)

Mechanism: session_offer_file hashes with a serial 64 KiB update_reader loop on one core (session.rs:2018-2029); Cargo.toml:71 declares blake3 = "1" without the mmap/rayon features, so update_mmap_rayon is not compiled in. No cache exists, so re-offering after a withdraw (:2031-2038) rehashes the whole file, and the guest-resume path fully rehashes the partial before the first new byte (session.rs:2141-2149). Enable the features, switch both spawn_blocking sites to update_mmap_rayon, add a small memo keyed on canonicalized path + len + mtime. This also directly shrinks the stuck-'hashing' window from the offer-lifecycle bug.

Proof: Time the hashing span (session.rs:2013 → :2031) on a 10 GB file; cross-check with `hyperfine 'b3sum f' 'b3sum --no-mmap --num-threads 1 f'` on the same Mac (b3sum defaults to mmap+rayon). Expect 3-5x cold (memory-bandwidth/SSD-bound instead of one core) and ~0 ms warm re-offers.

### P4. ReaderPlayerStage: extract the scrub-fill/clock into a self-subscribing leaf and hoist the player callbacks into useCallback (small)

Mechanism: usePlayheadSeconds at the component top (ReaderPlayerStage.tsx:81) re-renders the whole reader panel per tick to paint a fill width, aria values, and a whole-second clock; fresh handlePlayState/handleReady closures each render (:83-84) defeat the players' memo (MediaBunnyPlayer.tsx:100, LocalMediaPlayer.tsx:29) so the player re-renders per tick too - the anti-pattern playhead-store.ts:18-21 documents. A <ReaderScrubAndClock> leaf subscriber plus useCallback on the two handlers.

Proof: Profiler commit count of ReaderPlayerStage during reader playback: ~10/sec on the primary MediaBunnyPlayer path (its onTimeUpdate is a 100ms interval, MediaBunnyPlayer.tsx:741-743) or 24-60/sec on LocalMediaPlayer → ~1/sec; a render log in MediaBunnyPlayer confirms the player child stops re-rendering.

### P5. Per-peer outbox: bounded mpsc + writer task per PeerConn so control-plane broadcasts never await a slow socket under the manager mutex (medium)

Mechanism: session_broadcast awaits write_all sequentially per peer while holding both inner and peers (session.rs:660, :705-716; session_send :733-739), and relay_to_others is awaited inline in each read loop (:1470-1486). A congested-but-alive peer (exactly what a 24 MB/s Tier C transfer creates on a home uplink) keeps acking so the idle-timeout bound never fires; stalls last until the next ack burst - repeated multi-hundred-ms to multi-second at 2 Hz heartbeat cadence - while session_leave, heartbeats, and emit_state_now queue behind the mutex. Broadcast becomes N non-blocking try_sends; a full outbox marks the peer dead, which also resolves the removal race the :332-335 comment worries about. The mutex is then never held across a network await.

Proof: (a) Wrap each write_all in Instant::now() and log a per-peer latency histogram; (b) heartbeat inter-arrival jitter measured at a healthy guest while a second guest runs a Tier C fetch over a Network Link Conditioner 10 Mbit uplink. Expect worst-case broadcast latency to drop from multi-hundred-ms/seconds to <5 ms and healthy-guest jitter to return to ~500 ms ±20 ms.

### P6. Screen-share encode on h264_videotoolbox instead of libx264 (small)

Mechanism: share_encode_args pins libx264 -preset ultrafast -tune zerolatency for the 1600-wide 30fps share (stream_proxy.rs:1887-1891) while the Tier B rung ladder deliberately chose hardware (rung.rs:120-123). Swap to h264_videotoolbox -realtime 1 with the same maxrate/GOP/frag settings, libx264 as fallback if the VT session fails. Runs for the duration of an active share (one at a time, stream_proxy.rs:1924-1925) alongside the WebRTC mesh encode and possible Whisper jobs. Encoder CPU drops ~an order of magnitude; end-to-end savings less, since swscale BGRA→yuv420p and pipe I/O stay on CPU.

Proof: powermetrics --samplers tasks (or Activity Monitor) CPU% of the share ffmpeg during a 5-minute 1600×1000 display share, A/B at identical bitrate; plus glass-to-glass latency via an on-screen timer - VT adds a few frames of internal encoder delay that x264 zerolatency does not, so latency parity is the gate before shipping.

### P7. ReviewComposer: coarse (whole-second) playhead subscription except while a range edge is armed (small)

Mechanism: The composer subscribes at frame granularity (ReviewPanel.tsx:1439-1444) but renders second-granularity text - a placeholder and h:mm:ss (:1594-1598, unused once anchorSec latches) - so the ~40-element subtree that owns the text input re-renders at source fps (24/sec for 24fps material; the store no-ops on unchanged integer frames, playhead-store.ts:71-72) while the user types. Add usePlayheadSecondsCoarse returning Math.floor(seconds) so useSyncExternalStore bails on nearly every tick; keep the precise variant only while a range-edge pill is following (:1496-1518).

Proof: Profiler ReviewComposer commit count during playback: source-fps → ~1/sec (~24-60x); the existing component tests assert the placeholder and range pill still update.

### P8. Timeline memoization package: React.memo(Timeline) + memoized queuedRanges + stable onRangeClick (rides on the ghost store) (small)

Mechanism: Timeline is unmemoized (Timeline.tsx:195) and receives a fresh ghosts array per presence/prune tick (App.tsx:4855 ← use-co-review.ts:1022-1030), so the filmstrip's ~24 <img> cells (:383-391), hundreds of diarization segments (:397-411), and two commentMarkers maps (:496-528) reconcile ~3-11x/sec to move a 1px ghost line. After ghosts move to the store, wrap Timeline in memo - which also requires useMemo on the inline queuedRangesForSource(...).map(...) (App.tsx:4835-4844) and a stabilized onRangeClick closure (App.tsx:4845-4848), both of which would otherwise defeat it.

Proof: Profiler ranked chart filtered to Timeline during a 2-person session: commits tied to presence rate → prop-change-only (~0/sec while watching).

### P9. Reactions and raised hands into a small external store subscribed by ReactionLayer and the PeoplePanel badges (small)

Mechanism: Each emote calls setLiveReactions twice (append + 5.2s timeout removal, use-co-review.ts:565-570, :921-929) with the state owned by App (App.tsx:3740), so a 12-emote applause burst is ~24 full App-tree renders on every machine, stacked on presence churn, exactly when video is playing. The feed is already fire-and-forget and self-pruning - the playhead-store pattern fits directly; consumers are only ReactionLayer (App.tsx:4784) and the reactionFlashes memo (App.tsx:3801-3805).

Proof: Profiler during a scripted 10-reaction burst: ~20 full-App commits + presence baseline → 0 full-tree commits, with commit attribution confined to the two leaf subscribers.

### P10. CaptionOverlay: subscribe to the derived cue index and memoize line-split/speaker resolution per active cue (small)

Mechanism: The overlay subscribes to raw seconds (CaptionOverlay.tsx:141) so splitCaptionLines (:69-110 - split(/\s+/), scoring loop, two regexes per word) and resolveSpeakerName/Color (:264-274) recompute byte-identical output per tick for the seconds each cue is on screen. TranscriptViewer documents the fix (subscribe to the derived index, TranscriptViewer.tsx:439-445): subscribe to cueIndexAt(...) and useMemo {lines, speakerName, hue} keyed on [activeIdx, taggedCues, overrides, style]. Note: captions default OFF (App.tsx:1073, loadJson('cp-captions-on', false)) and per-tick cost is small in absolute terms - this ranks below the always-on paths.

Proof: Profiler commit rate (tick-rate → ~1 per cue) and Safari Timeline/Allocations sampling over 60s of playback with captions on: steady-state allocations from the split path go to ~0.

### P11. Replace tiny_http's 8 KiB copy loop on the media routes with a hand-rolled ≥256 KiB response writer (medium)

Mechanism: All three body paths (range proxy stream_proxy.rs:535-548, fMP4 remux :917-923, peer file :1148-1155) stream via tiny_http's io::copy into a 1 KiB BufWriter (tiny_http response.rs:437/445, client.rs:63); the writer is also type-erased to Box<dyn Write> (request.rs:55), so io::copy's large-buffer specialization can never apply - every played byte moves in ≤8 KiB read/write syscall pairs (~12,800 syscalls/s at a 50 MB/s fill burst). A hand-rolled 256 KiB loop on the media routes (or a vendored patch) fixes both the buffer size and the erasure. Correctness unaffected.

Proof: `sudo dtruss -c` (or Instruments System Trace) counting read/write syscalls of the sb-media-proxy thread during 60s of 4K local playback plus a scrub burst, and the thread's CPU%: expect ~8-32x fewer syscalls/MB and burst CPU from several percent to <1%.

### P12. Tier B pump: send Bytes through the bridge channel instead of Vec<u8> copies (small)

Mechanism: peer_media_service reads into a reused buffer then heap-allocs buf[..n].to_vec() per 64 KiB chunk (session.rs:1801-1814), and ChannelReader memcpys again into ≤8 KiB slices (peer_stream.rs:129-131) - three userspace copies per live-stream byte. iroh RecvStream::read_chunk yields Bytes zero-copy from quinn's reassembly buffer; let the channel and ChannelReader hold Bytes. No protocol change. Worth taking only because the change is tiny.

Proof: cargo instruments (Allocations template) on the guest during a 100 Mbit passthrough stream: pump-attributed allocations/s → ~0, with a small (<1% core) CPU saving on the pump task.
