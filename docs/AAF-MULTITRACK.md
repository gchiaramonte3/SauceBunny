# Multitrack AAF transcription

Multitrack is a separate local workspace beside Transcripts. It reads an AAF
without modifying it, presents its audio lanes on the sequence time axis, and
runs Whisper or Parakeet independently on selected microphone tracks. It does
not run speaker diarization or change Clip, Review, NDI, or capture playback.

## Reading and timing

The `saucebunny-aaf` helper uses pinned pyaaf2, packaged with its own Python
interpreter. Python is a build dependency, not an installation requirement for
the app. The worker accepts explicit inspect, index, extract, and waveform commands;
it is not a server and does not accept arbitrary Python code.

Import supports embedded PCM/WAV and offline/linked audio graphs, including
group selectors and nested compositions. Selected sequence tracks open first;
disclosures reveal alternative microphones, initially muted and unchecked.
Offline audio is unavailable, never substituted with timeline silence. Audio
Pan/Gain wrappers expose raw isolated microphones with a disclosure in settings;
other processing and transitions retain identified unavailable spans. Malformed
graphs and cycles are rejected. This is not an Avid mixdown renderer.

Linked WAV/BWF and PCM MXF are resolved only from local locator paths, mounted
volumes, or a user-selected file/folder. Multitrack settings contain Locate media
and Refresh availability. File URLs are decoded, exporter prefixes before
`/Volumes/` are recognized, and document-local prefix mappings are remembered.
Candidates must match PCM format, channel count, bit depth, duration, and MXF
file-package identity when supplied. Duplicate matches require an explicit file
choice. Ancestor recorder-WAV references retain their different time origins;
they are not guessed as substitutes for trimmed Avid MXF. No server is mounted,
no credentials are requested, and network URLs in metadata are never opened.

The graph manifest is v2, saved documents v3, and the embedded PCM index v2;
older embedded documents remain readable. Original track IDs, labels, cast
snapshots and transcripts survive compatible migration. New branch IDs depend
on graph identity, not editable labels. A relink invalidates decoded caches and
late recognizer responses while preserving already committed transcripts.
There are separate limits of 64 sequence audio tracks and 256 expanded lanes.
Multiple top-level sequences are selected explicitly before import.

An AAF is a graph of clip references, not a list of audio files to concatenate.
Extraction follows source trims and sequence positions, removes unused handles,
and inserts silence for timeline gaps. Rational edit rates remain rational in
the reader and Rust domain. Recognition cues use source-relative 16 kHz sample
positions; source timecode is formatted only at the presentation/export boundary.

Waveforms are generated outside the webview and cached as a binary min/max
pyramid. A base bucket contains 256 native samples; each parent preserves the
extrema of two children. Settled zooms read a small portion of the appropriate
level, not another PCM extraction. Up to eight recent views are retained in the
frontend; dragging cancels optional refinement and keeps the overview visible.
The lanes reuse Clip's DPR-aware canvas, with purple ink scoped to Multitrack.
Canvas rendering is memoized independently from playhead and hover updates.
Each track's audition gain scales its painted min/max envelope, including
zoom-detail replacements, without changing or rereading the cached source peaks.
Attenuation shrinks it, silence leaves the centre axis, and boosts are bounded
visually at the lane's full-scale edges. The waveform represents per-track gain,
not master monitoring volume or the mix's track-count attenuation. Solo/Mute
keep their existing tint/opacity treatment rather than erasing the waveform.

Audition schedules the enabled microphones together on one AudioContext clock,
not twenty independent media-element clocks. Python resolves the AAF graph and
coalesces embedded-stream extents once. Rust validates that index against the
source fingerprint, reads bounded PCM windows directly from the original file
opened read-only, and releases the read lock between blocks. No new transport,
audio framework, permission flow, or full-track PCM export is introduced.
Two five-second decoded windows and a two-reader queue bound preparation; the
next window is scheduled ahead of its boundary. Opening a document or settling
a paused seek silently warms the parked window and its next window. Seek and
Play never wait for that optional look-ahead. If delivery falls behind, the
clock holds at the last covered boundary with Play intent retained; the matching
ready block resumes playback. Pause, a new seek or disposal rejects that late
resume. Pausing cancels unfinished work but retains completed buffers.
Obsolete queued windows are cancelled before starting native work.
Embedded-only audition retains native sample rate/bit depth. Linked sources use
bundled FFmpeg to isolate the mapped channel into bounded 48 kHz/24-bit PCM
windows, then enter the same mixer. There are at most two native preparation
jobs and one Multitrack recognizer. ASR uses the existing 16 kHz mono conversion.
Solo is additive and toggleable; Mute is independent. A changed parked
mix stays silent. Scrubbing uses Clip's short, faded audio-grain policy and never
waits for decoding to move the playhead. Cold audio still requires preparation.
Transcription works in bounded chunks rather than making a second full copy of
every track in advance.

Group alternatives have independent waveforms, audition, selection and saved
results. Opening a disclosure starts optional waveforms but never playback or
recognition. Different microphones can be deliberately mixed; identical
parent/child source mappings are deduplicated. TXT/CSV/PDF/SRT exports identify alternative
provenance; Avid markers for alternative lanes are deliberately unavailable.
Root sequence markers keep their original A1/A2/etc. destinations.

## Track-first controls

The transcript arrow occupies a fixed 28 px column beside the person tabs,
never over them. **Search with AI** is off by default. Text mode filters
immediately; AI mode searches by meaning after Enter or Search, using the
installed local model selected for AI Summary (with its installed fallback).
It never downloads a model or sends transcript text to a cloud provider.
Search covers the selected person's mics, or all mics in All voices, including
text needing timing review. Large transcripts are searched section by section;
Stop/error reports partial coverage rather than claiming an exhaustive result.
Results retain original wording and timing, and untimed text stays unseekable.
Editing the query, switching person/document/model, leaving Multitrack or
disabling AI cancels obsolete work. Exports still cover the selected transcript,
not just the current search results.

Timecode and transport sit centered above the tracks. Audio scrub defaults on;
waveforms and per-track ASR text overlays can be toggled. Small/Medium/Large lane
heights and playhead-centered zoom use the existing app controls. Small fits the
20-track fixture at 1920×1080 with text overlays off; smaller windows still scroll.
JKL uses Clip's signed shuttle ladder, K stops, K+J/L and arrows step frames.
Rewind and fast-forward buttons flank Play and use the same signed ladder.
Small rows are 30 px with 24 px controls and explicit border-box sizing. General
form styling cannot override these smaller controls. Timeline surfaces use the
arrow cursor; an owner field uses a text cursor only while being edited.
Editable fields and dialogs retain their own keys.

The top **Save Mic Owners as Cast** button opens the existing-style modal;
**Save cast** is enabled as soon as a nonempty name is
entered; microphone-label acknowledgment is no longer a Save or Generate gate.
Checked tracks select transcription independently of Solo/Mute. The normal UI
generates the whole sequence, including on reruns; the underlying range API is
retained without the start/end form. Engine/model remain visible. Technical raw
audio and import/timing notes live in the settings button beside Import AAF.
Text overlays use genuine segment bounds when zoomed in. Wide views aggregate
nearby passages into readable counts instead of tiny text slivers; the tooltip
previews their text. Neither view invents per-word alignment.

Soloed lanes use stronger purple while nonsoloed waveforms become grayscale.
Each track has a volume control independent of the master output, Solo, Mute,
and transcription selection. Changing a level does not restart or re-decode
the mix. The track's right-click/ellipsis menu can regenerate only that track
with another installed model, download its text, or export its Avid markers.
The saved result stays intact until regeneration succeeds.

## Person transcripts and exports

The right pane opens on the first person with saved text, unless the user has
chosen a tab. Person tabs use the existing Clip tab style; arrow keys and the
overflow picker reach every person. **All voices** keeps the combined view.
Explicit cast identity groups assigned microphones; otherwise equal assigned
owner labels group, while unassigned microphones stay separate. These are mic
assignments, not verified speaker identities.

Export supports the current person or the whole transcript in plain text, CSV,
Avid markers, SRT captions, and PDF / Print. **Entire transcript** honors the
selected format, independently of search, Solo, or the currently viewed person.
Text, CSV and PDF include text needing timing review. Avid and SRT omit those
unplaced passages and disclose the count. Avid files by person writes one file
per person in a chosen folder. Bulk files use atomic, unique writes, so existing
exports are not overwritten; partial failure reports the destination folder.

Avid TXT uses the existing shared serializer: username, source-sequence timecode,
audio track, color, and comment, separated by tabs with no header or BOM. The mic owner
is the username. Rational cue-start samples are converted to source frames and
offset by the AAF's sequence start; passages on the same track and frame merge
instead of being moved. This is estimated ASR segment timing, not word-perfect
alignment. New imports preserve `PhysicalTrackNumber` as optional
`physical_track_number`. MobSlot IDs are **not** audio-track numbers (the supplied
AAF has slots 10/11 for A1/A2). Older documents retain their original full-manifest
lane order, with that fallback disclosed after export. Filtering by person never
renumbers tracks. No source AAF or saved document is rewritten. Import into the matching sequence in Avid's
Markers window. The format follows the
[Avid Media Composer editing guide](https://resources.avid.com/SupportFiles/attach/Media_Composer/Media_Composer_v2025.x_Editing_Guide.pdf).

SRT starts at sequence-relative zero, not record timecode or the first spoken
word. Sample timestamps round to milliseconds. A boundary sweep combines
simultaneous mic-owner lines into non-overlapping captions, since SRT has one
caption lane. Untimed text never receives invented timing.

PDF / Print reuses the escaped transcript print template, original sequence
timecode and audio-lane labels. A separate script-disabled native webview opens
the macOS print dialog: choose **PDF > Save as PDF**. It has no IPC capability,
external navigation or network content. Opening it does not claim a file was
saved, and nothing is sent to a printer without confirmation.

Export verification (2026-09-15): the full verification gate passed (4,230
frontend tests, 723 native unit tests, 437 Chromium cases, with the existing
skips/ignored cases retained), plus 25 reader tests and two focused WebKit
export cases. Permanent regressions cover original/gapped audio-lane numbers,
legacy imports, person filtering, same-frame microphones, fractional/drop-frame
timecode, format selection, cancellation, HTML escaping and overlapping SRT
captions. An isolated native WKWebView asynchronous print test produced a
seven-page generated PDF; all 60 timed passages, 20 lanes and one untimed passage
survived extraction and visual review. No printer submission, real Avid marker
import, installed-app replacement or DMG packaging was performed in this pass.

Follow-up export recheck (2026-09-15): a read-only inspection of the supplied
20-track AAF confirms MobSlots 10–29 map to A1–A20, with BOMBETTE on A1 and
NATHANIEL on A2. A permanent synthetic regression also reverses the manifest
and transcript order and verifies that full/person-only exports retain those
physical lanes. All 30 focused frontend checks, 25 reader checks and two WebKit
export cases passed, along with all 437 Chromium cases (four existing skips).
TypeScript, lint and native production compilation passed. At that checkpoint,
separate unfinished Library-organization code failed three frontend source
contracts and referenced an unavailable `tempfile` crate in native tests.

Earlier focused recheck (2026-09-15): 30 frontend export tests, 25 reader tests,
30 native AAF tests (four fixture-dependent cases ignored), the native print
restriction test, and both WebKit export interactions pass. TypeScript passes.
The Library path/store contracts and native compilation now pass, but three
unconnected Library components still fail the component-reachability contract.
The export implementation is verified in source; the whole worktree is not yet
release-certified. No installed application, source AAF, or DMG was changed.

Subsequent Library integration resolved those source-contract failures and
passed the full verification gate, including the existing export tests. Saved
Multitrack references now open the existing workspace without interrupting an
active operation. See [LIBRARY-ORGANIZATION.md](LIBRARY-ORGANIZATION.md) for the
final acceptance evidence and the unchanged packaged-app testing boundary.

## Names and speech accuracy

Detected microphone names are editable and can be associated with the existing
Cast roster. A microphone assignment identifies the source of the recording;
it is not proof of who spoke every line. Nearby voices, applause, and quiet
recordings can produce bleed or hallucinated text. No automatic cross-track
deletion, “loudest microphone wins” rule, or confident speaker attribution is
introduced here.

Recognition timing is estimated. The reader's source-to-sequence mapping and
an ASR engine's ability to hear and time words are separate contracts. Raw
Whisper VAD token timestamps are not used: local testing found compacted-time
tokens that did not match the original audio coordinate system.

## Work ownership and persistence

Native commands return typed `AppError` results and export their contracts to
`src/bindings/` with ts-rs. Each operation owns a job ID before its first await.
Stop cancels the active worker and prevents queued transcription from starting;
terminal saves are serialized with cancellation. A successful native reply means
the result is already committed: Stop cannot discard it from the current run's
pane or saved count, even if the reply arrives after the click. A source change
or unmount still rejects the old run's callbacks. An empty successful transcript
is distinct from a decoder failure, malformed output, or cancellation.

Documents and labels are versioned and saved atomically. Each document's label
writes remain queued across navigation; reopening waits for those writes and
re-reads if a newer edit overlapped the read. An older snapshot cannot overwrite
an unrelated owner edit on the next save. Cached audio and
waveforms are replaceable; the source AAF is never written. Results retain
their processed range, engine, and model. Re-running a track replaces that
track's previous result, with the replacement explained before generation.
No result is represented as full-track coverage merely because a short selected
range completed.

## Evidence from the supplied AAF

Read-only analysis of `AFF BANK 1 Test_Collapse.NoGroups.Copy.01.aaf` found:

- 20 microphone tracks, three clips per track, 60 embedded mono 48 kHz/24-bit
  streams, and a 24000/1001 edit rate with 24-frame non-drop timecode.
- Sequence start `18:40:18:23`, duration 146759 frames (about 102 minutes).
- Microphone labels in MasterMob `UserComments.TRK1`, not the blank track slots.
- Different roll boundaries for the two recorders and unused 20-frame handles.

Independent sample-bound and excerpt checks validated the clip mapping. Both
installed engines were exercised on excerpts from all 20 tracks, plus silent,
invalid-input, known-gap, and cancellation controls. Those checks do **not**
certify every word in the full recording or establish frame-accurate ASR.

Original SHA-256 before and after that read-only analysis:
`119d3d61fcdcb5ca7f93a33de08d080f55dc1d26ee8124babff64ff4146261a3`.

## Verification

`npm run test:aaf` exercises generated AAF fixtures without private footage.
The normal `npm run verify` includes it alongside frontend, Rust, Swift, and
browser tests. `npm run build:aaf` builds the self-contained worker; bundle
verification must also prove it runs without Homebrew or an external Python.

The build recipe requires CPython **3.12.14** on the build Mac; set
`AAF_PYTHON` to that interpreter if it is not named `python3.12` on PATH.
The normal app packaging wrapper rebuilds this first-party helper before Tauri
bundles it, so an older copied executable cannot silently ship with a newer
frontend. As with the other locally compiled sidecars, review and re-pin the
resulting binary before a release.

### Desktop validation record, 2026-09-14

- The supplied 20-track AAF imported in the packaged WKWebView test app;
  named lanes, generated waveforms, and `18:40:18:23` source start were visible.
- The frozen reader inspected that same AAF and extracted an 80-frame range
  across the first recorder join using only `/usr/bin:/bin` on PATH. The mono
  48 kHz WAV contained exactly **160160 samples**, and waveform data was produced.
- A controlled test killed only its own PyInstaller bootloader during peak
  generation. The worker exited within **35 ms** and did not commit an output.
  Source size and modification time were unchanged.
- Browser interaction tests passed at 1100×740 and 1680×1020. They cover import,
  label confirmation, transcription results, search, seek routing, accessible
  controls, and overflow. They use IPC mocks, not native ASR.
- The full verification script passed every gate. Final frontend unit checks
  recorded 4095 passes and two skips; the browser suite recorded 423 passes and
  four skips. The separate design catalog recorded 35 browser passes and passed
  production-build isolation. The opt-in real-file Rust reader/PCM contract test
  also passed, in addition to the synthetic reader fixtures and normal Rust suite.
- Import-during-transcription guards and model rechecks on return from Settings
  are saved, regression-tested, and included in the separate `Sauce Bunny
  Multitrack Ready.app` under `src-tauri/target/debug/bundle/macos/`. It was not
  launched and the older open test executable remained byte-for-byte unchanged.
  Close the older test app before opening the candidate; both use the same
  saved Multitrack documents.
- Candidate packaging compared the current JS/CSS bytes with their exact Tauri
  compressed payloads in the native executable, rather than checking only a
  version label. Deep signature verification passed. Deno and ffprobe required
  local ad-hoc signature repairs in the candidate only, preserving their signing
  metadata; repository binaries and the older app were not changed. The AAF
  helper matched its verified pin and its bundled license notices matched source.
  This is an internal AAF test artifact, not a notarized release or an NDI/OBS
  distribution acceptance result.
- The user elected to perform the remaining desktop engine/audio/Stop checks.
  Real app-launched Whisper and Parakeet completion, audible solo output,
  mid-batch Stop, and reopen/export are **not yet signed off**. Earlier command-line
  ASR excerpt tests are separate evidence, not a substitute for that sign-off.

Before declaring the workspace ready, test the actual desktop build: import the
large supplied AAF, inspect lane placement, audition around a roll boundary,
transcribe a bounded spoken range with both installed engines, Stop mid-batch,
reopen saved names/results, and export quoted Unicode CSV/text. Browser IPC
mocks cannot prove those native behaviors.

### Toolbar revision verification, 2026-09-14

The subsequent toolbar revision removes the earlier label-confirmation gate.
Regression coverage now exercises additive Solo/Mute, checked-track generation
over the full sequence, Save Cast success/failure, JKL and editable-field
isolation, continuous drag feedback, playhead-centered zoom, text overlays,
20 compact lanes, centered transport, and modal focus. The complete browser
suite passed 425 cases with four skipped; the separate catalog passed 35 cases
and production isolation. Native AAF unit tests passed 24 cases with the real-file
opt-in test skipped in that run. These are not a claim of full-recording ASR or
physical-speaker acceptance; the user's remaining desktop checks still apply.

The final frontend unit run passed 4109 cases with two skipped. After the final
mic-label Escape fix, all five focused Multitrack browser cases passed again.
A macOS WKWebView harness also exercised the production audio controller/cache
with generated PCM and fixture IPC. All 20 tones were measured in the single
mixer; their scheduled starts matched exactly. Stop produced digital silence,
parked Solo/Mute stayed silent, scrub toggles worked, and the rational-rate clock
and audio continued across a prepared-window boundary. Late preparation started
no voices after disposal, and both native AudioContexts closed. Its output was
silenced after the analyser: this is native decoding/scheduling evidence, not
a physical-speaker or production Tauri asset-protocol test. An initial detached
webview harness timed out; a background window enabled normal WebKit rendering.

`Sauce Bunny Multitrack Toolbar.app` (internal build `2026091402`, backend ID
`2026-09-14-multitrack-toolbar`) is staged under
`src-tauri/target/debug/bundle/macos/`. Its exact current JS/CSS payloads were
verified inside the native executable, all helper pins were checked with the
previously documented candidate-only Deno/ffprobe signature repairs, and deep
signature verification passed. The older Test and Ready app binaries were
unchanged. The Toolbar candidate launched successfully at its separate test
profile's welcome screen. No transcription or capture was started, and the
installed application was not replaced. This is an ad-hoc-signed internal test
artifact, not a notarized release or DMG.

At the toolbar stage, deferred work included NLE write-back, Avid marker export, word-level accuracy guarantees,
automatic bleed removal, and a full AAF effects renderer. No GitHub or DMG
publication is part of this implementation.

### Waveform and audition performance revision, 2026-09-14

Research favored precomputed min/max data over repeatedly extracting audio for
each viewport: [BBC audiowaveform](https://github.com/bbc/audiowaveform) describes
the peak representation, and [BBC Peaks.js](https://github.com/bbc/peaks.js)
recommends precomputed waveforms for larger media. The existing DPR-aware canvas
is retained; the new multiresolution binary cache supplies its visible detail.
There is no second waveform renderer or new frontend dependency.

For audio, the measured bottleneck was repeated reader startup/extraction, not
the number of output devices. [CPAL](https://docs.rs/cpal/latest/cpal/) offers a
native output callback, but replacing the output engine would not remove those
reads. This revision keeps the [single Web Audio scheduling clock](https://webaudio.github.io/web-audio-api/#dom-audiobuffersourcenode-start)
and moves bounded, indexed PCM preparation into Rust. Standby warming does not
resume the AudioContext or create audible sources.

Measurements on the supplied 20-track, 102-minute AAF on this Mac:

- The previous frozen helper took about **800 ms** to extract one two-second
  track excerpt before the subsequent conversion step. The indexed native path
  prepared **all 20 five-second excerpts in 22–32 ms** across 20 positions in an
  optimized build, with the AAF index already available. This isolates native
  preparation; it does not include Tauri IPC, decoding, or physical audio output.
- Building all 20 complete waveform pyramids took **14.56 seconds** once in an
  optimized build. Subsequent queries for all 20 tracks at each of 11 zoom
  levels took **0.31–5.97 ms**. The first cache build is not instantaneous; valid
  overview data remains available while optional detail is prepared.
- A temporary, nonpersistent macOS WKWebView ran the production audio controller
  with actual native-rate AAF excerpts and fixture IPC. Across **20 warm Play
  resumes**, p95 was **65 ms** to advancing transport and nonzero mixer samples.
  All 20 sources shared their scheduled start; Stop measured digital silence,
  and scheduling continued across prepared-window boundaries. The harness
  silenced output after its analyser. This is not a physical-speaker or packaged
  Tauri asset-protocol latency measurement.
- Native PCM matched the established frozen extractor **byte-for-byte across
  both joins of each recorder**, in addition to a reference interior excerpt.
  Synthetic tests cover rational source offsets, gaps, EOF, fragmented normal
  and mini streams, damaged cache files, cancellation, and peak extrema.
- Compact 30-pixel rows were checked in WKWebView: 24-pixel name and S/M/Text
  controls remained inside each row. Timeline cursor styling is `default`;
  intentional name editing retains a text cursor. Purple waveform styling is
  Multitrack-only. Rewind/fast-forward reuse the J/L shuttle implementation.

Final verification: **4,113 frontend unit tests passed** (two skipped), **425
browser tests passed** (four skipped), and the **35-case design catalog** passed
with production isolation. All **23 Python reader tests** and **27 native AAF
tests** passed. The two new opt-in supplied-file PCM/performance tests also
passed separately. The full Rust suite passed **719 tests** (27 ignored).
Type checking, scoped lint, and all ten
sidecar integrity pins passed. The rebuilt frozen helper's index matched the
source implementation with only `/usr/bin:/bin` on PATH.

No installed application, Home UI, macOS permission entry, source AAF, or saved
transcript was changed by this revision. No new branded test app was created.
The running application therefore still requires a subsequent normal app build
to expose these changes; this source/helper verification is not a release,
installation, or a sign-off of the user's remaining transcription tests.

### Results and timing-review revision, 2026-09-14

The reported red `Speech cue is outside its prepared audio range` message came
from the AAF cue validator, not the waveform renderer. An empty/reversed cue or
a cue beyond its input chunk previously returned an error before the track was
saved, discarding its otherwise usable accumulated result. Both saved documents
for the supplied sequence contained zero transcripts at inspection; there was
no hidden successful result in the normal Transcripts browser. Completed run
work directories are temporary, not an alternative saved-results location.

Timing validation now retains good cues and quarantines text with unusable
timestamps in `timing_issues`, alongside the exact reported timing and source
chunk context. Such tracks are saved with `review` status, never `empty` or
unqualified success. Quarantined text is searchable and exportable but cannot
seek or highlight a fabricated timeline position. CSV leaves its position
columns blank. Small existing endpoint-rounding tolerance is unchanged; the
validator still rejects malformed transcript structure and decoder failures.
Legacy documents without `timing_issues` deserialize with an empty list.

The right-hand transcript pane is resizable at its actual boundary, with the
existing pointer/keyboard splitter and a remembered, viewport-bounded width.
Compact Cast fields are capped at 560 pixels with inset focus space. Run
outcomes clearly distinguish saved, failed, stopped, empty and timing-review
results. Technical diagnostics, processed ranges and attribution notes live in
the collapsed Get Info section instead of a wall of red text. Results live in
Multitrack's saved sequence document; Export chooses a CSV/text destination.
The regular Transcripts browser still indexes separate SRT/VTT files, not this
document format. This change does not automatically manufacture duplicate SRTs.

ASR preparation now reuses the indexed Rust reader on a blocking worker rather
than starting Python and calculating unused waveform peaks for each chunk.
Recognition remains bounded, one track/chunk at a time. Whisper already passes
the performance-core thread count and Parakeet uses its existing Core ML path;
this revision does not launch twenty competing model instances or introduce a
new audio engine. Cancellation and the final atomic save remain owned by the
same job. Original AAF data and existing saved results are not rewritten by
diagnostic tests.

Read-only diagnostic excerpt runs with the currently bundled Parakeet covered
one microphone's sequence chunks, including the short final chunk. They did
not reproduce the screenshot's invalid cue in that run. Therefore no claim is
made that a particular upstream model bug caused it. Synthetic regressions
exercise zero-length, reversed, malformed and out-of-range cue timestamps,
preservation of valid cues, unplaced-text export, legacy loading and save/reopen.
Native input equivalence is tested separately against the established extractor
at three real 122-second ranges, including a recorder join.

Verification: 4,117 frontend unit tests passed (two skipped), all 426 browser
tests passed (four skipped), and all 35 design-catalog cases plus production
isolation passed. Full lint and TypeScript checks passed. An unrelated Review
undo test failed once during the first broad run and passed both its isolated
recheck and the complete rerun; no Review code was changed. The full Rust suite
passed 721 tests (28 ignored). The separately enabled real-AAF equivalence test
passed: all three ranges produced byte-identical 16 kHz transcription input
after the unchanged FFmpeg conversion. Indexed raw-input preparation took
12.3, 14.0 and 18.0 milliseconds for the three 122-second ranges; these are not
end-to-end recognition timings. No app installation, permission reset,
new branded app, DMG or GitHub publication is included in this revision.

### Person controls and export revision, 2026-09-14

The person tabs, track levels/context menu, regeneration dialog, Avid export,
Cast modal, and zoom-aware text summaries are implemented in the existing
workspace. Shared grid rows align the Generate and Export dividers. The editor
content owns inline-size containment; applying containment to the subgrid itself
would break that alignment and shrink the timeline. Overlay grouping remains
one pass per settled view, not repeated per playhead tick.

Two scrub races were reproduced and fixed: the first warm scrub must resume a
suspended AudioContext from the gesture, and throttling must retain the final
pointer position. Late resume callbacks cannot restart audio after Stop or
after audio scrub is disabled. Native PCM preparation and its bounded reader
queue remain unchanged; there is no new playback engine or permission flow.

The full verification gate passed, including 4,136 frontend tests (two skipped),
427 browser tests (four skipped), Rust/Swift/AAF checks, TypeScript, lint, and
sidecar/license integrity. The 35-case design catalog also passed with production
isolation. Focused regressions cover source timecode at 23.976 and drop-frame
rates, same-frame marker merging, untimed-text retention, atomic/cancelled/partial
exports, per-track model snapshots, tab navigation, gain isolation, and scrub
cancellation. The final frontend rerun passed **4,137 tests** (two skipped),
TypeScript and lint; all **eight** focused Multitrack browser cases passed,
including the full workspace at 1100 pixels with 125% text. Those UI fixtures
serve generated silent WAVs and mock native commands; they do not run ASR or
prove production media routing. These counts are not packaged-build acceptance.

A silent, nonpersistent WKWebView harness exercised the production controller,
canvas and CSS with actual 20-track 48 kHz/24-bit AAF excerpts. All tracks started
on one clock; zero per-track levels and Stop measured digital silence. Across
20 warm resumes, p95 remained **65 ms** to advancing transport and nonzero mixer
samples. The first warm scrub used the latest position for all microphones;
changing levels did not restart voices. Playback crossed multiple five-second
cache boundaries. Both footer borders aligned exactly and compact controls fit
their rows. Output was muted after the analyser. This does **not** establish
physical-speaker latency, packaged Tauri asset routing, Avid import acceptance,
or recognition accuracy. No installed app, macOS permission, source AAF or saved
result was modified; the existing DMG does not include this revision yet.

## September 15 lifecycle regression fixes

Permanent regressions now cover label-save/reopen ordering, a committed native
transcript reply arriving after Stop, and warm starts one frame before a PCM
block boundary. Related cases include source changes, cancellation while
buffering, late readiness before an animation tick, prolonged missing delivery,
EOF, and 20-track operation at 24 and 23.976 fps. No broad structural refactor
or unrelated UI change was made for these fixes.

The full gate passed: 4,153 frontend tests (two skipped), 721 Rust tests (28
ignored), 428 browser tests (four skipped), and the remaining compile, lint,
native helper, AAF, and license checks. The four ignored real-AAF reader checks
were then run explicitly and passed. The current controller/cache also passed
in a nonpersistent WKWebView with real 20-track native PCM excerpts: 20 warm
boundary-adjacent resumes measured p95 67 ms to advancing transport and nonzero
mixer samples. Delayed delivery preserved Play intent and resumed; Pause
prevented late restart. This harness used fixture IPC and silent output after
the analyser, not packaged Tauri routing or physical-speaker measurement.

Build 2026091501 retains the normal app identity and signing requirement.
Its packaged-content/signature checks passed, including byte-for-byte proof
that the tested production frontend is embedded in the executable. It was
launched directly from the build archive, without installation or a permission
reset. In the real packaged app, all 20 microphones at 23.976 fps passed exact
starts at frames 119 and 239 plus three successive warm resumes. Playback
remained active across subsequent five-second PCM boundaries; explicit Pause
returned the transport to its parked state. A user-started Parakeet run continued
alongside these checks, with completed tracks visible in the transcript pane.
No labels were edited or transcription started/stopped by the playback test.
These accessibility observations confirm production media routing and transport
behavior, not physical-speaker latency. DMG verification is recorded separately
in the build archive; this internally signed build is not release certification.
