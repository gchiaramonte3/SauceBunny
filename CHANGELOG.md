# Changelog

All notable changes to Sauce Bunny. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [Unreleased]

### Live media
- **Screen sharing and camera video both work for someone who joins mid-share.**
  One half-finished mechanism broke both: the sender slot reserved for a track
  that doesn't exist yet was never handed the live screen share, and never
  given a stream identity — so a peer received each track separately and kept
  only whichever arrived last. A newcomer saw a blank tile while the sharer's
  screen said "sharing", or a camera with a permanent "muted" badge.
- A late joiner now gets the share at full resolution instead of the camera's
  tile-sized downscale, so shared text stays readable for everyone, not just
  the people who were already connected.
- **Turning the camera or mic on actually opens one.** With no capture running,
  the room's buttons flipped their icon and did nothing while the toolbar
  claimed the camera was on, with no way back short of leaving the session.
- A camera or mic that refuses to open now says why. These failures used to be
  written to a field nothing displayed, so a device held by another app failed
  in complete silence. macOS ending a track (another app takes the camera,
  sleep, unplug) is now noticed too, instead of showing a live camera that
  isn't.
- Editing the relay settings mid-session no longer kills every connection
  permanently.

### Reliability
- **Comments made in a session are saved as you make them.** They previously
  reached disk only when someone ended the session, so quitting the app — or
  crashing — lost every note from that review, on every machine at once.
- Loading a new source clears the identity of the old one, so a guest can no
  longer ignore the presenter's next source as "already on it".
- A guest is correctly recognised as themselves in the room roster; when their
  own id arrived after the roster did, they saw their own tile as a stranger's.

### Diagnostics
- Co-review, the peer connections, and the camera now write to the pipeline
  log, and **Export diagnostics includes a session block** — role, who holds
  the floor, the roster with per-peer connection state, and what the camera is
  doing. Comparing two exports shows which machine's picture is wrong; these
  subsystems previously recorded nothing at all.
- A message the other machine can't read is reported as a version mismatch
  instead of being dropped silently.

## [0.2.3] — 2026-08-18

### Fixed
- **Hidden warnings can be brought back.** Four "don't show me this again"
  flags — the rename-writes-to-disk warning, the first-run tips, and two
  per-transcript notices — were one-way doors: ticked once, and the only route
  back was deleting a key from localStorage by hand. Settings ▸ Backup & reset
  now restores them all, and a contract test fails if a fifth is added without
  one.

## [0.2.2] — 2026-08-18

### Fixed
- **The cue right-click menu survives a big cast.** Past six reassignment
  targets they collapse into an "Assign to speaker" submenu with a filter,
  instead of one row per person running off the bottom of the screen and
  pushing Play and Clear speaker out of reach.
- **The reassign list is ordered by talk time**, like every other speaker
  surface. It alone used the roster's first-appearance order, so it showed
  Speaker 16 above Speaker 8 whenever 16 spoke first and scattered named
  people among unnamed ones.

## [0.2.1] — 2026-08-18

### Fixed
- **The WebCodecs decoder toggle works.** Its description has always said
  "Disable if local files won't play"; it was read only for thumbnail
  extraction, so turning it off changed the poster and not the playback. It now
  routes local imports through ffmpeg-prep as promised — which is the way out
  of a file that decodes with a perfect picture and no sound.
- **Builds are distinguishable.** Four DMGs shipped as `0.2.0` with a build
  number stamped in July. The version is stamped on every build and the About
  tab shows the build number it always claimed was the distinguishing one.

### Added
- **The audio path reports whether it is audible.** A track that decodes and
  never reaches the speakers used to log exactly like success. It now states
  chunks scheduled vs dropped, context state and gain, once per playback.

## [0.2.0] — 2026-07-19

### Reliability
- **Screen sharing now works at all.** The capture engine exited 0.17s after
  launch, before a single frame: it parked on a run loop with nothing attached
  to it, while ScreenCaptureKit delivers on its own queues. Every stage
  downstream then behaved correctly on an empty stream, so the failure looked
  like nothing happening rather than an error.
- **Transcribing a web source no longer takes ~80 minutes.** yt-dlp was being
  forced onto a single-connection downloader that YouTube throttles to
  ~26 KB/s (vs ~83 MB/s native). The audio cache that should have skipped the
  download was also keyed inconsistently, so a link with a `&t=` timestamp
  could never reuse its own cached track.
- Stopping a transcription actually stops it, including during the phases with
  no running process to kill.
- Sidecar execute bits are repaired at launch, so a helper stripped by a sync
  service no longer fails with a raw permission error.
- In-flight sidecars are killed when the app quits instead of outliving it.

### Co-review
- Guests see the host's source, **including local files** (previously nothing
  was sent at all for a local file, leaving the guest on an empty stage).
- A member who leaves and rejoins reclaims their place instead of appearing
  twice, and dead connections are rebuilt rather than left "Connecting".
- Playhead sync no longer drifts from a clock difference between two Macs;
  playback rate is applied instead of being corrected by seeking.
- The camera can be turned on mid-session (it previously could not reach
  anyone if you joined with it off).
- Change or clear what the room is watching without leaving the session.
- Hand the presenter role to someone else so they can share their own sources.

### Added
- First-launch welcome screen.
- Per-permission rows (camera, microphone, screen recording) with a direct
  link to each System Settings pane.
- Session input/output volume, a working mic check, and a level meter.
- The pipeline log reports how long each stage took, and a run total.

### Changed
- Versioning: releases are now semver with a date-based build number, so two
  builds are never indistinguishable. (Every prior build reported `1.0.0`.)
- Bundled yt-dlp refreshed to 2026.07.04.

### Co-review (P2P watch party) — new
- **Watch and review together, peer-to-peer** — host a session and share a
  one-line join code; up to 3 guests connect over iroh QUIC (end-to-end
  encrypted, no accounts, no cloud). Guests follow the host's playhead.
- **Session-first flow** — start a session with nothing loaded; when the host
  loads a web URL it propagates to every guest, and playhead sync activates
  once each guest's player has loaded (late joiners snap to the host's frame).
- **Live shared comments** — review comments, replies, likes, and resolves
  converge across everyone in the session (idempotent ops, last-write-wins
  edits, snapshot merge on join). Everyone keeps the review when the session
  ends.
- **Presence ghost playheads** — see where everyone else is parked on the
  timeline, live.
- **Screening mode** — a cinematic Louper-style layout: participant rail
  (avatars, host crown, live dots), centered rounded viewport, comments panel.
  Sessions auto-enter it; exit and re-enter any time from the co-review menu.
- Hardened against hostile peers: reserved "Host" name, per-message size caps,
  presence-name sanitization; host identity by roster position (not name).
- Hosting is **web-source only** for now — a local file can't reach guests yet.

### Playback
- **ProRes plays instead of showing black** — 10-bit sources (ProRes 422/HQ…)
  are routed to an automatic 8-bit playback copy because WKWebView can't paint
  10-bit WebCodecs frames; the original file is untouched for export.

### Fixes & performance
- Karaoke transcript no longer recomputes O(turns²) bookkeeping on every
  playhead tick — smooth on multi-hour transcripts.
- Review exports: Markdown now escapes comment text/names; EDL titles are
  single-line safe. Liking a reply whose parent was just deleted no longer
  sends a phantom op. AI Summary no longer splits an emoji at the transcript
  truncation point, and picks up a freshly downloaded model immediately.

## [0.1.0] — 2026-06-16

First public release of Sauce Bunny. Highlights, grouped by area (newest first):

### UI polish
- URL bar focus is now a subtle neutral edge instead of a saturated accent
  outline.
- The pipeline pill reads accurately per ASR engine — Parakeet shows
  "TRANSCRIBING" (one-shot, no spurious 0%) rather than "WHISPER · 0%".
- "Detect speakers" row trimmed: dropped the "beta" tag and the "✓ cached"
  indicator.

### Docs & licensing
- Added `THIRD-PARTY-LICENSES.md` disclosing every bundled binary, library,
  font, and runtime-downloaded model and its license (notably: the bundled
  ffmpeg is a GPL build), linked from the README. The released `.dmg` now ships
  the project MIT license, this notice, and the full GPLv3 text under
  `Resources/licenses/`, with a written offer for the ffmpeg corresponding
  source — satisfying GPLv3 for the bundled ffmpeg/ffprobe.
- Truth-up of ARCHITECTURE/CONTRIBUTING/SECURITY: six sidecars (llama-server
  was undocumented), the `commands/` module split, and removal of the stale
  `commands.rs` / `docs/` references.
- Untracked the machine-local `.claude/settings.local.json` (it was committed
  before the ignore rule and leaked local absolute paths).
- README: CI/license/platform badges, feature list brought up to the shipped
  set (AI Summary, Review workspace, voice dictation), real clone URL, and a
  Development section with the pre-PR gate.

### Review workspace
- Local-first review tab (Frame.io-style): timecoded threaded comments anchored
  to the playhead with click-to-seek, resolve/reopen, edit, and replies, plus a
  reviewer identity (name + pickable avatar colour). Timeline markers are tinted
  to the reviewer's colour and expand to show initials on hover.
- Freehand drawing annotations over the frame (perfect-freehand) saved per
  comment and faded in as the playhead nears their timecode.
- Past-reviews history + a content fingerprint (filename + duration + dimensions
  + byte size) so reopening a clip you've reviewed before — even moved or renamed
  — reloads its notes; distinct clips no longer collide.
- Export to Markdown notes, a CSV marker sheet (formula-injection-safe), and a
  CMX3600 EDL for Resolve/Premiere.

### Voice dictation
- Mic button in the review composer: records the system default input via the
  bundled ffmpeg (avfoundation) and transcribes on-device with the active ASR
  engine (Parakeet preferred, Whisper fallback), then drops the text into the
  comment box. Recording stops gracefully (clean WAV finalize), caps at 5 min,
  and is torn down if the panel closes. Requires microphone permission
  (NSMicrophoneUsageDescription, supplied by `src-tauri/Info.plist`).

### Pre-release arc (internal revisions r1–r86)

### Web playback & captions
- Instant streaming playback for web sources: loopback proxy → ffmpeg
  fragmented-MP4 remux → MSE (the only WKWebView path with sound), with
  seek-anywhere, scrub-freeze, frame-accurate WebCodecs scrub preview, and an
  automatic download-to-cache fallback.
- Single-clock A/V/caption sync: the streamed muxed `<video>` is the one clock
  for audio, picture, and captions, so the transcript highlight and on-video
  captions stay locked to what you hear by construction.
- "Fix timing" — one click re-times loose YouTube auto-captions from the same
  cached audio with your active engine (Whisper or Parakeet).
- ffprobe sidecar bundled so HLS/DASH downloads remux correctly.
- J-K-L variable-speed shuttle, type-a-timecode HUD, aspect controls,
  fullscreen, frame stepping, in/out marks with full-clip default.

### Transcription & speakers
- Two transcription engines: local Whisper (whisper.cpp) with model manager, or
  NVIDIA Parakeet TDT v3 (on-device Core ML, word-level timing) — exactly one
  active engine at a time, picked in Settings. Or one-click source-caption
  download (speaker voice tags preserved, best-track ranking).
- On-device diarization: SpeakerKit primary, FluidAudio fallback; speaker
  editor with rename, drag-to-merge, per-turn overrides, color-coded roster.
- Transcript workspace: search (text + speaker modes), karaoke highlight,
  click-to-seek, pop-out window, history, TXT/MD/SRT/PDF export, on-video
  caption overlay with broadcast-style line breaking.

### Export
- Lossless cuts or re-encodes, MP3 audio export, export queue, snapshots at
  source resolution, transcript-driven burned captions.

### Shortcuts & settings
- AI Summary: chat with / summarize a transcript via a local llama.cpp model
  (speaker-aware, markdown, clickable timecodes, PDF/text export).
- Fully editable keyboard shortcuts — rebind any transport/marking/app action
  in Settings → Commands; the ⌘K palette reflects live bindings.
- Settings backup: export / import all preferences + shortcuts to a JSON file,
  plus reset-to-defaults. Collapsible chevron sections across every tab.
- Caption controls: legible system-font dropdown (default Verdana), numeric px
  size, background opacity, text colour; speaker label above, left-aligned.

### Security & hardening
- Per-session capability token on the loopback media proxy (SSRF/local-snoop
  protection), upstream scheme validation, `-ss` input clamping.
- Two adversarial review waves (92 findings adjudicated): packaged-app
  sidecar path fix, pop-out panel permissions, UTF-8 panics, cancel-path and
  JobRegistry gaps, stale-file scans, entity decoding, ~50 more.
- All sidecars are self-contained static builds enforced by `otool -L`
  guard rails; binaries assembled locally via `npm run setup` (not in git).

### Infrastructure
- CI: tsc, vitest, cargo check/test/clippy (zero-warning policy), swift build.
- Generated TS bindings from Rust structs (ts-rs); typed `AppError` surface;
  build-ID handshake against stale binaries.

[0.1.0]: ../../releases/tag/v0.1.0
