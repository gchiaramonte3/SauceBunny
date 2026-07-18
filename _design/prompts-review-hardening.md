# Review-hardening pack — fixes from the 2026-07-18 code review

Scope: the `library-home-v2..ui-polish-v3` review (8 finder angles, 1-vote
adversarial verify). 10 confirmed correctness findings + a cleanup pool.
Four prompts, run in order; each ends with the full gate
(`npx tsc --noEmit && npm test && npm run test:e2e`, plus
`cargo check && cargo test --lib` when Rust changes). COMMIT ONLY IF GREEN.

Standing context: all suites are currently green — every one of these bugs
lives below test coverage, so each fix should land with a test that would
have caught it.

---

## Prompt 1 — Seek/clock correctness: one timeline mode, no stale targets

The RC7 epoch design is right; its state handling has four confirmed holes.

1. **Mode-flip clock race** (`MSEStreamPlayer.tsx` ~265): baseTime is
   committed at debounce time using the PREVIOUS pipeline's `timelineAbsRef`,
   but the proxy decides absolute-vs-rebased PER REQUEST (probe failure →
   rebased). Fix at the root: make the timeline mode per-PIPELINE state
   resolved before any clock commitment — defer the `baseTimeRef` write (and
   sourceopen's `ms.duration` sizing) until the fetch response's headers are
   read, or carry mode+epoch into the rebuild explicitly. Every consumer of
   baseTime/clockOrigin must observe ONE consistent (mode, base, epoch)
   tuple per pipeline. Add a unit-style test if extractable, else an e2e
   with a mocked header flip.
2. **Stale landing target** (~248): the in-buffer seek fast path must clear
   `pendingLandRef` (and any rebuild bookkeeping a newer seek supersedes).
   Confirmed yank: T1 out-of-buffer rebuild, T2 click lands in the fresh
   buffer, later append crosses T1 → currentTime snapped to T1.
3. **EOF landing stall** (~597/681): when the stream ends (`done` →
   `endOfStream`) with `pendingLandRef` still armed, consume it: land at
   `min(land, buffered.end(last) - ε)` so the element is never left parked
   at currentTime=0 outside the buffered range (frozen player, no error).
4. **Go-to-end snap** (`src/lib/commands.ts` ~181, `App.tsx` ~3960
   `play.toEnd`): both derive `Math.max(0, durationFrames - 1)` inline —
   with duration unknown (0) that seeks to frame 0, the RC1 backward-snap
   class. Add `endSeekFrames(durationFrames): number | null` to
   `src/lib/playhead-clock.ts` (null = no-op when duration unknown), route
   both sites through it, test it beside clampSeekFrames' tests.
5. **Probe hardening** (`stream_proxy.rs` serve_fmp4): the epoch probe is
   on the critical path of every out-of-buffer seek with no wall-clock
   bound, no memoization, and no frontend watchdog on seek rebuilds.
   (a) Wrap probe_stream_epoch in an overall timeout (spawn + poll or a
   watcher thread that kills ffprobe after ~4s; `-rw_timeout` only bounds
   individual reads); on timeout → rebased fallback exactly like failure.
   (b) Memoize epoch per (upstream, start) in a small Mutex<HashMap> so
   scrub-backs are free. (c) `eprintln!` a loud `[media-proxy] epoch probe
   failed → rebased` line on every fallback so degradation is visible.
   (d) Re-arm the frontend stall watchdog on seek rebuilds, not just the
   initial open (`use-web-playback.ts` ~209: `streamingReady` latches once).
   Note the probe overlap comment must be corrected: headers ARE serialized
   behind the probe; say so honestly and bound it instead.

Commit: `player: per-pipeline timeline mode + landing-target hygiene`
(split into two commits if Rust + TS halves are cleaner apart).

## Prompt 2 — Position handoff: never lose the playhead

1. **Warm-boot retry loses position** (`web-playback-machine.ts` ~123,
   ~128-137): the `streaming(fromCache)` MEDIA_ERROR/WATCHDOG edge drops
   `atSeconds` (resolving has no field for it) and RESOLVE_FAILED hardcodes
   `startDownload(seq, url, 0)`. Give `resolving` a required
   `resumeAtSeconds`, thread `atSeconds` through the fresh-retry edge, use
   it in RESOLVE_FAILED's startDownload, and on a successful fresh RESOLVED
   pass it to the streaming state so the remounted MSE pipeline builds from
   that second instead of 0 (MSEStreamPlayer needs an initial-start prop or
   an onReady seek — pick the seam that keeps the machine the source of
   truth). Extend the machine unit tests for both edges.
2. **Resume re-fire on remount** (`App.tsx` ~1503-1518): the cached-resume
   seek has no one-shot latch and `resumeAtSeconds` never clears, so any
   player remount (reachable via error→loaded status cycles) teleports the
   user back to the stream-death position. Latch it: consume the resume
   (dispatch a machine action that zeroes `resumeAtSeconds`, or a ref keyed
   on cachePath) after the first ready-seek.
3. **Filename dirty flag goes per-source** (`App.tsx` ~1563): replace the
   session-sticky boolean with source identity — store the source key (URL
   or local path) the edit happened under; hydrate keeps the custom name
   only when the incoming source matches, otherwise reseeds from the new
   title. While here: collapse the three copy-pasted hydrate ternaries
   (~1785, ~1897, ~2398) into one helper, delete the retired
   `prev.filename !== "clip"` heuristic at ~1773, and make the
   resetForNewSource docblock + the flag's comments agree with the actual
   behavior (they currently contradict it in two places). Update the e2e:
   custom name survives same-source refetch, reseeds on a different source.

Commit: `app: position handoff on every fallback edge + per-source filename flag`

## Prompt 3 — Co-review chase latch, for real this time

Both RC3 gaps confirmed (`use-co-review.ts`, `App.tsx`):
1. The yielded-heartbeat branch still runs `coLastHostPosRef.current =
   m.position` unconditionally, consuming the host-scrub edge — a paused
   guest whose latch was hot ends up permanently parked. Only commit the
   host position as "seen" when the heartbeat was actually acted on (or
   compare against the last ACTED position instead of the last seen one).
2. The latch is armed by App's onSeek — which the chase itself calls
   (self-arming feedback), while onStep / seekBySeconds / onGotoIn/Out
   never arm it. Split the seams: give the chase an internal seek that does
   NOT mark, and route every user-initiated seek path through markUserSeek
   (the playhead-store canary shares this blind spot).
Add a vitest for the hook covering: paused host double-scrub (guest must
land on P2), guest frame-step during host playback (no yank within the
latch window).

Commit: `co-review: chase latch covers all user seeks and never eats the scrub edge`

## Prompt 4 — Export parity, recents identity, docs truth-up, conventions

1. **Local export collision parity** (`App.tsx` ~2016-2022 + queue variant,
   `system.rs` write_bytes_to_path): local exports still hard-fail on an
   existing file while create_clip uniquifies. Add uniquing to the local
   path (either a `unique_path_for` Rust command the frontend calls, or —
   better — teach write_bytes_to_path an `unique: true` mode that walks
   -2/-3 like unique_output_path and returns the path actually written;
   surface that name in the done notification). Fix the two stale comments
   claiming the paths match; the Sidebar "Saves as" promise then becomes
   true for both pipelines. Rust test in a tempdir.
2. **Recents source identity** (`types.ts` RecentClip, `App.tsx` push
   sites, `Sidebar.tsx` groupedRecents): add `source?: string` (webpage_url
   or local path — the push sites hold it), group and toggle on
   `r.source ?? r.title` so legacy entries keep working; title stays
   display-only. Update the grouping e2e with two same-title sources that
   must NOT merge.
3. **Docs truth-up:**
   - `CLAUDE.md` Build-ID section: `src-tauri/src/commands.rs` →
     `src-tauri/src/commands/system.rs` (file was split in r47).
   - `_design/clip-line-language-plan.md`: prepend a STATUS header stating
     the lines proposal was superseded by the tone-card grammar (link
     `_design/prompts-ui-polish-v3.md`) so the doc reads as history, not
     current direction.
   - `ARCHITECTURE.md`: add the media stream-cache layout (warm boot,
     sweep-exempt downloads dir), the tone-card design grammar, and the
     X-Timeline/X-Stream-Epoch proxy↔player contract.
   - `_design/prompts-live-presence.md`: add the empty "## Spike results
     (pending hardware run)" section the pack references.
4. **Conventions sweep** (all confirmed by quotation):
   - BunnyLoader: `bl-*` classes → `cp-bl-*` (cp- prefix rule); move the
     gradient stops into loader.css via `stop-color: var(--novella-purple)`
     etc. — SVG stops ARE CSS-styleable, the inline comment claiming
     otherwise is wrong; drop the now-false comments both sides.
   - Sidebar reveal buttons: `style={{ width: 22, ... }}` → sidebar.css
     class; extract the duplicated lead/nested row internals into one
     sibling `RecentRow` while there.
   - `get_warm_start` → `async fn` (sync command does disk I/O on the main
     thread ahead of the optimistic mount).
   - `ffprobe_path()` → delegate to `crate::commands::sidecar_path` (same
     resolver ffmpeg/nightly use; kills the copy-paste and the dev-layout
     gap).
   - `check:release`: assert the REQUIRED sidecar set (yt-dlp, ffmpeg,
     ffprobe, whisper-cli, saucebunny-diarize, saucebunny-dictate,
     llama-server) all exist in `src-tauri/binaries/` before the dylib
     audit, so a missing ffprobe can never ship silently.
   - `queueOpen` persistence → loadJson/saveJson like every sibling pref.
   - MediaSpikePanel (241 lines) + LibraryCard (212 lines): split into
     sibling components per the 150-line rule, or leave with an explicit
     justification comment if splitting hurts readability (state which).

Commit: `export/recents parity + docs truth-up + conventions sweep`

## Deferred (noted, not scheduled)

- BunnyLoader glow layer animates stroke-dashoffset under an SVG gaussian
  blur (CPU rasterized in WKWebView) during pipeline startup — if prep
  overlay feels heavy, make the glow a static outline with an opacity pulse.
- hover-frames does 4 mediabunny container parses per hover (one Input +
  one sink would do); blob-LRU logic is triplicated in use-library-scan.
- focus-contract guard: regex denylist + hand parser; postcss walk would
  close the rgb()-syntax / new-hex gaps.
- YouTube thumb candidate chain + placeholder sniff duplicated across
  LibraryView/LibraryHero/LibraryCard → one helper + hook.
- playheadFramesToSeconds not used by getPlayheadSeconds (App ~1092) and
  maxSeekSeconds re-derives the fps rounding — unify the conversions.
- Screening keeps the sidebar (user directive) but nothing guards a minimum
  theater width on laptop windows — consider auto-collapsing the sidebar
  content column below a width threshold while keeping the panel present.

## The standing user-side gate

The live-presence pack stays locked until the MediaSpikePanel hardware run
(dev AND built .app) and its verdicts land under "Spike results".
