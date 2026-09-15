# Screen and application choosers

The visual chooser uses Sauce Bunny's existing Nunito Sans, spacing, focus and
deep-violet selection tokens. It does not change the Preview monitor, comments,
transport, camera layout or volume control.

## Shared interaction recipe

- Source categories sit at the top, with one keyboard tab stop and arrow-key
  navigation. Changing category cannot submit a hidden category's selection.
- Cards show an actual bounded snapshot when available, the source name, and
  enough identity context to distinguish same-title windows. Missing snapshots
  are labelled unavailable; no fabricated thumbnail stands in for user content.
- A crop is a normalized rectangle inside the selected source. Draw, move and
  resize it in the snapshot, or use percentage fields and keyboard controls.
  Private Screen/Region capture rounds inward to backing pixels and requires
  each resulting dimension to exceed 16 logical points. The legacy room
  portion picker retains its pixel-based minimum. Invalid or cleared regions
  do not mean full-screen capture.
- Audio is an explicit inclusion choice, separate from local monitoring volume.
- Done/X/Escape dismiss the chooser without stopping capture. Cancel preview
  explicitly stops the private candidate. Continuous capture and publication
  require their labelled action; discovery and thumbnail selection never publish.
- Preview/audio and Cancel preview/Done remain in the dialog footer, outside
  scrolling fields. The footer occupies layout space rather than covering content.

`CaptureSourcePicker` contains controlled visual components. Native discovery,
snapshot acquisition and capture ownership stay in the parent controllers.
The catalog uses the same components with generated fixture props only.

## Unified Source settings

The existing gear beside Preview volume opens Source settings with NDI, Screen,
Window and Region categories. Screen and Region use the same embedded OBS
producer and Preview coordinator as Window; they do not route a hidden stream
through the room participant-share controller. Window cards list applications
together, without requiring an application dropdown first. Screen selects an
entire exact display; Region requires an explicit valid rectangle on that
display. A cleared Region draft cannot start full-screen capture.

Window capture retains exact bundle ID, process ID and window ID. Display
capture has a distinct typed target: display UUID, current display ID, logical
origin/size and backing-pixel size. Native start revalidates that complete
identity; missing or changed targets fail instead of choosing the main display.
Native crop configuration is applied before ScreenCaptureKit creates the
stream, and the initial source raster must match the accepted cropped pixels.

Preview stays private. Sharing with a Sauce Bunny room and broadcasting over
NDI are subsequent, independent actions. After an explicitly requested preview
has both a decoded picture and encoded readiness, setup closes to reveal the
existing monitor. A failed, cancelled or replaced request cannot close a later
visit to setup or publish anything. The existing room participant-share dialog
still uses its own ScreenCaptureKit display/window/portion path; its Share
confirmation publishes directly to the room and is not private Preview.

## Desktop boundary and controls

The native helper owns a nonactivating, click-through boundary and compact
Edit/Stop controls for each display-capture attempt. The boundary becomes green
only after healthy source/output frame evidence. Edit opens that source's
Region draft in Source settings; the current capture keeps its old crop until
an explicit Preview replacement. Closing settings leaves it unchanged; Cancel
preview still stops a private candidate. The desktop Stop control stops only
that exact source, revokes its raw/publication access, and retains a stopped
review picture; it is not a global stop for another capture. Events from stale
slot generations are ignored. Display-topology or geometry changes fail closed.

The helper reserves both slots' border/control windows before the first display
stream: four stable window IDs retained for the helper lifetime. Every display
stream must exclude all four IDs, resolved to the current helper PID, before
its first frame. Releasing one slot hides its panels without destroying their
IDs, so a later second capture cannot introduce an unexcluded outline into the
first. The module requires separate overlay-exclusion and display-region
capabilities. A missing ID, wrong owner, unsupported module or mismatched raster
fails closed; there is no name-based exclusion or full-display fallback.

Build 2026091207 passed actual packaged Screen and Region startup with the
four-window membership checks enabled. CoreGraphics validation uses a bounded
exact-ID description query, which includes the reserved never-ordered panels
without showing them. Generated metadata tests alone did not establish that
result. Native Edit/Stop interaction, pixel-level first-frame exclusion and
overlapping publication/candidate acceptance still remain open. Browser-tab
sources and presenter compositing remain separate product decisions.

## Snapshot and audio boundaries

OBS window discovery lists visible, normal-layer application windows of at
least 120 × 90 logical points in one bounded, metadata-only query. This matches
the existing room picker and omits menu-bar widgets without title or bundle
deny lists. The eligibility rule applies only to the cross-application chooser;
exact-window capture and application-specific discovery retain their original
geometry rules. Each choice includes a human application name and exact
bundle/process/window identity, without a prerequisite application dropdown.
Self windows, including the owned capture helper, are excluded by native PID.
Display discovery is a separate bounded metadata query that preserves exact
UUID/ID/geometry. Discovery has two shared worker slots, bounded admission, a
five-second total deadline and a 64 KiB output cap.

The separate `capture_window_thumbnail` and `capture_display_thumbnail` commands
take explicit bounded snapshots, validate exact identity before and after
acquisition, and return bounded JPEGs. There are at most two native snapshot
workers. The renderer requests only the current page, drops stale results, and
stores snapshots in memory only. Both thumbnail hooks share the same admission
queue: a cancelled in-flight native call keeps its slot until it settles, while
cancelled queued calls never read pixels. Switching Window/Screen/Region waits
for those slots instead of turning transient saturation into a terminal error.
Refreshing an unchanged exact source keeps its prior image visible; changed
identity or geometry clears it.

Opening the picker does not repair, reset or change macOS permissions. Denied
access and unavailable windows remain explicit errors. Real Screen Recording
access must be verified from the signed app; generated browser tests are not
evidence of a macOS permission grant.

The window variant of `ObsSelection.audio` remains optional for old selections;
absence retains their previous audio-enabled behavior. New Window selections
start audio-off. Screen/Region system audio is also initially off. The user
approved hiding Sauce Bunny's windows from that picture when system audio is
included. The checkbox explains that consequence before Preview. A different
display resets audio off; crop edits and reopening the same draft retain the
choice. Snapshots remain audio-free regardless of that choice.

An audio-enabled display request carries helper-only `audioPolicy: 1` and
requires the module's `sauce_display_audio_policy_version: 1` capability.
Neither the renderer nor the wire can choose an exclusion PID or bundle. The
helper resolves its actual Sauce Bunny parent natively and revalidates its
exact PID/bundle against ScreenCaptureKit. Missing, changed or unsupported
identity fails closed. The filter excludes that parent application and uses
the four validated helper-owned overlay windows as exceptions. Those windows
are removed because their owner is not the excluded parent; adding the helper
to the application exclusions would instead re-include its windows. The
helper's own audio is excluded through `excludesCurrentProcessAudio`.

System audio includes other applications even on other displays. A crop does
not spatially limit audio. Window application audio, local monitoring volume,
microphone and camera remain separate. Packaged builds 2026091301/1302 passed
bounded positive-reference tests for Region/WebAudio, Screen/HTML audio and
Region audio-off silence. These are measured cases, not proof for every source,
room playback or overlapping capture. Native policy tests alone do not prove
absence of feedback.

Explicit audio-off disables ScreenCaptureKit audio acquisition and callback
registration in the patched module. Encoded/raw output retains valid silent
stereo for transport compatibility. The helper refuses audio-off with older
modules that cannot enforce it. Changing window audio policy requires a new
capture, but does not change the source's review-note identity.

## Verification

Focused tests cover exact window/display identity, same-title windows, missing
sources, independent error states, stale snapshots, worker bounds, inward crop
geometry, selection retention, keyboard operation and separate Preview/
publication. Native parser, crop, overlay registry and actual patched-module
exclusion tests use generated inputs without starting ScreenCaptureKit.
Generated native audio tests verify silent PCM and independently decoded silent
AAC when no audio is included; they do not prove live application audio access.

The opt-in native control test also calls the production mouse handlers on two
test-owned hidden panels. It covers inside/outside release, one-shot actions,
disabled Edit, disabling during a press, Stop priority, and owner isolation.
It posts no global events and captures nothing. This verifies handler semantics,
not physical desktop event delivery or the complete helper-to-app Edit/Stop flow.

Live acceptance still requires a matching signed app and rebuilt helper: inspect
real snapshots, cancel without starting capture, verify exact first-frame crop
and overlay exclusion with two overlapping capture attempts, exercise native
Edit/Cancel/Stop and display-topology changes, and test Window audio off/on.
Verify room/NDI sharing only after explicit confirmation. Screen/Region audio
requires live external-tone/self-tone tests, including HTML media, WebAudio,
room playback, audio-off, overlapping attempts and source replacement. Do not
use an old binary or mocked browser result as validation of these sources.
Current evidence is recorded in [the Screen/Region audio policy checkpoint](EMBEDDED-OBS-CAPTURE.md#screenregion-audio-policy-checkpoint--2026-09-12);
the earlier audio-off chooser package is a historical checkpoint, not proof of
the new policy. Matching packages have now passed Window picture/thumbnails,
Screen picture/thumbnails, explicit Region replacement, and an audio-enabled
Region's visual exclusion of Sauce Bunny. Builds 2026091301/1302 also passed
the bounded audio cases above and packaged keyboard tab/dismissal navigation.
Native control, first-frame pixel and overlapping-capture acceptance remain
open; the recorded passes do not imply external-publication validation.

The opt-in internal `obs-audio-acceptance` build adds a bounded measurement
panel to the actual main WKWebView. It observes an existing private display
source only and never starts or publishes one. HTML-audio and WebAudio test
passes generate distinct low-level self-tones, compare the captured output to
an external stereo fixture, and require a positive own-window reference before
absence of self-audio can count as isolation. Missing reference audio is
inconclusive. Cancellation, source replacement and a frontend deadline stop
tones; native cleanup is independently bounded. This diagnostic UI and its
native commands are absent from ordinary builds. A test pass is evidence for
that measured case only, not every audio source or room configuration.
