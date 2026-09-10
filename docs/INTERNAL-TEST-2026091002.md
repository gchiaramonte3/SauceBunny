# Internal test: 0.5.0 / 2026091002

Built September 10, 2026. This is the locally approved Apple Silicon test
installer, not a new semver release or a notarized public download.

## Included source

- Local-first web playback with automatic, synchronized high-quality upgrades.
- Public-first YouTube acquisition, explicit Safari cookie-access states, and
  a pinned bundled Deno runtime. See
  [playback verification](PLAYBACK-AUTO-QUALITY-2026-09-10.md) for native test
  results and the remaining external-service and permission-validation limits.
- Existing NDI runtime 6.3.2.0 and Premiere companion 0.1.6 retained.
- Build archives now follow the project directory; relocating the project does
  not send subsequent installers back to its previous location.
- The bundle verifier recognizes certificate-authority output from macOS and
  distinguishes successful local signing from notarized distribution.

## Verified artifact

- File: `Sauce Bunny 0.5.0 (2026091002).dmg`
- Size: 151267985 bytes.
- SHA-256: `ab30c502e6a17625edf42846ae4bcbac9380a8f80c77bbab47deec1987736de4`
- App executable SHA-256: `ae0cea6e318aade5aac519e2ad61448bb5f80128a64558a12f7b6877b31c4e10`

The DMG checksum, strict deep app signature, bundle-content checks, and packaged
static checks passed. The read-only mounted installer reports build 2026091002;
its executable matches the checked build output. Bundled Deno 2.8.0 executes
with only system directories on PATH.

The initial Desktop bundle inherited Finder metadata that prevented signing.
Packaging the same newly compiled executable in a clean temporary directory
resolved that artifact problem. The verified app and image were copied back
into the relocated project's generated bundle paths and checked again.

## Delivery limits

Apple Development signed for internal testing; **not notarized**. Public
distribution still requires Developer ID signing and notarization. The
installer was opened in Finder, but the installed application was not replaced.
No fresh manual paste, cold MP3 export, or real-Premiere acceptance run is
claimed for this rebuild. Older numbered installers remain in the archive.

Publishing this source to the repository's main branch does not upload this
DMG, change the existing v0.5.0 tag, or create a GitHub Release.
