# Changelog

All notable changes to Sauce Bunny. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [Unreleased]

## [0.4.3] — 2026-08-24

An adversarial verification of 0.4.2's own release notes found 18 claims
that were ahead of the build; the real ones are fixed below. Beyond that: a
CTO-level audit of the live co-review path (35 verified findings, ranked in
`docs/LIVE-REVIEW-AUDIT.md`), the first performance pass from it, the
in/out marks becoming one glyph everywhere, and the web section learning
the Library's language.

### Fixed

- **A paused frame-step now reaches the whole room.** Stepping to a frame
  while paused is the core review gesture, and it never crossed the wire: a
  24-30fps step is an order of magnitude under the scrub threshold the
  paused chase keyed on, so guests froze on the previous frame while notes
  were made about one they were not seeing. The chase now distinguishes
  "the host moved" from "the host moved far"; a motionless presenter still
  never yanks a browsing guest.
- **The first drawing on a video was blocky and fat.** The annotation
  canvas sizing effect ran once, before the canvas existed, so the first
  draw rasterized into the HTML default 300x150 buffer stretched across the
  whole monitor (~8x upscale on retina). All the correct DPR math was
  already there; it just never ran on the first-use path.
- **"Add to queue" from a transcript selection queued the PREVIOUS marks**
  (a same-tick stale closure); **Reveal in Past screenings was dead on
  every row** (filename looked up in an id-keyed index); **a source switch
  marked the in-flight export "Failed"** instead of cancelled; **the label
  tool drew over a moving frame** (only the pen paused playback); **an
  export failure left the Export button disabled** until the source was
  reloaded; **re-opening the same source erased its stored in/out marks**
  (the restore latch never cleared); **a locked review store warned
  nobody** (its report fired before anyone subscribed and was dropped);
  **Ctrl still meant ⌘ in two hand-coded listeners** (transcript find,
  Library select-all).

### Changed

- **The in/out mark is one glyph everywhere.** The transport buttons, the
  timeline solo marks, the selection band, the reader bar pins and the
  queued ranges all wear the same chevron; the queued range keeps its
  status colour. Clear in/out is the Avid dialect (the pair side by side,
  inverted). The film inside a selection dims so the marker colour reads
  over bright footage.
- **The annotation toolbar is a 34px pill instead of a 290px sheet.** Icon
  tools, one colour well with a popover palette, and a size preview that
  shows the EFFECTIVE stroke for the active tool - width multiplier,
  opacity and colour - with the numeric value beside it.
- **"From the web" learned the Library's language.** The same browser bar
  (fixed location label, "Date fetched", scoped search), a real list view
  with sortable NAME / Site / SIZE / FETCHED columns and drag-resizable
  widths, and sorting/search with the folder pane's exact semantics.

### Added

- **Web collections.** File any cached web clip into named collections from
  a "+" on its card; collections fold above the automatic site shelves. A
  filed clip leaves its site shelf; deleting a collection costs only the
  label. Organisation is virtual (nothing moves on disk), stored beside
  Casts and Reviews in Documents, and survives a cache prune - an emptied
  collection says how many clips are waiting to be re-fetched.
- **`docs/LIVE-REVIEW-AUDIT.md`** - the live co-review build review: every
  verified gap ranked by harm, and a 12-item performance plan with proof
  methods.

### Performance

All from the audit, each with its measurement recorded in the commit:

- Offer hashing is parallel (8.4x measured on 2 GiB; a 60 GB master drops
  from ~42s of "Preparing the file…" to ~5s) and re-offering the same cut
  costs a stat instead of a rehash.
- Peer playhead ticks and reaction bursts no longer re-render the whole
  app: ghosts and reactions live in external stores subscribed by the two
  leaves that paint them. A host alone in a paused room went from ~3 full
  App renders a second, forever, to zero.
- Presence traffic drops ~7x while parked (movement-gated with a keepalive).
- Tier B streamed bytes cross userspace once instead of three times (the
  pump forwards the transport's own buffers).
- The review composer re-renders once a second instead of once a frame;
  captions re-render once per cue instead of per frame.

## [0.4.2] — 2026-08-23

Thirteen commits of bug-fixing, led by four ways the app could lose work you
had already done. A verified code review and a UX review found most of these;
the rest came out of a storage audit (`docs/DATA-MODEL.md`).

### Fixed

- **Batch transcribe ran every file at once.** `transcribe_local_file` returns
  a job id in milliseconds and does the work on a spawned task, and the batch
  loop treated that return as the work being finished. Selecting twelve files
  started twelve whisper processes, each loading its own copy of the model, and
  marked all twelve done inside about fifty milliseconds. On a 16 GB Mac with a
  large model that is a swap storm; on 8 GB it is an out-of-memory. Stop was
  dead for the same reason: the job id was set and cleared inside one turn, so
  there was nothing left to cancel. It now waits on the `transcript-done` event
  for its own job, one file at a time, which is what the module has claimed to
  do since it was written.

- **Two windows sharing casts.json, and the last writer erased the other.** The
  speaker roster lives in a view both the main window and the floating panel
  render, and each wrote the whole file on every change. Whichever saved last
  erased everything the other had added, with no error and no way back. The
  store now re-reads and merges before overwriting, tracking what this window
  added and what it deleted so a merge can tell "I never had this" from "I
  deleted this", and a successful write tells the other window to re-read.

- **Turning a tag colour off deleted every tag wearing it, from Finder.** The
  remove branch dropped every tag matching the colour, so a tag you had named
  and coloured red was permanently removed from your real file by clicking the
  red swatch to turn red off. Only a tag named after its colour is removed now;
  anything you named keeps its name and loses the colour.

- **In/out marks are remembered.** They were the only hand-made thing in the
  workspace that was not: nulled on every source switch, and gone on quit,
  while chosen posters, timecodes, chapters, review notes and the whole clip
  queue all persist. Stored in frames, keyed the same way reviews are, so a
  renamed file keeps its marks, and clamped on restore in case the source got
  shorter.

- **A store file from a newer Sauce Bunny is no longer silently rewritten.**
  Every file store stamps a schema version and nothing read it back, so a file
  written by a newer build was parsed under today's rules, its unknown fields
  dropped, and the result written back over your Documents folder. Such a file
  is now read as far as this build understands it and never written, with a
  banner saying why.

- **New Project created a folder nothing could show.** The shelf derived its
  folder list from a scan that returns files, so a project existed only once
  something was already filed in it. On a fresh install every project is empty
  by definition, so the button did nothing on every press. Related, and fixed
  with it: `projects.json` was written to the default library rather than the
  one in use, so pointing the library at an external drive filed the metadata
  away from the folders it described; renaming a project orphaned every speaker
  name and history entry inside it, both keyed by path; and a case-only rename
  was refused as a collision with itself, because APFS is case-insensitive.

- **The MP3 export could not be stopped, then reported success.** The encode
  ran with no registered process handle, so Stop did nothing and the export
  finished anyway.

- **The export queue could stop mid-run and stay stopped.** Loading a different
  source while the queue ran left the runner waiting on a callback nothing
  would make: no error, no failed row, no way to restart short of relaunching.
  A failed row also had no way back, since nothing could set it to queued
  again and only queued rows persist, so quitting dropped it. There is a Try
  again now.

- **An export failure took the video with it and blamed the wrong thing.** The
  running player unmounted and was replaced by "Couldn't resolve source" over a
  file that had resolved fine, with no Dismiss and no Retry, and the only way
  back cleared the marks that produced the export. Export faults no longer
  touch the source.

- **A long local clip export failed instead of using the other path.** Past
  4 GB the in-app converter throws, and the export reported the raw
  `ArrayBuffer exceeded maximum size` after running the whole conversion. A
  size that does not fit now routes to the ffmpeg pipeline beside it, which
  streams and is doing the same lossless copy, and is checked before the
  conversion starts rather than after.

- **A failed co-review join disabled Join until you quit.** Pasting a wrong or
  expired code left the button stuck on "Connecting…" forever, which is the
  ordinary first-run mistake.

- **The raw proxy route skipped its upstream check.** Its two siblings validate
  the target; this one checked only the scheme, so a payload naming a loopback
  port, a private address, or a URL carrying credentials was fetched and
  streamed back. The capability token still stood in front of it, so this was
  defence in depth rather than an open door.

- **Ctrl is no longer treated as ⌘.** macOS binds the emacs line-editing keys
  in every text field, so Ctrl+K in the URL bar or a comment box opened the
  command palette on top of what you were typing. Every shortcut this app
  publishes is written and shown as ⌘; a Ctrl combo now falls through to the
  system.

- Chapter and comment pins that fell close together could draw on one pixel,
  because the merge compared against the last pin emitted rather than the last
  of that kind. The delete control on review comments was named "✕" to a screen
  reader, and a developer smoke test shipped as a permanent row in every
  command palette.

### Added

- **A transcript selection can become a clip.** Right-clicking selected cues
  now leads with "Mark in/out from N lines" and "Add to queue", using the end
  of the last cue. Cutting a quote you had just found previously meant marking
  the first line and then scrubbing for the end, because clicking the last line
  seeks to where it begins.

- **The export folder has a default** (`~/Movies/Sauce Bunny`). It was the one
  setting with none, and export requires it, so the primary button in the app
  sat disabled on a fresh install.

- **Past screenings are reachable.** Every co-review has always written a full
  record of the session to `~/Documents/Sauce Bunny/Screenings/`, and nothing
  in the app could open one. There is a list in the co-review lobby now, with
  Reveal to open the file.

- **Marker export is in the command palette**, keyworded by every NLE it can
  write for. It could write Avid, Premiere, Resolve, Final Cut and CSV from
  behind an unlabelled glyph, inside a tab, inside a drawer, and appeared in no
  menu, palette or shortcut sheet.

- **The Transcripts view can accept a transcript.** On a fresh install the view
  named Transcripts offered search, sort and filters over "No transcripts yet"
  and no way to add one, and dropping an .srt was refused with "Transcript
  needs media", which was never true. It offers Import and Make one in Clip,
  and hides the filter chrome while there is nothing to filter.

- **The first speaker-detection run says it is downloading**, rather than
  showing the same "Loading speaker models…" for a cached run and a several
  hundred megabyte fetch with no percentage behind it.

### Changed

- **The in/out mark is a chevron rather than a bracket**, everywhere a clip
  mark is set or shown: the transport buttons, the timeline, the marked region,
  and the reader's position bar. The comment-range tool keeps the bracket, on
  purpose, since it is drawn on the same track in a different colour.

- **A comment is stamped with the frame you were looking at.** The time was
  read when you pressed Enter, so a note typed while the video kept rolling
  landed wherever the playhead had drifted to. It is latched on the first
  keystroke now, and shown latched. Drawing pauses playback for the same
  reason: the frame moved out from under the stroke while it was being made.

- **"Media never leaves each machine"** is gone from the co-review lobby, which
  is the screen where you are about to send media to another machine, and on a
  relayed path it passes through a relay. It says what is true and still
  reassuring: no server sees it, no account, no upload.

- Reveal in Finder on a transcript card shows the transcript, not the source
  video whose poster the card wears.

- The floating panel no longer reads the whole review store at boot for
  something it cannot open.

## [0.4.1] — 2026-08-23

### Changed
- **One design system, applied everywhere.** The interface used 29 font sizes,
  14 line heights, 18 letter-spacings, 27 z-index values and 22 transition
  speeds, most of them one-offs nobody chose. They are now a named scale, and
  the visible effect is small but real: a few sizes shift by half a pixel,
  some corners by one, and a handful of animations settle onto a shared speed.
  Nothing was redesigned — the drift was corrected toward what the majority of
  the app already did.

  One fix you may notice: fifteen labels asked for a medium font weight the
  app never loaded, so the browser silently substituted regular. They now say
  regular, which is what they always rendered as.

- **Join codes read as join codes.** Every invite began `SAUC-endpo-intXX`,
  because every iroh ticket starts with the literal tag `endpoint` — and the
  host's chip truncates, so eleven of the twenty-one characters actually on
  screen were identical in every session the app has ever hosted. The tag is
  dropped for display and restored when a code is pasted, the body is shown
  uppercase in groups of five, and the chip now cuts on a group boundary
  instead of mid-group. A code went from 79 characters to 70, and all 70 of
  them say which session.

  Pasting is unchanged and still accepts everything: dashed or not, upper or
  lower, with or without the `SAUC` handle, wrapped across the line breaks
  chat apps add.

  **One compatibility note.** A code produced by this build will not be
  accepted by a build older than it — the previous parser did not lowercase,
  so it hands the uppercased body to iroh unchanged and the dial fails. Codes
  from older builds still work here. No release has been published, so this
  affects only locally-built copies, but it is the sort of thing that is
  cheap to say now and expensive to discover later.


## [0.4.0] — 2026-08-22

Transcripts got somewhere to live. The panel that lists them now has projects
you can name and recognise, and the follow-along player shows where the marks
are instead of only what time it is.

### Added
- **Projects in the Transcripts panel.** The list grouped by whatever folder a
  file sat in, which was almost always the `YYYY-MM` bucket the app made on the
  day you hit transcribe. That is filing by accident. A project is a folder you
  name, and its heading is a shelf: a picture, the name, the count, and a menu
  to rename it, choose its picture, or delete it. Month buckets keep the quiet
  label and get no menu, because offering Delete on `2026-08` is offering to bin
  a month of work nobody chose to group.
- **A picture for a project.** Any transcript in it can supply the picture;
  without a choice the project shows its newest, which changes as you add to it.
  The choice falls back automatically if that transcript is later moved out, so
  a header never points at something filed elsewhere.
- **Markers on the compact player.** The reader's follow-along panel now draws
  the in/out band, chapter ticks and comment dots on its position bar, each one
  a button that jumps to its exact time. It shows chapters and comments for
  whatever transcript you opened, and in/out marks only when the reader is
  looking at the source Clip has loaded — those marks belong to that source, and
  drawn on another recording's bar they would be real marks about something
  else.

### Changed
- A project folder can be renamed or deleted from inside the app. Deleting is
  deliberately not recursive: it refuses while transcripts are still in there
  and says how many, because a project holds hours of work and a one-click
  recursive delete gets reported as data loss, not as a mis-click.

## [0.3.0] — 2026-08-22

Local AI got dramatically faster, YouTube breakage became self-repairing, and
the app can finally tell you which build you are running.

> Versions 0.2.1–0.2.9 were development builds produced during one working
> session and were never released. Their changes are folded in here rather than
> given entries of their own, because a version nobody received is not a
> version. Build identity is carried by `CFBundleVersion` (`YYYYMMDDNN`), which
> changes on every build; the semver moves only when the feature set does.

### Added
- **Pages that only reveal their video to JavaScript can now be imported.** A
  modern site returns an empty shell and fetches its video from script, so
  yt-dlp reads the HTML, finds nothing, and says "Unsupported URL" — measured on
  one real page: zero media URLs in 306 KB of served HTML, and a playable
  manifest the moment a browser ran it. When that specific failure happens, the
  page is rendered in an isolated, invisible webview, the media it requests is
  taken, and the import continues with that. The resolver window is granted no
  capabilities and gets no IPC channel.
- **Live shared drawing in a co-review session.** Strokes relay to the room as
  they are drawn, so two people can point at the same frame at once. Each stroke
  carries its author, undo removes only your own, and the picture converges no
  matter what order the network delivers ops in.
- **Real drawing tools.** Pen, highlighter (translucent and broad, so the frame
  underneath stays readable), arrow, rectangle and ellipse. Shapes rubber-band
  from a drag instead of being traced freehand, which is why annotations used to
  look scrawled.

- Chapters fold away and can be cleared.
- The reader's transcript menu gained Reveal in Finder, and its rename dialog
  no longer draws underneath the app.

- **The audio path reports whether it is audible.** A track that decodes and
  never reaches the speakers used to log exactly like success. It now states
  chunks scheduled vs dropped, context state and gain, once per playback.

### Fixed
- **The Safari sign-in prompt is no longer a dead end.** It asked for Full Disk
  Access — a permission over every file on the Mac — when Safari is the only
  browser that needs one. If Chrome, Brave, Firefox or Edge is signed in, it now
  says so and points at the one-click switch instead. When there is no
  alternative it tells the truth about the relaunch macOS requires, rather than
  "load the video again", which sent people back to the same failure. And if
  access does appear while the app is running, it says so.
- **YouTube downloads work again on the bundled downloader.** The pinned yt-dlp
  was 2026.07.04, whose default player-client list still included `android_vr` —
  the client YouTube started refusing with `HTTP Error 403`. Refreshed to
  2026.08.19, which drops that client and adds `web_embedded` fallbacks.
  Verified with no JS runtime on PATH: 2160p, and `android_vr` no longer
  appears at all.
- **The Transcripts panel is searchable, sortable and filterable.** It was a
  flat list grouped by folder, so finding one transcript among a hundred meant
  scrolling past every month you had ever worked in. It now has a debounced
  search (over the title and the folder), sort by newest / oldest / name /
  largest, chips for Speakers and Analyzed, and an honest "3 of 105" count.
  Searching collapses the month headings so matches are not scattered across
  them.
- **A folder you named yourself keeps its name.** Any folder that was not a
  `YYYY-MM` month was labelled "Other", so a folder created with "Move to
  folder…" looked like the app had lost it.
- **Frame annotations draw a smooth line, not a blob.** Stroke width was driven
  by how fast your hand moved: only position was recorded, so the renderer
  invented pressure from velocity and a single circle came out as a lumpy
  sausage. Fast strokes were also built from a handful of samples, because
  macOS coalesces pointer events — so their outlines showed straight segments
  and read as jagged. Pen pressure is now captured and used when there is any,
  every coalesced sample is kept, and the brush starts finer.
- **A fresh link no longer opens with someone else's in/out marks.** The
  timeline drew a band for every clip in the export queue, and the queue is
  cross-source by design — so a clip queued from one video put its marks on the
  next video's timeline, at frame numbers reinterpreted against a different
  fps. It now draws only the queued clips belonging to the loaded source.
- **Export works with only one mark set.** Pressing `[` without `]` disabled the
  Export button with no explanation, even though the export path has always
  supported an open-ended range ("in to the end", "start to out").
- **The full-screen button works.** It had never been granted the window
  capability it needs, so every click was rejected and swallowed by a `catch`.
  The button looked simply inert: no error, no log, nothing to search for.
- **Answers stop instead of running for minutes.** Nothing capped generation, so
  "give me the best quotes" produced 4,989 tokens — five and a half minutes of
  text arriving on a 27B. Each surface now sets a ceiling, and the summary's
  scales with the Length setting, so Brief cannot quietly cost what Detailed
  does.
- **The Summary Style controls fit their pane.** The "Detailed" pill was clipped
  by the modal edge.


- **The "Update yt-dlp & retry" offer now appears for the commonest YouTube
  failure.** yt-dlp reports it as `unable to download video data: HTTP Error
  403: Forbidden`, which names no host, and the detector required a YouTube
  host in the message itself — so the branch written for stale YouTube URLs
  could never fire on the error YouTube actually produces. It now takes the
  source URL as context.
- **A missing JavaScript runtime is no longer treated as a stale extractor.**
  No yt-dlp version fixes it, so offering an update was a dead end.
- **yt-dlp can be updated to nightly when stable has not caught up.** Extractor
  fixes reach nightly days before stable; in that window an update returned the
  identical version and the app claimed "engine is current". A stable update
  that changes nothing now says so, and offers the nightly build.
- **Every JS runtime yt-dlp supports is enabled**, not only deno. A Mac with
  node or quickjs was falling back to a low-resolution player client while a
  working runtime sat on its PATH (measured 360p → 2160p).

- **Local AI answers arrive in seconds instead of a minute.** Every feature now
  shares one transcript prefix, so llama.cpp reuses the KV cache across the
  summary, the chapters and each chat turn (measured 60.92 s → 0.13 s on the
  second feature).
- **The summary reads the whole video.** It used to truncate to the first
  portion, so on a long video it answered from the beginning and could not know
  the rest existed.
- **Local models run at full speed.** Threads now match the performance-core
  count rather than every logical CPU (37.7 → 83.8 tok/s), and chain-of-thought
  is off for extraction tasks, which had been spending thousands of tokens
  reasoning before answering.
- **A running chapter detection can be stopped.**

- **Hidden warnings can be brought back.** Four "don't show me this again"
  flags — the rename-writes-to-disk warning, the first-run tips, and two
  per-transcript notices — were one-way doors: ticked once, and the only route
  back was deleting a key from localStorage by hand. Settings ▸ Backup & reset
  now restores them all, and a contract test fails if a fifth is added without
  one.

- **The cue right-click menu survives a big cast.** Past six reassignment
  targets they collapse into an "Assign to speaker" submenu with a filter,
  instead of one row per person running off the bottom of the screen and
  pushing Play and Clear speaker out of reach.
- **The reassign list is ordered by talk time**, like every other speaker
  surface. It alone used the roster's first-appearance order, so it showed
  Speaker 16 above Speaker 8 whenever 16 spoke first and scattered named
  people among unnamed ones.

- **The WebCodecs decoder toggle works.** Its description has always said
  "Disable if local files won't play"; it was read only for thumbnail
  extraction, so turning it off changed the poster and not the playback. It now
  routes local imports through ffmpeg-prep as promised — which is the way out
  of a file that decodes with a perfect picture and no sound.
- **Builds are distinguishable.** Four DMGs shipped as `0.2.0` with a build
  number stamped in July. The version is stamped on every build and the About
  tab shows the build number it always claimed was the distinguishing one.

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

### Co-review (P2P watch party) — new, continued

*(The fixes to this feature are under "Co-review" further up in this
release; the two sections were written at different times.)*
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
