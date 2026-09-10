# Internal test: 0.5.0 / 2026091001

Built September 9, 2026 local time; the build number uses September 10 UTC.
Source: `8a3a7fb46a8edd7638162cab8dda3a63ddde3f0f`, plus the build-number
stamp. This is a local internal-test installer, not a public semver release.

## Contents and verification

- Playback-first changes for completed web review copies in Clip and Preview.
  See [playback verification](PLAYBACK-FIRST-VERIFICATION.md) for the full
  automated suite and the separate packaged WKWebView measurements.
- Existing NDI implementation and runtime 6.3.2.0 retained; no NDI behavior
  change is claimed in this batch.
- Premiere companion 0.1.6 rebuilt and included. TypeScript, all 35 companion
  tests, and the isolated packaged-panel smoke passed. That smoke is not real
  Premiere UXP acceptance testing.
- Main frontend production build and all five version-stamp tests passed.
- All eight sidecars passed presence, checksum-pin, and dependency checks.
- Bundle-content and packaged-static checks passed, including CSP, assets,
  component notices, native NDI implementation, and companion resources.

## Installer verification

- File: `Sauce Bunny 0.5.0 (2026091001).dmg`
- Size: 119472632 bytes.
- SHA-256: `1e68958f8342d2b82137f721de3b1439a76e3d5e0d71df112a456bed8f86ef64`
- App executable SHA-256: `b2ff503565017b87729146b09d977cc7073bf9b735d8e467377979383e77da2c`
- Disk-image checksum verified. The read-only mounted app reported build
  2026091001 and passed strict deep code-signature verification. Its executable
  matched the build output byte-for-byte. The final archive matched the checked
  image byte-for-byte.

The initial Desktop-based bundle acquired `com.apple.FinderInfo`, which caused
strict signature verification to fail even though the packaging wrapper passed.
The final image was created from an extended-attribute-free temporary copy of
the generated app, outside the Desktop location. The original code signature
then verified without modifying executable bytes. A clean APFS compressed image
with an Applications link was created and checked before archiving. This is an
artifact repair; the general Desktop packaging script has not been changed.

## Limits

Ad-hoc signed; **not notarized**. Developer ID/notarization is not configured.
The existing v0.5.0 tag is unchanged. No GitHub Release was created. The installed
application and Premiere were not replaced or restarted. No new manual paste,
cold MP3 export, or real-Premiere acceptance run is claimed for this installer.
Older numbered installers are retained.
