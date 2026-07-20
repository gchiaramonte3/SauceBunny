# Architecture assessment — r131 (2026-07-20)

Full-system audit across ten dimensions, every finding independently
materiality-checked. 65 raw → 35 material → 1 critical, 18 high.
Ran after a live two-machine session where screen share and camera video
both failed.

## Headline

The problems cluster into four structural facts, not diffuse rot. The hard
parts are well built: the loopback proxy's capability gate is correct by
construction, there is essentially no panic surface in 13.5k lines of Rust,
command injection is absent by design (argv arrays, no shell anywhere), the
`AppError` migration is verifiably complete, and `web-playback-machine.ts`,
`playhead-store.ts`, `rtc-mesh.ts` and `use-panel-bus.ts` each deleted a whole
bug class. **The security/resources dimension produced zero material findings.**

What fails is everything on the other side of those boundaries.

## Theme A — silent failure is the house style

The co-review stack (`session.rs`, `use-co-review.ts`, `use-rtc-mesh.ts`,
`rtc-mesh.ts`, `use-media-capture.ts`) writes **zero** log lines: 0 `appendLog`,
0 `log::`/`eprintln!`/`tracing::`. Meanwhile `use-web-playback.ts` calls
`appendLog` 14 times and `App.tsx` feeds `logLines` into the diagnostics export.
A first-class diagnostic channel exists; the one subsystem that inherently needs
two machines to test was left dark.

Same pattern below it: both read loops discard unparseable lines with a bare
`continue`; every Rust emit is `let _ = app.emit(...)`; every frontend invoke is
`.catch(() => {})`. `list_share_sources` already receives the capture sidecar's
exit-4 "permission denied" and throws it away (`media.rs:2478`).

**This is what makes every bug cost two machines and an evening.**

## Theme B — every good migration stopped after one instance

| Pattern proven | Landed | Did not |
|---|---|---|
| Discriminated-union state machine | web playback | local playback (4 order-coupled booleans + 91-line if-chain matching a magic string) |
| DI + fakes + tests | `rtc-mesh.ts` | `session.rs` host router: 200 lines, zero tests |
| External store (`useSyncExternalStore`) | playhead | source identity, job registry (16 render-time ref mirrors instead) |
| Hook owns its listeners + logs | web playback | one 275-line effect registering 15 listeners for 4 subsystems |

## Theme C — the guards work; they point at the wrong things

`focus-contract.test.ts` and `voice-contract.test.ts` hold with zero erosion.
Everything with a test behind it is kept. Everything without one drifted:

- **ESLint does not exist.** 38 `eslint-disable` comments suppress a linter that
  is not installed (0 hits in package.json, no CI step). Installed in a
  scratchpad it reports **31 real warnings**, concentrated in the camera and
  co-review paths. CI enforces `clippy -D warnings` on 13.5k lines of Rust and
  nothing on 43.5k lines of TypeScript.
- **The ts-rs "stale-bindings check" never diffs.** `cargo test --lib` *writes*
  the bindings; writing a file cannot fail a build. No `git diff --exit-code`.
- **The handover regression test asserts a closure defined in its own body**
  (`session.rs:1184`). Delete the production rule and the suite stays green.

## Theme D — the build cannot tell you what it is

`check-notarization-ready.sh` is a thoughtful 200-line gate with 20+ integrity
checks, wired so it can never pass on the machine that ships (no Developer ID
identity → fatal), and nothing invokes it anyway. The only shipping path runs
**zero** of its checks.

Ad-hoc signing makes the designated requirement a bare cdhash, so every rebuild
silently revokes camera/mic/screen TCC grants while System Settings still shows
them enabled. Verified 2026-07-20: stored csreq `cdhash 4ebb91f4...` vs running
binary `c5039184...`. No git SHA in the bundle. Swift sidecars are never
executed at any tier, and nothing rebuilds them — editing `main.swift` ships the
previous binary.

## Critical path

1. **Wire co-review + capture into `appendLog` and the diagnostics export.**
   Half a day. Copy the `use-web-playback.ts` shape (it already takes
   `appendLog` and calls it 14 times). ~20 one-liners at every state edge.
   Converts six other findings from multi-hour mysteries into ten-minute reads.
2. **Install ESLint with exactly two rules** (`rules-of-hooks: error`,
   `exhaustive-deps: warn`). No style rules. 30 min + ~2h triage.
   Gotcha: two pre-existing disables reference `@typescript-eslint/no-explicit-any`,
   which errors as "rule not found" under a minimal config.
3. **Small-fix batch** — see "Done in r131" below; remainder: index.json
   corruption guard, contentless-doc write guard, presenter-disconnect deadlock.
4. **Make the build tell you what it is.** Tier the gate with `--adhoc`
   (downgrade the 4 signing checks to warn), wire `check:artifact` into
   `beforeBuildCommand`. Must EXCLUDE the "already tagged" check or every
   post-release rebuild refuses to build. Propagate the sidecar's exit-4 as a
   `permission_void` flag so the TCC trap explains itself.
5. **Extract the pure router from `session.rs`** —
   `route_peer_msg(sender, presenter, epoch, msg) -> Vec<Route>`. ~90 lines,
   behavior-preserving. Makes the protocol testable without two machines.
   Skip the `HostState` struct refactor.

## Explicitly do not

- **Do not rewrite App.tsx**, and specifically not the `SourceScope` collapse:
  386 identifier sites in the most fragile file in the repo.
- **Do not add a state management library.** The ban is still right;
  `playhead-store.ts` proves `useSyncExternalStore` solves it in ~80 lines.
- **Do not build the reaction CRDT.** Comment tombstones alone fix the dominant
  case, which needs one machine and no race.
- **Do not chase the 548 CSS color literals.** The proposed rule actually flags
  34. The real problem is token incoherence (`--color-destructive` referenced
  once; untokenized `#ff8a8a` 12 times across 4 files).
- **Leave settled things settled**: no MAS code, no YouTube IFrame, no custom
  URI schemes for `<video>`, no WebCodecs audio, no hidden-`<audio>` twin.
- **ffmpeg vs mediabunny: the split is correct.** mediabunny has properly taken
  export, whisper WAV extraction, posters, filmstrips, probes; ffmpeg is
  load-bearing everywhere it remains. The leaks are in how those processes are
  *supervised*, not whether they should exist.

## Constitution edits owed

- `CLAUDE.md:135` instructs new Rust code to return `Result<T, String>`, ~180
  lines before priority #4 declares that migration complete. The code agrees
  with #4.
- `CLAUDE.md:125` says all styles live in `app.css` (33 lines of `@import` over
  21 siblings). Its own correction names `index.css`, which does not exist.
- "Components under 150 lines" is violated by 38 of 85 (45%). Amend to ~300 plus
  a named frozen debt list of the current ten.
- Priority #1 "thin wrappers — DONE" is false: four handlers exceed 200 lines,
  `generate_transcript` is 585.
- **Co-review is absent from the architecture map, sidecar table, and event
  table entirely** — ~2,000 lines of Rust, the largest hook in the tree, an iroh
  transport, a WebRTC mesh, and a Swift capture sidecar, invisible to the
  document every session reads first.

## Done in r131 (commit 42b9c51)

Placeholder transceivers seeded from live overrides + given a stream identity;
remote tracks accumulated per peer; video senders tuned for what they carry;
mesh roster re-seeded on rebuild; camera/mic toggle acquires when there is no
stream; capture failures promoted to singletons and surfaced as notifications;
session comments write through per-op; `activeSourceUrlRef` cleared on reset.
8 new tests, all failing against the shipped build.
