# Live-session marker receiving: September 10 verification

Status: implemented and verified locally on `codex/premiere-live-marker-receive`.
Real guest-to-Premiere receiving, explicit insertion, Undo receipts, late join,
and rejoin passed with two native processes on one Mac. The approved release
on main is unchanged. This does not claim WAN or sustained NDI audio reliability.

## Native pairing failure reproduced and corrected

The installed 0.1.6 companion reached the app but the app rejected its Origin.
The diagnostic build showed `Companion connection rejected: the client
supplied an unsupported Origin header.` This separated the native failure
from the companion's generic network message.

The server now permits the exact opaque `file://` Origin used by UXP, in
addition to its existing native-origin cases. Arbitrary file paths, HTTP web
origins, incorrect hosts/ports, duplicate Origin headers, and query strings
remain rejected. The first message still requires the expiring 256-bit
pairing secret. No Origin alone grants access.

Both IPv4 and IPv6 loopback listeners use the same random port. IPv6 was
previously refused, but adding IPv6 alone did **not** fix native pairing.

Observed with the real installed Premiere Pro 26.3.2 companion:

- Fresh single-code pairing succeeded; both applications showed connected.
- The companion cleared the masked code and displayed Disconnect.
- Bind current sequence succeeded; both applications showed Sequence 03.
- Premiere remained open and parked at `00:00:11:03`. No marker was inserted,
  sync was not enabled, and the user's project was not modified or saved.
- Settings detected the installed Premiere output plugin throughout. The
  reported missing-plugin state is not yet reproduced; NDI discovery and
  live picture/audio still need independent verification.

The internally signed debug app used for that observation has executable
SHA-256 `c92ad3716aa576b8ddc8768dd329ea474928ccaaf334d31e6a962a2f18d3816f`.
Strict deep signature verification passed. It was launched from the debug
bundle, not installed over the approved application. No DMG was produced.

33 NDI-enabled native bridge tests passed, including real socket acceptance,
rejected origins/authorities, authentication, durable marker ledger, lost
acknowledgements, and Undo preservation. This is not a full-suite result.

## NDI receive-path reproduction and recovery

The same running internal build detected the installed output plugin and
discovered the Premiere source. A private preview connected to Premiere's
loopback TCP receiver port, but native telemetry stayed at zero input frames
and 0 x 0 even while Premiere's timeline advanced. This was before the
encoder or WKWebView player, not an absent-plugin result.

Premiere Playback preferences already had Mercury Transmit enabled, NDI as
the primary audio device, NDI video checked, and background video output
allowed. No installation or permission reset was needed. Toggling Mercury
Transmit off, applying, then restoring it and applying recovered the source.
No restart or timeline edit was performed.

After that reconnect, the existing receiver reported 1280 x 720 at about
30 output frames/second. During a short playback sample it reported 329
received frames, zero NDI drops, zero encoder drops, and a 31 ms input age.
After stopping, 522 frames had arrived. The actual Premiere picture was
visible in Sauce Bunny; the original parked timecode was restored to
`00:00:11:03`. A parked frame becomes stale by the current telemetry definition.
Audio listening, a sustained soak, and recurrence prevention are not proved
by this short picture test. The initial transmitter stall's underlying
cause is still undetermined.

The official NDI Video Monitor did not offer a source in its observed menu;
that independent check is inconclusive, not evidence against the verified
loopback connection and subsequent Sauce Bunny picture.

## Initial room-context validation work (before consent)

In-memory tests now cover source identity, review pass, presenter generation,
room changes, host-only context acceptance, revocation, and stripping private
binding fields. A room change clears the previous native source scope; a
private preview cannot reuse the room binding. These tests do not transmit
data. At that stage the production room permission flag was still disabled;
the later consent and implementation below supersede that gate.

The first full verification run found one stale context fixture, with all
other gates passing (495 Rust tests, 11 Swift tests, 359 browser tests).
After fixing the fixture and adding isolation cases, all 20 focused note/link
tests and TypeScript passed. The subsequent full `npm run verify` completed
with every gate passing. The companion's separate type check and all 35 tests
also passed. Logs: `/private/tmp/sauce-marker-scope-verify-20260910.log` and
the companion check output in this task. These automated results do not
replace the outstanding two-client and native marker-insertion checks.

## Setup status hardening and native recheck

The supplied setup screenshot itself says "Premiere output plugin found";
the companion screenshot shows the separate pairing failure described above.
The read-only system preflight also continues to find the installed bundle.
That does not rule out the user's intermittent missing-plugin report.

Source inspection and regression tests established two misleading-state cases:
`Path::is_dir` treated inspection errors as a missing installation, and a failed
frontend refresh retained its previous found/not-found claim. The native check
now returns an I/O error for unsuccessful inspection rather than false. A fresh
frontend check supersedes the previous observation and a failed check shows
"Installation status unavailable" with the underlying error and an explicit
retry. Runtime initialization remains separate from plugin installation.
Obsolete responses cannot overwrite a newer result. The retry button keeps
keyboard focus while busy and coalesces repeated activation. Existing Settings
tokens, typography, controls, and disclosures are unchanged.

Verification:

- The two new stale-status cases failed before the fix and passed afterward.
- Twelve focused setup tests pass, including refresh failure/recovery,
  overlapping requests, obsolete responses, and independent runtime errors.
- Three native preflight tests pass for present/missing/non-directory paths,
  bundle symlinks, and deterministic filesystem error classification. Only
  uniquely named temporary fixtures were created and removed.
- The full `npm run verify` passed: 3,617 frontend tests, 498 Rust tests,
  11 Swift tests, and 360 browser cases; existing skips remain. Log:
  `/private/tmp/sauce-preflight-status-verify-20260910.log`.
- Browser checks cover failure/retry via keyboard plus the four existing
  desktop-size/text-scale Settings layouts. An initial focus assertion exposed
  native-disabled-button focus loss; the subsequent full browser run passes.
  A concurrent standalone browser attempt could not start because its output
  directory was in use; that attempt is not counted as verification.
- The final copy/developer-disclosure guard and busy-button unit assertions
  were followed by the 12 focused tests, TypeScript, and scoped lint, all passing.

The internal debug application was rebuilt, Apple Development signed, and
strict/deep signature-verified. Executable SHA-256:
`613739a1278d23bb7410dcff258872e901d598cfe3b84d22e71c0a58679f7547`.
Frontend and backend build ID: `2026-09-10-premiere-preflight-status`.
It was relaunched from the debug bundle; native Settings showed the plugin
found on initial check and Check again. A foreground screenshot confirmed the
existing Settings layout. Premiere stayed open; no timeline edits or saves were
performed. Restarting the test app ended its ephemeral local pairing. No new
pairing was completed afterward: the user began using Clip, so UI interaction
stopped. `/Applications`, the release DMG, and GitHub main were not replaced.

This is truthful setup detection, not proof of repaired NDI audio, a cause for
the intermittent transmitter stall, or completed live-room marker receiving.

## Approved room receiving implementation

The user's current request authorizes implementing live-session receiving.
The proposed room broadcast was stopped by a permission review because it
would disclose selected project/sequence names and identifiers to participants.
The user explicitly approved those fields on September 10. Implementation
has resumed: the room context and receipt transport are now connected with
whitelisted fields. Paths and pairing codes remain private. This approval is
not permission for automatic marker placement or project saves.

- Host-only binding context is scoped to the current room, published native
  NDI input, review, presenter generation, and monotonic context revision.
  Late joins receive context; changed/stopped publications revoke it.
- Marker intent retains its original authorization scope across retries. The
  host validates that scope at the head of the serialized durable commit
  queue, not before a possibly long wait. Sender-claimed ticks are removed;
  the local editor must still capture and confirm the intended frame.
- Only completed canonical commits enter the native room-marker queue.
  Optimistic saves, guest snapshots, forged bindings, and stale source
  generations cannot trigger native insertion. Retry remains idempotent.
- Guests receive host-stamped, revision-checked delivery statuses for notes
  in the current shared review/binding. The wire whitelist excludes project
  paths, pairing data, native error details, marker GUIDs, and unrelated notes.
  An added-marker receipt does not claim the Premiere project was saved.

Mounted hook tests cover delayed/failed persistence, retry, source changes
while a commit waits, forged bindings, late join/revocation, guest-only receipt
acceptance, and optimistic-save exclusion. They mock native transport and do
not substitute for actual two-client networking or Premiere insertion.

The first complete implementation verification passed: 3,622 frontend tests
(2 skipped), 498 Rust tests (21 ignored), 11 Swift tests, and 360 browser cases
(4 skipped). Companion type checking and 35 tests also passed. Two additional
queue/receipt regressions and a historical-note receipt adjustment subsequently
passed the 30-test focused link/hook suite. The final full run also passed:
3,624 frontend tests (2 skipped), 498 Rust tests (21 ignored), 11 Swift tests,
and 360 browser cases (4 skipped), plus companion type checking and 35 tests.
Log: `/private/tmp/sauce-room-marker-final-verify-20260910.log`.
The matching native application build and insertion check follow below.

## Native room-host note, insertion, and Undo

The user approved marker testing in the disposable project, then saved it as
`Desktop/test for sauce bunny.prproj`. Its Sequence 01 was parked at
`00:03:57:14` (30 fps, zero-based frame 7124). The separate original
`Test.prproj` stayed open and was not edited or saved.

Using the actual internally signed WKWebView application and installed UXP
companion, a room named `Marker receiving test — disposable` was started,
the explicitly bound Premiere input was published, and one note was posted
with Send this note to Premiere selected. The saved note appeared once in
Premiere's pending list. No guest was connected; this is a real room-host
path, not a two-client guest-network acceptance result.

Native capture exposed an additional failure in companion 0.1.6:
`Cannot read properties of undefined (reading 'toString')`. The project/
sequence lookup results were read synchronously. A promise-returning lookup
fixture reproduced the exact failure before correction. Companion 0.1.7 now
awaits these lookups and checks the exact identity/path again across awaits;
the mutation lock still uses only synchronous property checks. No fallback to
the current arbitrary project or sequence was introduced. Adobe's
[UXP async overview](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/)
and [Project reference](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/project)
were checked; the published synchronous lookup declarations alone did not
predict the observed host behavior.

Creative Cloud installed 0.1.7 while Premiere stayed open. After reconnecting
and restoring the exact captured binding:

- Capture parked position correctly offered frame 7124 of Sequence 01.
- Add marker here created a visible native marker at `00:03:57:14` and made
  the test project dirty. The companion showed zero pending notes and Added
  to Premiere; the app received Added to Premiere · Save the project separately.
- Premiere Undo removed that one marker and returned the test project to a
  clean state, without moving its playhead or saving it.
- Completed notes lacked an explicit reconciliation control, so the existing
  read-only check is now available as Check recent markers. After installing
  that refinement, re-pairing, and checking, both applications reported
  Removed in Premiere / Not recreated. A repeated check did not recreate it.
- Marker sync was returned to off and the test session was ended. The saved
  Sauce Bunny test note remains as evidence; no user media was deleted.

The final companion passes type checking and all 40 tests, including async
lookups, Save As during lookup, explicit Undo reconciliation, and stale
connection/sync rejection. The packaged panel passed the 280/340px and
100/125% text smoke matrix. Installed JavaScript exactly matches the built
artifact: SHA-256 `e3385e1c29043c66ae64f0dc092563843aa6436ba828b2c059f0ab08b1a0efec`.

The native test initially ran desktop executable
`638abc83e2a2ed9f7a1259fccc077f8ba5471f29c3cc199d962a3606e776d1dd`,
build ID `2026-09-10-premiere-room-marker-receive`. The internal app was then
rebuilt with the final companion resource (no further desktop source changes):
executable `dc709e32c7f73c8be24581dd873954ed774ddf8a7f14eb36d945561fc0670e53`.
Strict/deep Apple Development signature verification passed outside the
restricted sandbox. Bundled and standalone companion CCX hashes match:
`d29ab20632760cd5566cfe56f30a513ad8f9d72ab1d0b140e80c5249666de02a`.
This internal bundle is not notarized. No release DMG, `/Applications` app,
or GitHub branch was published or replaced by this test.

Separate observation, clarified by the subsequent investigation: session setup
said camera/microphone off, while room buttons briefly indicated both were on.
Those labels used saved preferences rather than actual live tracks. Room entry
does not acquire devices; the earlier observation did **not** establish that
the hardware was active. Controls now derive state from enabled, live tracks.
Five hook regressions also cover cancelling pending acquisition, ended tracks,
and enabling only the requested device instead of reviving the other device's
saved-on preference. Two real-App browser cases cover host and guest entry
without capture. Both applications remained off for marker testing.

## Real guest admission and access repair

An isolated native guest app now runs the production frontend and Rust session
transport in a second WKWebView process. Its test-only adapter routes the
library into a fresh temporary directory and prevents hosting/host-key access;
session messages, review persistence and receipt handling remain native.
See `harness-marker-guest/README.md`. This is two processes on one Mac, not a
claim about two-machine networking or WAN behavior.

The first real guest join reached the host, but invitation-only admission
rejected the plain join code. The host's only recorded grant was revoked.
The policy was **not** disabled. Investigation found that the entire setup
rail is hidden during active rooms, making its nested access manager
unreachable. It also found that explicit Join discarded deep-link grants,
and ordinary text-input paste could concatenate the download footer with
the grant after stripping newlines.

The room header now opens the existing invitation controls in a small dialog,
outside the hidden setup rail and off the default onboarding screen. The
editor stays mounted across close and room changes to preserve a newly issued
one-time secret. Policy changes report the confirmed value and retain it on
failure; creation coalesces duplicate clicks. Copied invitations and native
deep links carry the same grant through the explicit Join action. Editing to
another code never reuses an old grant. Native admission failures surface
only three allowlisted reasons, not arbitrary remote close text.

Focused checks: 49 component/hook/helper cases passed; the full-App invitation
test passed after exposing and correcting Escape focus loss and multiline
paste. Eight existing header/deep-link browser cases also passed. The final
full verification passed: 3,639 frontend tests (2 skipped), 499 Rust tests
(21 ignored), 11 Swift tests, and 363 browser tests (4 skipped), plus all
type/lint/license gates. Companion type checking and all 40 tests passed.
Logs: `/private/tmp/sauce-room-receiving-verification-final-20260910.log`
and `/private/tmp/sauce-room-companion-check-20260910.log`.

## Real guest insertion, Undo, and reconnect

Using an actual invitation-only QUIC session, the isolated guest explicitly
selected Send this note to Premiere and posted:
`Guest receiving proof — disposable Sequence 01 at 00:03:57:14. Add once, then undo.`
The native companion displayed that guest note exactly once in Pending notes.
Capture parked position confirmed frame 7124; Add marker here created one
visible Premiere marker. The guest received Added to Premiere · Save the
project separately. Premiere Undo removed it and returned the disposable
project to its unedited state. Check recent markers propagated Removed in
Premiere · Not recreated to both host and guest. No project save was performed.

The guest then left and rejoined. That exposed a real native boundary missed
by mocked IPC tests: `session_send_to` rejected `ReviewOp`, so its ordered
welcome delivered the document but not binding context or marker receipts.
The host-only welcome now permits host-stamped review operations, just as the
broadcast path does. Existing size, member connection-generation, committed
source, and receiving-side room/source/revision validation remain intact.
The new native test failed with `Not a welcome message` before the fix and
passes afterward; unrelated presenter/control messages remain rejected.

The rebuilt host was paired, bound, and published before the guest joined.
Both late join and a second leave/rejoin then restored the binding and both
Removed receipts without any host-side mutation. No further marker insertion
was needed and the native pending count remained zero. All 500 native tests
passed after this fix (20 ignored); the prior full frontend/browser suite was
unchanged. The all-targets Clippy gate and focused marker tests were rerun.
Logs: `/private/tmp/sauce-welcome-regression-before.log`,
`/private/tmp/sauce-welcome-native-tests-20260910.log`,
`/private/tmp/sauce-welcome-clippy-all-targets-20260910.log`, and
`/private/tmp/sauce-welcome-focused-20260910.log`.

Native artifacts used:

- Guest insertion host executable SHA-256:
  `b095464c6f53f6c5ae27dbcdba106a3f209f4f3d25e540c2c7747eb0d8aea6cd`.
- Isolated guest executable SHA-256:
  `ffc549cf92f8d2071875ac75dd9320225e113d62cae7942b57cc0b936a534e28`.
- Final host executable SHA-256 after the welcome correction:
  `5fa7cf8a2bf7bf0359127c9f50cc0fff5df4b5540b93705ebc85c60ad9c5e6ca`.
  Build ID `2026-09-10-premiere-room-marker-receive`; strict/deep Apple
  Development signature verification passed. It is not notarized.

Cleanup: the guest left and its test app was closed; both temporary reviewer
grants were withdrawn, invitation-only admission stayed enabled, the host
test room ended, and companion marker sync was returned to off. Test notes
remain as evidence. After the initial insertion/Undo check, the disposable
project acquired additional timeline edits while the host was being rebuilt.
Those edits and its later parked position were left untouched during the
read-only rejoin check; do not describe its final state as unedited. The
separate original project was not changed. No release DMG, installed
`/Applications` app, GitHub publication, or permission reset was performed.

## Remaining limits

- These are two independently identified native apps on one Mac, not a
  two-machine discovery/NAT/WAN test.
- Settings continued to detect the installed NDI plugin after restart and
  refresh; the final preview reported 1920 x 1080 at about 30 fps. Guest
  rejoin could still wait for a new room picture even while the correct
  binding and receipts were present. This is not proof of continuous picture
  availability, audio output, or sustained NDI reliability.
- The original intermittent NDI transmitter-stall root cause remains
  undetermined. Setup-status and marker fixes do not claim to solve it.
