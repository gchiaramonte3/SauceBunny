# Decisions and deliberate non-fixes

Things this codebase found and deliberately did **not** change, and why.

Most engineering docs record what was built. This one records what was
considered and declined, because that is the harder thing to recover: a fix
that was never made looks identical to a problem nobody noticed, and the next
person pays to rediscover it. Each entry names the thing, what was measured,
and the reason it was left.

Read this before "fixing" something here that looks obviously wrong. It may
be, and the entry will say so — several are marked as still open, with what
closing them would cost.

Newest sections first. Written as work happened, so the tone is a log rather
than a reference.

---

## The three session gaps: two closed, one declined (2026-08-29)

The Sessions design work ended with three items filed as "decide, don't
drift". This is the deciding. Each was investigated against the tree and then
adversarially verified; the frames recommendation was **refuted** by that
second pass, which is why it is a non-fix rather than a feature.

### Marked ranges: the premise was wrong, and the gap was a verb — FIXED

The item read "in/out marks have no home in a session record; that is a
feature, not a schema fix." Half right. There are **two** range systems here,
both deliberate:

| | range comment | clip marks |
|---|---|---|
| means | "look at this span" | "cut this span" |
| hotkeys | shift-I / shift-O | I / O |
| shared? | yes, on the existing `add` op | never, forbidden by name |
| lands on | every peer's timeline, disk, four NLE exporters | this machine's export queue |

So "the room marked this range" was never unserved — it is a range comment,
and has been all along. What was missing was the **bridge**: `onMarkRange` and
`onQueueRange` flowed from App into QueueDrawer and QueueDrawer handed them to
TranscriptViewer and nothing else. A range selected in a transcript could be
cut; a range the whole room had just agreed on could only be jumped to.

Two buttons, 81 lines across three files, no schema, no wire, no screening
change. Pinned by `range-adopt-contract`. Adopting is a LOCAL act, which is
what keeps it inside the existing rule instead of needing a new one.

**Do not "improve" this by broadcasting the adopted marks.** That is the line
`session-msg-contract` draws, and the contract now says so. Note its real
shape while you are here: it is a five-identifier string scan
(`inFrames|outFrames|queuedRange|clipQueue|QueuedClip`), so a future variant
named `MarkRange { start, end }` would pass it untouched. The promise is
enforced against the current vocabulary, not the concept.

### Recording: correctly deferred, and one open question now has an answer

`docs/RECORDING-PLAN.md` is a real five-pass plan marked NOT YET IMPLEMENTED,
with its load-bearing claims spot-verified. It is not an oversight and nothing
here supersedes it. It ends with **ten open questions for the user**, and they
are genuine product calls, not analysis gaps.

One of them can be closed now. Question 6 asks `~/Documents` or `~/Movies`,
noting Documents is iCloud-synced for many users and a 15 GB session would try
to upload. That is no longer hypothetical on at least one dev machine: iCloud
Desktop sync duplicated `.git/refs/remotes/origin/main` as `main 2`, and
because git reads every file under `refs/` as a ref, the resulting
space-containing ref name broke `git fetch` outright. Seven more `.git` files
were duplicated the same way. **A sync tool that corrupts a git repo will not
handle a multi-GB `.part` file gracefully.** Whatever else is decided, the
recording root must not be a synced folder by default.

### Frames: no link back to their session — DECLINED

The claim was true (a frame carries no session id, and nothing records that
one was grabbed) and the proposed fix was an extended attribute. Adversarial
verification refuted the reasoning behind it, on four counts:

1. **The exclusivity claim fails.** The argument was that an xattr is the only
   way to attach a field without adding a second copy of anything. But
   `folder` is already exactly that: a path-borne field, written by
   `move_frame_to_folder`, derived by `walk_frames`, rendered by the shelf.
   Filing a session's grabs into a directory records the same link with no new
   storage, no new command, and a reader that already exists.
2. **The cost was wishful.** "About 25 lines" counted only the write.
   The read needs a new `FrameItem` field (so `cargo test --lib` regenerates
   the binding), an `xattr::get` per entry inside a listing that re-runs on
   every window focus, async screening-index hydration to turn an id into a
   title, and a **build-ID bump in two places** the estimate never mentioned.
   Realistically 6-9 files.
3. **The two directions were conflated.** "There is no screening viewer" is
   true of session → frames, and was used to inflate the cost of the
   frame → session change being recommended, which needs no viewer at all.
4. **The zero-storage correlation is not identity.** A frame's stem is the
   title through `sanitizeFilename` (character substitution, dot stripping,
   UTF-8 truncation); the screening segment stores the RAW title. Matching
   them means re-deriving the sanitiser and is lossy for any title that was
   truncated or contained a replaced character. The other axis, mtime, is
   rewritten by any later touch.

And the option nobody surveyed: `docs/RECORDING-PLAN.md` already specifies
`~/Documents/Sauce Bunny/Sessions/<date>-<slug>/` for per-session artifacts,
explicitly names Frames as the pattern to copy, and sanctions a `session.json`
**inside** its own session folder as not-an-index. If a frame ever needs to
know its session, that is where the answer starts.

**Left alone.** Screening ids are local to each machine by design, so any such
link is per-machine anyway; there is no consumer for it today; and every
storage option either breaks the property the Frames design exists to protect
(a Finder rename must not break anything) or degrades silently outside the Mac
— xattrs survive `mv` and `cp` and are lost through zip, measured on this
machine.

### What else has no home, checked and dismissed

Verdicts, the presenter timeline, reactions, raised hands and screen sharing
were all examined for the same gap. Only one looked promising and it does not
survive contact: a screen share renders in the **PeoplePanel tile**, replacing
that person's camera, not on the stage. The room is still watching the loaded
media. Recording it as a segment would claim the room stopped watching
something it never stopped watching. Verdicts already persist correctly — in
the ReviewDoc, per version, which is where the invariant says a fact about the
SOURCE belongs. Reactions fade in 4.6 seconds by design.

---

## Making every mechanical CLAUDE.md contract a test

Eight guards added, taking the register from 43 to 51. Four of the eight claims
named in the brief turned out to be guarded already, and one did not exist.

### Already guarded (checked, not assumed)

| claim | guard that already covers it |
|---|---|
| localStorage keys namespaced | `storage-keys-contract` (nine named exceptions) |
| no hex outside tokens.css | `token-usage-contract` |
| build-ID two-file match | `build-id.test.ts` — parses the Rust constant out of `system.rs` |
| sidecar set agreement | `sidecar-surface-contract` (four places; NOT `scripts/`, now closed) |

### The claim that did not exist

There is no BunnyLoader hex mirror. The hexes live only in `tokens.css`;
`loader.css` reaches them through `var()`, and `BunnyLoader.tsx` carries a comment
explaining that `stop-color` is a CSS presentation property so the colours belong
in the stylesheet. Nothing to pin. What WAS there instead: 34 stale `var(--x, #hex)`
fallbacks from a palette retune, now removed and guarded.

### Review-only: judgment calls a regex cannot make

These are real rules in CLAUDE.md. They are listed here so nobody mistakes the
absence of a guard for the absence of a rule.

- **"Keep components under 150 lines."** Countable, but the doc itself says a
  longer component "probably needs to be split" — advisory, not a threshold. A
  ratchet would need an allowlist of most of `components/`, which documents the
  status quo rather than constraining it.
- **"Composition over abstraction"**, **"extract a hook only when the same
  stateful logic appears in 3+ components"**, **"define handlers inline if ≤2
  lines"**, **"avoid useEffect for derived state"**, **"React.memo only after
  profiling"**. Each turns on whether two pieces of logic are *the same* or whether
  a render was *actually* a problem. A regex can count lines; it cannot read
  intent, and a guard that guessed would be argued with and then disabled.
- **Whether a given `!important` was unavoidable.** The count and the presence of
  an explanation are now guarded (`important-contract`); the judgment is not.
- **"No dead code."** Unreferenced exports are findable; whether something is a
  seam kept deliberately is not. The `untested-libs.sh` skip list is the same
  problem solved by hand, per module, with a written reason.

### One pattern worth carrying forward

Six times in this codebase a scanner has read a description of a thing as the
thing: `role="dialog"` in a `querySelector` string, `useModalFocus` in a
commented-out call, `.cp-ql-scrim` in a CSS comment, `globSync` in its own
explanation, an ejected crate named in the comment explaining its ejection, and —
best of all — `no-any-contract` matching the `Array<any>` inside its own regex
literal. Strip comments before believing a match, and exclude the guard's own file.

---

## Reviewed and left alone: QUIC writes under the session mutex

`session_send`, `session_broadcast` and `relay_to_others` each await a QUIC
`write_all` while holding the `SessionManager` mutex (and, on the broadcast
paths, the host `peers` mutex too). A review flagged this as a hang: one peer
that stops reading freezes Leave and End for everyone in the room.

The shape is real. The failure is not, and three independent passes each
failed to reach it:

- **The write is bounded by the transport.** iroh's QUIC connection carries an
  idle timeout, so a peer that stops reading fails its stream rather than
  blocking indefinitely. Whatever wedge exists is bounded by that timeout.
- **The obvious fix is worse than the problem.** Cloning the peer list and
  writing outside the lock lets a peer be removed mid-broadcast, so a write
  lands on a connection the roster no longer holds — which is how a ghost
  participant tile gets stuck at "Connecting" and never clears. The lock is
  what makes "who is in the room" and "who we are writing to" the same answer.
- **These are control frames, not media.** Comments, playhead ticks,
  reactions: kilobytes. Media never travels this path at all, by the rule in
  CLAUDE.md.

Recorded because the code reads alarmingly and will be re-reported. If a
session genuinely hangs, look at the idle timeout before the lock. Anyone who
does want to drop the guard before the write has to solve the removal race
first; the contract note lives at the top of `SessionManager` in session.rs.

## Untested pure modules

### Outcome

Ten iterations, cap reached, gate empty. Fourteen modules at the start; eight
covered, five skipped with reasons recorded in `scripts/untested-libs.sh` itself
rather than here, so the justification sits where the exclusion is.

Nine real defects were found and fixed along the way, none of which announced
itself — every one degraded silently:

| module | defect | how it presented |
|---|---|---|
| text + App | filenames kept `&#39;` while the sidebar showed `'` | exports named wrongly on disk |
| level-meter | hold marker one segment above the signal | red "peaking" bar with nothing red lit |
| level-meter + PeoplePanel | time-domain buffer half the window | both meters under-read |
| sound | AudioContext never resumed | every UI cue silent, no error |
| platform-capabilities | blob-Worker probe blind to async CSP rejection | reported working on the broken config |
| identity | fresh install id per call on the storage-failure path | rejoin looked like a stranger; roster grew |
| share-stream | `gotData` had no reject | share hung forever, teardown never ran |
| share-stream | quota `return` outside its guard | share stalled with no death reported |
| ai-chat | trailing buffer and decoder never flushed | summary truncated, looked finished |

### The pattern worth keeping

Six of the nine were in code whose own comment described the correct behaviour.
`identity` promised "a rejoin inside the same run still reclaims" and minted
fresh every call. `sound` sat two files away from two other modules that document
the suspended-AudioContext rule. `platform-capabilities` was written *because* a
failure parked instead of throwing, and its own probe then parked instead of
throwing. Intent written down is not intent implemented, and a comment asserting
a behaviour is the strongest available hint that nothing checks it.

### Skipped, and why the list is short

Two modules that looked like obvious skips — `mediabunny-source` and
`mediabunny-audio` — turned out to hold real testable logic: a URL/path routing
branch guarding the 800 MB `asset://` stall, and a hand-rolled WAV encoder that
feeds Whisper. Both are now covered. That is the reason the skip list requires
reading the module first and stating what a test would have to fake.



### Partially fixed, with the remainder named: the blob-Worker capability gate

`platform-capabilities.ts` exists because a CSP-blocked WASM decoder did not
throw — it PARKED, and a file played with perfect picture and no sound. Its own
header says so. The blob: Worker probe then reproduced that exact shape.

Measured in Chromium under `default-src 'self'`: the console logs *"Creating a
worker from 'blob:…' violates the following CSP"*, `new Worker(url)` **returns a
Worker object anyway**, and the rejection arrives later as an `error` event with
an empty message. A probe that constructs, terminates and returns in one
synchronous breath cannot see any of it, so it answered `blobWorker: true` on
exactly the configuration the module was written to detect.

Fixed where it is observable. `confirmBlobWorker` awaits a message or an error
and corrects the cached capability, one-directionally: only positive evidence of
failure flips it, and a timeout resolves to working, so a slow machine can never
lose a decoder it actually has. That makes the startup log line truthful (the
module's stated diagnostic purpose) and — more usefully — fixes
`mediabunny-export.ts`, which reads `platformSupports()` at EXPORT time, long
after any probe has settled.

**Not fixed:** `main.tsx:45` registers decoders during startup, synchronously,
before any async probe can settle. On a CSP-blocking build the ProRes decoder is
still registered on the optimistic answer, which is the original parking bug.
Closing it means deferring registration until after an async probe — a startup
architecture change, not a test-coverage change, and it risks delaying every
local playback path to fix a configuration that the CSP fix already addresses.
Left deliberately, with the sync probe now named `probeBlobWorkerSync` and its
blind spot documented at the site.

### Verified, then corrected rather than assumed: which WASM step CSP blocks

`probeWasm`'s comment asserted that under a blocking CSP `WebAssembly.compile()`
and `new WebAssembly.Module()` both SUCCEED and WebKit enforces at instance
creation. In Chromium the opposite happens: `new WebAssembly.Module()` itself
throws `CompileError`. Since the app's engine is WKWebView, neither claim is
verifiable from here, so the comment now says only what is true on every engine
— the probe does BOTH steps in one expression, so a throw from either is caught
and the question does not need answering.

---

## Clippy warnings to zero

**Outcome: the goal was already met.** `cargo clippy --all-targets -- -D warnings`
exits 0 from a cleaned crate, and that is real rather than suppressed: no
crate-level `allow`, no `clippy.toml`, no `[lints]` section, and exactly one
`#[allow(clippy::…)]` in the tree — at its site, justified by the declared MSRV
of 1.77.2 against `is_none_or` stabilising in 1.82. No warning clusters existed
to fix, so the fix pass never had anything to do.

The one actionable item was the closing check, and it found a real gap: CI ran `cargo clippy -- -D warnings` **without `--all-targets`**, so the
~264 unit tests in `#[cfg(test)]` modules had never been linted. Fixed in
`dc8f3c7`.

### Declined: two `#[cfg(not(target_os = "macos"))]` blocks

`src-tauri/src/commands/system.rs` — the non-macOS arms of
`av_permission_status()` (returns all-`authorized`) and `read_clipboard_text()`
(returns `""`).

On macOS these never compile, so clippy never lints them **and rustc never type
checks them**. Since macOS is the only platform this app supports and CI's only
runner, that is permanently true: the two blocks could rot into
non-compiling code and nothing in the repo would notice. By the letter of
CLAUDE.md — "No dead code", "No Windows/Linux builds" — they are dead.

Not removed, because that is a decision about whether the crate should still
build on a non-macOS machine, not a lint fix, and a linting pass is the wrong
authority for it. Both stubs are eight lines total and trivially correct, so
the practical rot risk today is near zero.

To decide: if the crate is meant to stay `cargo check`-able off macOS, keep
them and accept that they are unverified. If not, delete both and let a
non-macOS build fail honestly at the missing function.

### Resolved: the last `#[allow]` in the crate is gone

`src-tauri/src/commands/download.rs` carried
`#[allow(clippy::unnecessary_map_or)]`, justified by the crate's declared
`rust-version = "1.77.2"` against `is_none_or` stabilising in 1.82 — the lint
used to suggest an API the MSRV forbids.

Removing it locally produced no warning: clippy became MSRV-aware and stopped
suggesting `is_none_or` below 1.82. The lint fixed itself. The blocker was that
deleting the attribute is only safe if CI's clippy is at least that new, and the
workflow had never printed its toolchain — so the version step went in first,
and the next run recorded **rustc 1.97.1 / clippy 0.1.97**, newer than the 0.1.95
the behaviour was observed on. Attribute deleted; `src-tauri/src` now contains
zero `#[allow]` of any kind.

The comment stayed, trimmed. Its core claim — use `map_or(true, …)` rather than
`is_none_or` because of the MSRV — is still true and still the reason the code
is shaped that way. Only the sentence about needing an attribute was stale.

**Superseded (2026-08-23).** That whole premise was resting on a number nobody
had checked. `cargo metadata` says iroh and its family declare **1.91**, so
`rust-version = "1.77.2"` was never a floor anyone could build at — it was a
figure README and CONTRIBUTING quoted at contributors, telling someone on 1.77
they were fine when the graph would refuse them. With the declared MSRV
corrected to 1.91, clippy immediately asked for `is_none_or` (correctly, it is
stable at 1.82), and the call site now uses it. The lesson is not about the
lint: a declared MSRV that nothing verifies drifts from the real one silently,
and the docs inherit the error.

### Surveyed and not adopted: `clippy::pedantic`

With the default set at zero, the obvious next question is whether a stricter
bar is hiding anything. `cargo clippy --all-targets -- -W clippy::pedantic`
reports **1,104** warnings. The shape of them is the answer:

| count | lint | worth it? |
|------:|------|-----------|
| 319 | `doc_markdown` | no — backticks in doc comments, 29% of the total |
| 94 | `needless_pass_by_value` | changes signatures; behavioural, out of scope |
| 84 | `cast_precision_loss` | benign, see below |
| 83 | `map_unwrap_or` | style |
| 80 | `cast_possible_truncation` | benign, see below |
| 64 | `redundant_closure_for_method_calls` | style |
| 58 | `manual_let_else` | style |
| 52 | `uninlined_format_args` | style |

Concentrated in `media.rs` (204), `transcript.rs` (203) and `session.rs` (195),
which is simply where the code is.

**The cast cluster was checked, not assumed.** It looked like the one place a
real defect could hide — truncation in media or timecode maths. It does not: all
42 sites in `media.rs` / `transcript.rs` / `stream_proxy.rs` are ffprobe JSON
fields narrowed `u64 → u32` (`width`, `height`, `channels`, `sample_rate`) or
`CGDisplayPixelsWide`, none of which can exceed `u32`. The one float cast,
`media.rs:1272`, feeds a poster **cache key**: a non-finite input would saturate
to 0 and collide with the `t = 0.0` bucket, serving a valid poster for the wrong
timestamp. Harmless, and not reachable from a caller that passes a real
timestamp.

So: pedantic is noise here, adopting it wholesale would be ~1,100 mechanical
edits across the media paths for no defect found, and the default set is the
right bar. Recorded so this is a decision rather than an omission.

### Closed off, so nobody re-checks

- **No `[features]` section and zero `cfg(feature = …)` sites**, so
  `--all-features` would widen clippy's coverage by nothing. That avenue is
  genuinely empty rather than untried.
- Every other `cfg` gate is `cfg(unix)` or `cfg(target_os = "macos")`, both true
  on the CI runner, so all of that code is compiled and linted.
- **A clippy run that reports zero twice in a row proves nothing** — the second
  is cached and re-emits no diagnostics for an unchanged crate. Every baseline
  in this pass was taken after `touch src/lib.rs` or `cargo clean -p`.

## Web collections: the four calls behind the store (2026-08-24)

The parity audit ended in product questions and the user's directive ("give
the user the ability to organize everything") answered the WHETHER. The HOW is
these four decisions, each the audit's own recommendation:

- **Organisation is virtual and keyed by raw URL.** Moving a web item never
  moves its cached file: a copy moved out of `media/` severs
  `find_cached_download`, goes cold on the warm start, and orphans the LRU
  cap. Raw URL over the canonical hash because every satellite store
  (recents, posters, transcript history, review docs) already keys on it, and
  the canonicaliser exists only in Rust.
- **Documents-class, one file.** `~/Documents/Sauce Bunny/Collections/
  collections.json` beside Casts and Reviews. Cache-class would be destroyed
  by Forget/cap/Clear-all; localStorage is DATA-MODEL.md's named F2 hole.
- **Web-only for now.** A unified collections concept spanning local files
  would duplicate what real directories already do for them, and every
  path-verb would need a URL story. Revisit only if mixed groups are asked
  for.
- **Membership survives a cache forget.** Pruning the cache must not silently
  edit curation; the pane renders what it can and says how many clips are
  waiting to be re-fetched.

Also chosen, smaller: collections fold ABOVE the site shelves and a filed
clip leaves its site shelf (it has been filed - showing it twice would read
as search results); the LIST view stays flat because Site is a column there;
no colours on web items (real Finder tags need real paths, and a lookalike
that Finder cannot see would break the app's "real macOS tags" promise); no
batch forget from a selection until the summed-size confirm exists.

## Containers are directories (2026-08-24)

The ask was folder structure inside Frames and the web shelf, plus deeper
organisation in the Library. Three designs were put up: real directories,
nested virtual collections generalising the web-collection store, and
extending transcript projects into the app's one container. Directories won,
and the reasons are worth keeping because two of them are about what NOT to
build:

- **One concept means one persistence rule.** Both record-based designs kept
  the Library on real directories anyway, so each shipped a record store PLUS
  directories - two systems, which is the thing being complained about.
- **Both needed a `STORE_SCHEMA_VERSION` 1 to 2 bump.** That constant is read
  by every file store and its own header defines the bump as a one-way door:
  older builds go read-only. Spending that on a feature whose whole point is
  that it needs no file was the wrong trade.
- **Making Frames virtual would add the exact index `frames.rs` exists to
  avoid** - "there is no index to fall out of step with the directory".

What a container IS: a directory. Identity is its path, persistence is the
filesystem, and the cover is DERIVED from its contents at render time - the
three newest stills for a Frames folder, `libraryPosterPaths` for a Library
one. The evidence for deriving rather than storing was already in the repo:
`TranscriptProject.posterPath`, documented as "an image the user picked", is
declared, initialised, parsed, and read by nothing. Only the derived path is
live.

Web collections do NOT fold in. A web source has no file to put in a folder,
and moving a cached copy out of `media/` severs `find_cached_download`, goes
cold on the warm start and orphans the LRU cap - already settled above. They
stay virtual, flat, raw-URL-keyed and web-only.

Smaller calls made along the way: the noun is FOLDER (project and collection
are both taken, and it is what the thing literally is); a filed frame leaves
the stem shelves, so it appears in exactly one place; search and list view
flatten the whole tree, matching the web pane; and a Frames tree is walked
three levels deep, matching the library scan's cap.
