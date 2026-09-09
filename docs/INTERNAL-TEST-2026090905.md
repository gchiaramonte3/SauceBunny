# Internal test: 0.5.0 / 2026090905

September 9, 2026. This build carries the previously documented NDI continuity
and web-playback fixes, plus the downloader-maintenance corrections below.
It is an internal test build, not a new public semver release. NDI remains
experimental; neither automated tests nor a successful package establish the
uncompleted second-Mac/long-running Premiere acceptance matrix.

## Downloader maintenance

- Update and Reset share one native operation lock, including calls from
  other UI entry points. Overlapping changes report an error. Read-only
  version checks wait for the current operation's committed result.
- Settings disables both actions throughout a check, update, or reset. A
  synchronous latch prevents duplicate clicks before React renders disabled.
  Late results from an unmounted panel cannot overwrite the current cache.
- Reset propagates file-removal failures and returns the verified fallback
  version while still holding the lock. A missing override is already reset;
  permission errors are not treated as success.
- Version checks require a successful process exit and a valid yt-dlp
  stable/nightly version string. Invalid output is not displayed as a version.
- The existing official-release checksum verification, atomic install,
  stable-default/nightly opt-in, and shared executable resolution remain.
  There is no settings-layout change or persistence migration.

The SDK-free CI build also now omits the segment-id allocator field when its
publisher is absent, using the publisher's existing `sauce_ndi || test`
condition. This fixes a dead-code Clippy error without changing SDK-enabled
stream behavior or suppressing warnings. SDK-free Clippy and all 484 native
tests passed (20 ignored).

## Automated verification

The full SDK-enabled verification command passed: TypeScript, 3,549 frontend
tests (two skipped), lint, Rust compile, 484 native tests (21 ignored), Clippy,
Swift build/tests, licenses, and 359 browser tests (four skipped). The companion
passed its type check and 35 tests. The CCX was rebuilt and package-checked.

The eight new Settings tests cover exclusion, reset failures, failed live
probes, nightly behavior, and stale mount completion. Six failed against the
old implementation before passing with the fix. Native tests exercise the
operation gate, actual temporary-file removal and permission failure, and
process/output validation. They do not simulate a successful network download
as proof of an actual upstream update.

A separate native app copy launched and completed the real version probe.
Both maintenance buttons were disabled during that probe and during Reset.
Reset returned the bundled 2026.08.19 status and only then displayed success.
The previous updated executable was backed up before this check and restored
byte-for-byte afterward. No Premiere project or installed app was replaced.

## NDI test qualification

The first 24-fps capture, during release compilation, failed the wall-clock
cadence ceiling (31.71 fps for one sample). Its encoded video and audio packet
timelines remained continuous to rounding precision. With the compiler idle,
the unchanged 24-fps native gate and all three sustained decoder runs passed.
This is not a guarantee of zero jitter under competing CPU load.

Uninterrupted 30/60-fps captures exposed a separate harness assumption: it
required repeated input timing although it never parked the sender. Both
captures reported no repeated timing. The 30-fps capture independently passed
three sustained decoder runs. The repeated-timing assertion now applies to
the deliberate stall/recovery mode; that mode still must observe repetition,
stale state, and recovery. Continuous mode keeps the timestamp, cadence,
decode/audio-gap, startup, clock, and seek assertions. No production timing
policy was relaxed to make the test pass.

Final qualification passed at 30-fps and 60-fps input, each with three
sustained decoder runs. All six reported zero recovery seeks, waiting events,
observed audio gaps, and frozen playback-clock intervals. Maximum measured
native output rates were 30.0978 and 30.1197 fps, respectively. The deliberate
30-fps stall/recovery run also passed: live, stale, recovered, and repeated
timing were all observed. Both captures retained 1920x1080 H.264 and stereo
48 kHz AAC after placeholder/format changes. These are synthetic regression
checks, not a substitute for real Premiere playback acceptance.

After the SDK-free field adjustment, SDK-enabled Clippy and all 484 native
tests passed again (21 ignored), and the final app was rebuilt with NDI.

## Review verdict: Ship it for internal testing

Scope: the downloader-maintenance delta and package verification, not an
independent re-review of every pending feature on the branch.

### Bugs

The Update/Reset race, silently failed removal, and unchecked version output
are corrected with targeted regression tests. The native lock is process-local;
it does not claim to coordinate independently launched copies of the app.

### Principles

All downloader callers continue using the existing command factory. Status,
update, and reset share the same validation and operation ownership. No new
transport, persistence format, or dependency was introduced.

### The "no" list

No production sleep, retry timer, or arbitrary buffer limit was added. Errors
at the process/filesystem boundary remain visible. Test-controlled promises
exercise ordering rather than relying on guessed delays.

## Distribution limits

The release-signing preflight reports missing Developer ID/notarization
configuration and an already-used public v0.5.0 tag. This build deliberately
retains the semver and increments only CFBundleVersion; it does not replace
that tag or create a public GitHub Release. The local test installer is
ad-hoc signed, not notarized. Earlier numbered installers are retained.

## Verified artifact

- Installer: `Sauce Bunny 0.5.0 (2026090905).dmg`
- DMG SHA-256: `f41214bb1e0a30dc929791daf6120851721d3d8d7a294f1e45458fd0e40916da`
- App executable SHA-256: `4c64afa33dbe607c40a1190598111f5023c3c71edae60753acd25e231f0d5b24`
- Read-only mounted DMG checksum, app build number, strict deep code-signature
  validation, bundle-content checks, and packaged static checks passed.
- Mounted executable bytes match the final build. The companion CCX is 0.1.6;
  the bundled NDI runtime is 6.3.2.0 with verified provenance.
- The installed `/Applications` copy was not replaced. The separately launched
  test copy passed the native downloader Settings checks above; the mounted
  final artifact was checked without interrupting the user's current app.

At preparation time, source publication remained pending explicit approval
to publish the full queued update to the public repository. No public release
or replacement semver tag was created as part of this installer build.
