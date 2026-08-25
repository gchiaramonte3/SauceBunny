# Outstanding work

Four parallel verification passes over the live-review audit, the project's
own documents, and the code, then a synthesis. Every item carries a file:line
anchor; items verified as already DONE were dropped rather than listed.

Spot-checked by hand before filing. The top item is real: `session_offer_file`
emits only `phase: "hashing"` and never a terminal phase
(`src-tauri/src/commands/session.rs`), while the offer button is gated on
`transfer?.phase !== "hashing"` (`src/App.tsx`) - so after one offer the host
can never offer a file again for the rest of the session.

Generated against f6fbde7. Re-verify before acting on anything here.

---

# Sauce Bunny — Outstanding Work (branch `ui-polish-v3` @ f6fbde7)

## State of the repo

**Solo playback, transcription, library, and review all pass every gate — `tsc --noEmit`, 2615 tests in 245 files, `cargo check` all clean at f6fbde7.** As a single-user local app it is shippable today. **The single biggest risk is live co-review: it is shipped but not durable.** A session that involves a local-file offer, a web source, or any peer drop has multiple unrecovered dead ends — the host's offer button can wedge for the rest of the session (no terminal transfer event), a dead peer stream falls through to yt-dlp trying to download a `peer://` marker, and there is no reconnect after a drop at all. A second, quieter risk: speaker renames, in/out marks and the export queue — real user work product — still live only in evictable `localStorage`. Version is 0.4.5 but CHANGELOG stops at 0.4.3, so two releases shipped with no notes.

---

## (a) Breaks a real session

| # | Item | Why it matters | Evidence | Effort |
|---|---|---|---|---|
| 1 | **`session_offer_file` emits no terminal transfer event** — only `phase: "hashing"`, never done/sent/cancelled | Host's "Send them the file" button is gated on `transfer?.phase !== "hashing"`, so it stays disabled and the chip reads "Preparing the file…" for the rest of the session. Sharing a local file is dead after one offer. | `src-tauri/src/commands/session.rs:2063-2065` emits hashing; returns at `:2096` with no emit. Frontend self-clear whitelist is done/sent/cancelled only: `src/hooks/use-co-review.ts:1127`. Button gate `src/App.tsx:4405`. | small |
| 2 | **Dead Tier B peer stream falls into a yt-dlp download of the `peer://` marker** | When the peer stream 502s or the host is busy, the state machine hands `peer://<hash>` to `download_web_preview`. Guest sees a nonsense download failure, not a retry. | `src/lib/web-playback-machine.ts:143-145` routes MEDIA_ERROR to `startDownload(state.seq, state.url,…)`; marker minted at `src/App.tsx:3700`; consumed at `src/hooks/use-web-playback.ts:285`. Live failure sources: `stream_proxy.rs:1017-1020`, `session.rs:2226`. | small |
| 3 | **No reconnect after a drop, plus a leaked `keepTarget` firing into a dead session** | Any network blip ends the session permanently — `fail_peer_to_off` replaces the session with `Off` and nothing retries; the lobby ticket is transient component state so the guest cannot even rejoin by hand. | `src-tauri/src/commands/session.rs:1653-1666`; `grep -rn 'rejoin\|reconnect' src/` finds only comments; ticket at `src/components/CoReviewLobby.tsx:45`; role-off cleanup `use-co-review.ts:748-752` never clears `keepTarget`. | medium |
| 4 | **Web sessions have no Tier A/B/C rescue ladder** | If a guest's own yt-dlp extraction fails (cookies, geo, extractor drift), there is no fallback — the host has a verified local copy at `webPlayback.cachePath` and cannot offer it. The backend already supports this; only the UI gates block it. | Host offer gated `sourceKind === "file"` at `src/App.tsx:4403`; all three guest chips gated `pendingSource.kind === "file"` at `:4504/:4527/:4539`; web source ships `fingerprint: null` at `:3503`. Backend keys only on path + BLAKE3 (`session.rs:2030-2098`). | medium |
| 5 | **Guest "Get the file" completion races a presenter source switch** | Guest ends up loading and announcing "ready" on a file the presenter already moved off; the cancel path has become a no-op by then. | `src/hooks/use-co-review.ts:1158-1173` — no re-check after the await; switch handler clears the offer at `:434-435`; `cancelFetch` at `:1251-1254` finds nothing. Same shape in `adoptPendingSource` `:1256-1271`. | medium |
| 6 | **`MAX_TRANSFERS = 4` couples live streams with keep copies; "busy" is treated as permanent** | A held-open live stream consumes a transfer slot for its whole life, so the 5th person's Tier C copy fails with "Could not save a copy" and there is no retry edge in the state machine. | `src-tauri/src/commands/session.rs:110`, guard `:1094-1104`, Guard held for stream life `:1108-1115`. `failed` is terminal: `src/lib/stream-keep.ts:187-190`, no retry in KeepEvent union `:110-132`. | medium |
| 7 | **Speaker renames, in/out marks and the export queue are work product in evictable `localStorage`** | These are hours of user labour with no file-backed copy. WKWebView storage eviction or a profile reset loses them silently. Everything else of this weight moved to `~/Documents` already. | `src/lib/source-marks.ts:24`, `src/lib/storage.ts:41`, `src/components/transcript/helpers.tsx:411`, `src/lib/speaker-identity.ts:27`. Nothing writes any of these to Documents. | large |

---

## (b) User-visible gaps

| # | Item | Why it matters | Evidence | Effort |
|---|---|---|---|---|
| 8 | **Host is never told a web guest failed** — the failure `.catch` is unreachable | The host presents to someone staring at a spinner. `blockedMembers` never counts them. | `src/hooks/use-fetch-source.ts:370-408` swallows every error and returns normally, so the `state:"failed"` send at `use-co-review.ts:450-453` cannot fire. No "ready" on the web path either (all four sends are file paths). | small |
| 9 | **Every `sourceStatus` ships `detail: null`** — mid-session fallbacks narrate nothing across the wire | The wire field exists and no UI reads it; "switching to a download" stays a host-local log line. Cheap fix with a wide payoff (also unblocks #11 reporting). | 11 send sites: `use-co-review.ts:443,452,466,470,474,480,1169,1194,1198,1267,1269`. Field at `src/bindings/SessionMsg.ts:4`. Host-local narration at `use-web-playback.ts:382-384`. | small |
| 10 | **Guests get a live, unguarded transport with no follow/unfollow, resync, or request-control** | A guest touching play/pause silently fights the 2 Hz heartbeat which reverts them — feels broken rather than governed. No way to ask for the floor. | `<Transport>` rendered ungated at `src/App.tsx:4788`; revert at `use-co-review.ts:641-643`; no `RequestFloor` kind in `src/bindings/SessionMsg.ts:4`. | medium |
| 11 | **No quality parity or reporting for web sessions** — each member streams at their own private height cap | Two people reviewing "the same" shot are looking at different encodes at 480 vs 1080, and nobody is told. Directly against the CLAUDE.md co-review contract. | Cap at `src/components/SettingsModal.tsx:174`, default 480 at `src/App.tsx:264`, into yt-dlp at `download.rs:1330`. Rung reporting exists only on the peer route (`stream_proxy.rs:1043`). | medium |
| 12 | **Floor handover breaks the file tier** — only the host can `session_offer_file` | `makePresenter` gives the floor to any member and the offer button renders for any presenter, then errors. Presenter ≠ host is a real, reachable state. | `session.rs:2040-2042` rejects non-host; peer read loop discards `OfferFile` (`session.rs:1041-1042`); button gate `src/App.tsx:4403`, error surfaced `:4419-4423`. | small |
| 13 | **Presence ghost cursors keyed by display name, not member id** | Two guests named "Gasper" merge into one flickering cursor. Wire shape change needed — `Presence` is the one relayed kind the host does not stamp `from` onto. | `session.rs:229` (`Presence { name, position }`), unstamped at `:966-971` while ReviewOp/Sharing/Reaction/Rtc are stamped at `:962-983`. Receive side dedupes by name: `src/lib/ghost-store.ts:42-46`. | medium |
| 14 | **Offer hashing/sending has no usable progress, no cancel, one transfer slot that concurrent sends overwrite** | Host cannot tell who is receiving or stop a wrong send; backend already emits per-member `sending` that the single frontend scalar throws away. | Fire-once event `session.rs:2063-2065` (`received` hardcoded 0); per-member emit at `:1223`; single scalar `use-co-review.ts:346` overwritten at `:1125`; UI `src/App.tsx:4424-4431`. | medium |
| 15 | **Late joiners never see other guests' raised hands or screen-share badges** | The rebroadcast effect is host-gated and sends only the host's own state; `session_broadcast` structurally rewrites the sender to `m0`, so the protocol cannot replay them. | `use-co-review.ts:841`, `:863-869` (comment claims "every currently-raised hand", code sends self only); rewrite at `session.rs:669-670`. | medium |
| 16 | **The web-session contract is never stated in the UI** | "Each person streams this URL themselves, with their own cookies and extractor" explains most confusing failures. Current tooltip says the opposite. | Only lobby guidance is local-file-gated: `src/components/CoReviewLobby.tsx:224`. `RoomSourceBar.tsx:37` title reads "Everyone plays the same file, in sync." | small |
| 17 | **Rate-mismatch chase stutter** — guests on a cached web copy default to MediaBunnyPlayer, which can't match presenter rate | Non-1× playback for a guest becomes a periodic seek-jerk instead of a rate match. | Default at `src/App.tsx:694` / reset at `:1469`; `MediaBunnyPlayer.tsx:874` `supportsPlaybackRate: false`; gate at `use-co-review.ts:638`. | small |
| 18 | **Blob-Worker CSP gate: startup decoder registration runs on the optimistic sync probe** | If the real probe disagrees, local decoding is registered wrong and cannot be rescued from there. Known and documented, not fixed. | `src/main.tsx:45`; the comment at `src/lib/platform-capabilities.ts:158` says so explicitly. | medium |
| 19 | **CHANGELOG is two releases and 31 commits stale** | 0.4.4 and 0.4.5 shipped with no notes; `version-stamp-contract.test.ts` checks the three manifests but never CHANGELOG, so nothing catches it. | Newest entry `## [0.4.3]` at `CHANGELOG.md:8`; `package.json:4` = 0.4.5; `git log --oneline e55e5f6..HEAD \| wc -l` = 31. | medium |
| 20 | **Command-palette secondary text below WCAG AA** | Allowlisted, not fixed — needs a token decision (`fg-5` = 3.81:1, `fg-4` = 4.45:1, neither passes on that surface). | `e2e/contrast.spec.ts:174-178`. | medium |
| 21 | **Session recording (RECORDING-PLAN.md) entirely unimplemented** | Planned feature, zero code. Listed so it is not mistaken for partly-built. | `docs/RECORDING-PLAN.md:16`; no Sessions store, no record command in `src-tauri/src/commands/`. Blocked on Spikes A/B/C (`:359`). | large |
| 22 | **No live pointer/telestration, no session chat; the live-draw seam is wired to nothing** | `liveDraw`/`postDrawOp` exist in the hook and are consumed by zero components. | `grep -rn 'liveDraw\|postDrawOp' src/` → only `use-co-review.ts:179,181,390,394,1285`. Not in App's destructure (`src/App.tsx:3731-3743`). | large |

---

## (c) Papercuts

| # | Item | Why it matters | Evidence | Effort |
|---|---|---|---|---|
| 23 | **Guest's web waiting affordance clears on metadata hydration, not playback** — can render "Loading Loading……" | Guest sees a stub title and thinks it's ready before it is. | Cleared at `use-co-review.ts:446`; stub title `use-fetch-source.ts:179`; interpolated `src/App.tsx:4502`. | small |
| 24 | **No sighted join/leave notification** | Roster changes only hit the pipeline log; a screen-reader-only announcer exists unpaired with a visual one. | Log-only at `use-co-review.ts:662,664,668`; no `pushNotification` roster call site; `PeoplePanel.tsx:110` SR-only region. | small |
| 25 | **Batch-forget shipped with a count confirm, not the summed-size confirm its own decision doc required** | The precondition was dropped rather than met — the confirm never shows a byte total. | `docs/DECISIONS.md` (web collections); shipped at `src/components/CachedWebPane.tsx:283-289,318`. | small |
| 26 | **Transcript folders are one-level-only, and the 3-deep scan labels by immediate parent** | A nested folder's title/poster/colour is dropped on every boot, and two same-named folders under different months merge. | `library.rs:462` (`valid_stem` rejects separators, `:384`), root-only listing `:488`, label bug `:328`; consequence at `src/lib/transcript-projects.ts:96-104`. Already defended against at `TranscriptReader.tsx:220-231`. | medium |
| 27 | **Library scan depth pinned at 3** | Deliberate, documented, still a real limit for deep folder trees. | `src/lib/library.ts:26` → `use-library-scan.ts:571` → `library.rs:208`. | small |
| 28 | **`HAND-TEST.md` last touched 2026-08-17; nothing from 22–24 Aug covered** | Library folders, frames folders, web collections, drag-to-file, shelf selection, queue reorder all shipped with e2e specs but no manual-path coverage. | `git log -1 -- docs/HAND-TEST.md` → 3b9a957 2026-08-17. | medium |
| 29 | **Nothing enforces which `localStorage` keys are shared across the two windows** (DATA-MODEL F4) | 54 contract tests, none covers cross-window key ownership; coordination is one CustomEvent by convention. | `src/lib/storage-keys-contract.test.ts` asserts namespace only; `TranscriptViewer.tsx:249` writes a key rendered in both windows. | medium |
| 30 | **DATA-MODEL §3.4 still reads "RED. This is finding F1 / No parser reads it"** while its own table marks F1 fixed; also says "four file stores", now five | Doc actively misleads about a fixed item. | `docs/DATA-MODEL.md:196,198` vs `:273`; `store-version-contract.test.ts` asserts five stores. | small |
| 31 | **Review-index half of DATA-MODEL F3 undefined** — a dangling index entry is kept and warned about, never reconciled | (The `posterPath` half of F3 is obsolete — see #37.) | `src/lib/review-store.ts:456`, `:495`. | small |

---

## (d) Internal debt

| # | Item | Why it matters | Evidence | Effort |
|---|---|---|---|---|
| 32 | **P5: per-peer outbox missing** — `session_broadcast` awaits `write_all` sequentially while holding the peers lock | One slow socket stalls the whole control plane for everyone. This is the only perf item with genuine user-visible consequences. | `session.rs:705-716`; same shape `relay_to_others:1473-1482`, `relay_to_member:1494-1499`. mpsc exists only on the media bridge. | medium |
| 33 | **P6: screen-share encode still on `libx264`, not `h264_videotoolbox`** | Software encode for a realtime path on hardware that has an encoder. One-line change. | `stream_proxy.rs:1887-1890`; used by both share paths `:2063`, `:2087`. | small |
| 34 | **`updater-purity-contract` regex is blind to compound assignment** — and `use-grid-selection` reproduces the exact impurity the contract polices | The extracted hook writes `dragBaseRef.current ??= …` inside a `setSel` updater and the contract cannot see it; tests pass 2615/2615. Its own comment at `:51-52` contradicts the code seven lines below. | `src/lib/updater-purity-contract.test.ts:60` `/Ref\.current\s*=[^=]/` — matches `=`, not `??=`/`\|\|=`/`+=`. Offending write `src/hooks/use-grid-selection.ts:59`. | small |
| 35 | **P4: `ReaderPlayerStage` clock at component top; player callbacks not `useCallback`'d** | Fresh closures each render defeat both players' `memo`. | `ReaderPlayerStage.tsx:81`, `:83-84`, handed down `:119-120`; memo at `MediaBunnyPlayer.tsx:100`, `LocalMediaPlayer.tsx:29`. | small |
| 36 | **`TranscriptProject.posterPath` is dead code** — declared, initialised, parsed, read by nothing | CLAUDE.md's "no dead code" rule. The live path is `posterFrom`. | `src/lib/transcript-projects.ts:36,44,79`; no read anywhere in `src/`. | small |
| 37 | **`use-grid-selection` has 2 consumers, not the 3 its own docblock claims** — LibraryBrowser still owns a duplicate | Either migrate LibraryBrowser or correct the docblock; right now the hook asserts a bar it does not meet. | Hook `:19`; consumers `FramesPane.tsx:187`, `CachedWebPane.tsx:236`; duplicate at `LibraryBrowser.tsx:118,120,481-491`. Resisted migration because it doesn't own its marquee (`LibraryBrowserPane.tsx:138`). | medium |
| 38 | **Doc drift in ARCHITECTURE.md** (four separate lies) | Says co-review is "Web-source only… a local file can't reach guests" (`:329`) — the file tier shipped. Roadmap says "First public release — tagged v0.1.0" and "Linux / Windows builds" (`:475-476`) against CLAUDE.md's Apple-Silicon-only rule. `frames` missing from the commands list (`:34`). DATA-MODEL/LIVE-REVIEW-AUDIT/RECORDING-PLAN missing from the docs inventory (`:53`). No coverage of Casts, Screenings, Web collections or Frames at all. | as cited | small→medium |
| 39 | **CLAUDE.md priority 6 contradicts itself** | Lists `use-keyboard-shortcuts` and `use-clip-export`/`use-clip-queue` under "Done so far" at `:589-593`, then names both as "plausible next candidates" at `:598-599`. Also: App.tsx is **5,247** lines (repo CLAUDE.md says ~5,100; the Desktop copy's "~6,400" is stale). Only transcript-history is genuinely still inline (`src/App.tsx:2618–2921`, ~318 lines). | as cited | small |
| 40 | **20 non-test components over 400 lines against a 150-line rule** | Triage note: `TranscriptViewer.tsx` is one 2,168-line function (`:227`→EOF) and `SettingsModal` ~1,500 — these two are the real debt. `ReviewPanel` (17 components) and `Icons.tsx` (72 glyphs) are false positives. | `wc -l src/components/*.tsx` | large |
| 41 | **P8: Timeline unmemoized, `queuedRanges` a fresh inline array, `onRangeClick` a fresh closure** | Its prerequisite (P2) landed and removed the churn P8 targeted, so remaining value is small. Do it only when touching Timeline anyway. | `Timeline.tsx:220` no memo; `src/App.tsx:4852-4859`, `:4862-4865`. | small |
| 42 | **P11: tiny_http's 8 KiB copy loop still on all three media body paths** | Bounded ceiling on local stream throughput. | `stream_proxy.rs:535-549`, `:917-924`; `Cargo.toml:90` unpatched `tiny_http = "0.12"`. | medium |
| 43 | **Two `#[cfg(not(target_os = "macos"))]` stubs, never compiled or type-checked** | DECISIONS.md records the question, no answer. | `src-tauri/src/commands/system.rs:906`, `:965`. | small |
| 44 | **`_design/` gates that were bypassed** | `prompts-live-presence.md:279-282` has four empty spike verdicts guarding prompts 1–3, but commit points 1 and 2 shipped (`GreenRoomDevices.tsx`, `use-rtc-mesh.ts`). Either run the spikes or retire the gate. | as cited | medium |

---

## Where the passes disagreed

- **Perf plan P3 (parallel BLAKE3):** pass 2 marks it done, pass 3 marks the whole perf block "partly-done." **Believe pass 2 — it is done for the offer path** (`Cargo.toml:74` mmap+rayon, `session.rs:1998-2026` memo, 8.4× measured in df860f0), **with one residual pass 2 correctly flagged**: the guest-resume rehash at `session.rs:2178` is still a serial `blake3::Hasher::new()`. The original item named both sites; only one landed.
- **P10 (CaptionOverlay):** done — but the second half (`useMemo` over `splitCaptionLines`/`resolveSpeakerName`) was never added (`CaptionOverlay.tsx:273-288` still inline). Immaterial: the component now commits ~1× per cue, so those run once per cue regardless.
- **App.tsx line count:** pass 4 is right at **5,247**. The "~6,400" figure everyone is quoting is from the stale Desktop copy of CLAUDE.md.
- **Popover dismissers:** HAND-TEST says 19 hand-rolled; the ratchet holds **15** (`dismiss-parity-contract.test.ts`), 7 migrated. The migration is real; the doc's number is stale.
- **QueueDrawer's two pointer-drag implementations:** flagged as debt in an earlier pass. **Do not extract.** Two sites in one component, materially different (axis, commit model, affordance) — under CLAUDE.md's 3+ bar, and they already share `lib/reorder.ts`.
- **P8 (Timeline memoization):** technically open, but its justification evaporated when P2/P9 removed the presence-rate App commits. Demoted accordingly.

---

## Decisions only the owner can make

1. **Guest recording** — RECORDING-PLAN is blocked on three unrun half-day spikes (`RECORDING-PLAN.md:359`), but the prior question is product: does a guest get to record a session at all, and is the host asked? Everything downstream waits on that.
2. **Work-product durability (item 7)** — do speaker renames, marks and the queue move to `~/Documents` (file-backed, matching Reviews/Casts), or does the app formally say they are ephemeral? Large either way; the current silence is the worst option.
3. **Floor vs. host (item 12)** — is "presenter" allowed to offer files, or is file-offering permanently a host power and the button should be gated to host? One is a protocol change, the other is a one-line gate.
4. **Guest transport (item 10)** — is a guest a passenger (disable the transport, add an explicit "request control"), or a co-driver (allow local scrubbing with a visible "you have left the presenter's playhead / resync" state)? Every design in that area depends on this.
5. **Quality parity (item 11)** — should the host's `previewMaxHeight` bind everyone in a session, or should each member's cap stand and be reported? The CLAUDE.md contract implies the former.
6. **Command-palette contrast (item 20)** — `fg-5` is 3.81:1 and `fg-4` is 4.45:1 on that surface; neither passes. This needs a new token or a surface change, i.e. a design call.
7. **`_design/` spike gates (item 44)** — the gate guarding prompts 1–3 was bypassed and the features shipped. Retire the gate or retro-run the spikes.

---

## What I would do next, in order

1. **Fix the offer-transfer terminal event (item 1).** Small, breaks-a-session, and it is currently the single cheapest way to stop a shipped feature from wedging. Emit `sent`/`failed`/`cancelled` from `session_offer_file`'s success and error paths.
2. **Fix the `peer://` download fallback (item 2).** Also small. Route MEDIA_ERROR on a peer marker to a peer-specific reset instead of `startDownload`.
3. **Land the wire-truth trio in one pass (items 8, 9, 16).** Make `use-fetch-source` rethrow so the host learns about failures, start populating `detail` on `sourceStatus`, and put the web-session contract in the lobby copy plus fix the lying tooltip at `RoomSourceBar.tsx:37`. Three small changes that together turn most silent co-review failures into legible ones — and #9 is the prerequisite for #11's reporting.
4. **Ship reconnect (item 3).** Persist the ticket, keep the install-id reclaim path that already exists at `session.rs:875-891`, retry on `fail_peer_to_off`, and clear `keepTarget` in the role-off block. This is the largest single upgrade to "does a real session survive real conditions".
5. **Write 0.4.4 and 0.4.5 into the CHANGELOG and add it to `version-stamp-contract.test.ts` (item 19), then do the ARCHITECTURE.md + CLAUDE.md corrections (items 38, 39) in the same commit.** An hour of work; the docs are currently telling contributors that the file tier does not exist and that two already-extracted hooks are the next thing to extract.
6. **Then P5 (item 32) and the `??=` regex hole (item 34).** P5 is the only perf item left with real user consequences; the regex fix is a one-liner that closes a hole in a contract you already decided to enforce.

Deliberately not in the top six: item 7 (durability) — it is the second-biggest risk but it is blocked on decision 2, not on engineering. Make that call and it moves to number one.
