# Linked and grouped AAF import — verification

Target: macOS 14+ on Apple Silicon. Test host: macOS 26.5.1, Apple Silicon.
No installation is part of this delivery. The September 22 rebuild and GitHub
update were explicitly requested after the original delivery.

## September 22 rebuild

Artifact: **Sauce Bunny 0.5.0 (2026092211).dmg**. Freshly rebuilt AAF and video
runtimes; bundle contents, certificate signatures, packaged checks and disk-image
integrity all passed. The bundle audit examined 229 Mach-O files. This remains an
internal signed build, not a notarized distribution release.

SHA-256: `4d877a6fc87bea8dac25d25189e22d7afc168aaf8af8d46414e24dd42306aff8`.

The complete automated gate run passed, including 799 Rust library tests and
473 browser tests. A final frontend rerun passed 4,567 tests (three skipped).
The pre-push review found and corrected a fractional-frame seek mismatch:
transcript clicks and search results now use the same timestamp-rounding helper
as their displayed timecode. The new regression is included in the project's
contract register. No remaining blocker was found in the reviewed paths.

Interactive desktop evidence below belongs to builds 2026092209/10; it was not
rerun for this packaging-only rebuild plus the small seek correction. Existing
macOS 14 runtime, NEXIS and feature limitations below still apply.

## Scope

Metadata-first offline import, linked WAV/BWF and PCM MXF, explicit channel
isolation, nested group alternatives, mounted/local relinking, lazy waveform
requests, single-clock audition, and independently saved microphone transcripts.
Existing embedded PCM uses the native indexed reader. Linked PCM uses bundled
FFmpeg; [MediaBunny's documented container list](https://mediabunny.dev/guide/supported-formats-and-codecs)
does not include MXF.

No hard-coded cast/track map. No NEXIS mounting, authentication, arbitrary volume
scan, or network locator traversal. A folder search is explicitly selected,
bounded to 20,000 entries/12 levels, skips symlinks, and retains ambiguous matches
for manual selection. Last verified bindings survive disconnection; changed
recordings require explicit relinking. Committed results remain intact.

## Supplied files, read-only

| File | Root audio tracks | Expanded lanes | Linked sources | Markers |
| --- | ---: | ---: | ---: | ---: |
| QT Ref test_2.aaf | A38 | 1 | 3 | 976 |
| Sequence with a Group Clip.aaf | A1–A20 | 98 | 98 | 12 |

The grouped file's A4 selected branch is ASHLEY; alternatives are NICOLE,
KEISHOEN, YEREMI and BARTLEY, derived from AAF metadata. Both are 24000/1001;
the grouped sequence starts 01:00:00:00 and lasts 00:07:21:13. Marker attribute
metadata, including the reference file's extended Pink color, is retained.
The supplied audio is offline, so these files cannot certify NEXIS playback.

Source SHA-256 values:

- QT Ref: `2530349b0446b1be42b0fe5a0b7a96922f61a5c4882c86a27183157df7a2ab2c`
- Group clip: `7ea990f1fa900e476c97c41bb115e907eba320c407380872bf5a6a2cc0f7606f`

## Automated checks

- Full gate pass: TypeScript, unit tests, ESLint, Rust compile/tests, Clippy with
  warnings denied, Swift tests, native audio evidence, OBS, NDI, AAF reader,
  video worker, license checks, and browser E2E.
  Final run: 4,566 frontend tests passed (three skipped), 799 native library
  tests passed (30 environment-dependent tests ignored), and 473 browser tests.
- Full browser run: 473 passed, 12 explicitly opt-in tests skipped. Includes a
  generated 98-lane/14-root fixture: disclosure leaves alternatives muted and
  unchecked, no hidden-lane waveform request on import, alternative audition,
  zoom, and all 98 sequential mocked recognition commits.
- Native AAF regressions: 53 passed, four existing real-media tests ignored
  without their environment inputs. Includes actual bundled FFmpeg/ffprobe WAV
  and MXF checks, byte-exact native channel isolation, migration, stable old
  IDs, cast snapshots, separate sequence identity, relink/ASR commit races,
  disconnection, reconnect, changed-source refusal, duplicates, cancellation,
  percent-encoded locators and exporter mount prefixes.
- Reader: 27 existing tests plus 10 graph tests. Graph cases include 98 lanes,
  256-lane limit, cycles, offline sources, embedded stereo channel isolation,
  linked WAVE summaries and rational descriptor rates, nested alternatives in
  unselected branches, multiple sequences, trims/gaps, unsupported effects and
  transition overlap retained as unavailable rather than silent or flattened.
- Relink UI tests cover cancellation, stale response rejection, explicit source
  file choice, actionable mismatch errors, and multiple-sequence selection.

Browser audio tests exercise generated PCM and real Web Audio but mock native
IPC. They are not substitutes for packaged-app or production-server tests.

## Compatibility audit

Every bundled Mach-O is checked for arm64, deployment floor at or below 14.0,
portable dependencies/RPATHs, and a valid signature. Universal Mach-O headers
are handled separately from dependency load commands. The frozen AAF runtime's
collected interpreter and bootloader are audited before one-file packaging;
the video runtime's 202 collected Mach-O files are audited independently.
Tauri declares 14.0 and Swift targets macOS 14. New AAF paths introduce no newer
macOS platform API. Static audit is **not macOS 14 runtime certification**.

## Packaged-app checks

Previous interactive test build: **Sauce Bunny 0.5.0 (2026092210).dmg**. The application was
launched from its build directory; the installed application was not replaced.
Earlier playback checks used a temporary copy of build 2026092209, whose only
difference from 2026092210 is corrected group-audition explanatory text.

- Both supplied AAFs imported through the macOS Open dialog in build 2026092210.
  Saved documents contain the track/source/marker counts above. Offline sources
  do not prevent opening, and unavailable microphones cannot be transcribed.
  Expanding A4 exposes the four named alternatives, muted and unchecked.
- Generated 98-source stereo-WAV fixture: 14 sequence tracks, six alternatives
  per track, 20.02 seconds at 24000/1001, three-frame leading/trailing gaps.
  All 98 sources resolved. Initial transcription selection was 14, not 98.
  Expanding all groups left that selection unchanged; Select all then selected
  all 98. Tone-only inputs produced 98 committed empty results through the
  packaged Parakeet transcription path.
- Stop after 35 completed microphones retained all 35 on disk and on reopening.
  A second run completed all 98. Reopening and subsequent relinking retained
  those results. One deliberately replaced generated source was then recognized
  as speech, leaving 97 empty results and one completed dialogue result.
- Relink test: moved one generated WAV aside, refreshed to 97/98 available,
  explicitly selected its replacement, and returned to 98/98. The document
  retained its verified file binding and document-specific prefix mapping after
  reopening. The replacement had a tone on channel 1 and generated spoken words
  on channel 2. The saved transcript correctly contains the channel-2 words,
  including “The second channel contains speech.” No production media changed.
- Linked BWF, PCM MXF/OP-Atom, and embedded stereo fixtures each imported,
  played, and saved a transcription result in the final app. An embedded
  alternative microphone was independently soloed and played. An intentionally
  mismatched MXF duration was rejected as Needs relink; the corrected fixture
  describes the actual MXF edit-unit padding instead of weakening validation.
- Number-pad entry sought to 01:00:04:23 / frame 119 at 24000/1001. A letter
  did not alter the entered timecode. Playback crossed the five-second buffer
  boundary, zoom changed to 2×, and soloing an alternative unmuted that mic.
  A 14-selected-mic run reached the end of the full generated 20-second clip.
- Playback progress was visible within 1.1 seconds of the test click (including
  automation observation overhead, with waveforms already prepared). Process
  snapshots were approximately 121 MiB native + 436 MiB WebKit during playback,
  and 147 MiB native + 686 MiB WebKit after expansion/transcription. These are
  snapshots, not peak-memory measurements or long-duration/NEXIS benchmarks.
  The code enforces two preparation permits and one Multitrack recognizer;
  process snapshots alone do not certify the maximum concurrent process count.

The final bundle audit passed for **242 Mach-O files**, plus the separately
audited frozen-runtime payloads. `LSMinimumSystemVersion` is 14.0. DMG
`hdiutil verify` passed. The internal build is signed, **not notarized**.

SHA-256: `89c6dd7264c57487bd58b9fa4a26e119259dcdf7fe07fcf89e4a90c37a27dfc8`.
Both supplied AAFs still have their original SHA-256 values after these checks.

## Deliberate limitations

- Production NEXIS playback and a real macOS 14 machine remain untested.
- Referenced files must be accessible locally or on an already mounted volume.
- Ancestor recorder-WAV locators can have a different time origin than Avid MXF;
  they remain provenance, not automatic substitutes. Direct WAV/BWF links work.
- Unsupported time-changing operations retain unavailable spans. A lane with
  such spans is not auditioned/transcribed as if the spans were silence; other
  usable lanes remain available. Off-frame nested edits or mixed native formats
  that cannot currently be represented faithfully are identified unavailable.
- Integer 16/24/32-bit embedded PCM at 44.1/48/96 kHz is supported. This is raw
  isolated microphone audio, not an Avid effects/mixdown renderer.
- Linked BWF audio is supported, but this pass does not automatically copy its
  recording-date tag into the document's shoot-date field. An existing/user
  shoot-date override remains available; the generated linked-BWF test showed
  Not provided rather than inventing a date.
- Alternative group Avid markers remain disabled. Ordinary sequence markers
  retain original A-track destinations. Picture metadata is retained, but
  multicamera picture playback, AAF writing and audio-map PDF/Excel are deferred.
