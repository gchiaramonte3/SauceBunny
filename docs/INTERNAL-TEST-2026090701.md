# Internal test: 0.5.0 / 2026090701

Built September 7, 2026 for Apple Silicon, macOS 14+. This is a local internal
test, not a signed/notarized public release. The executable has an ad-hoc linker
signature, no Developer ID, and no sealed app resources. Do not treat it as a
publicly distributable installer. No application was installed or launched as
part of packaging verification.

## Deliverables

- `Sauce Bunny Builds/Sauce Bunny 0.5.0 (2026090701).dmg` on the Desktop.
- `Sauce Bunny Builds/Premiere Companion 0.1.0 (2026090701).zip` on the Desktop;
  contains the CCX and installation guide.
- The same verified CCX is bundled in the app for the Settings → Integrations
  installer action. Adobe's installation confirmation is still required.

Installation and pairing: [companion guide](../premiere-companion/INSTALL.md).
Design rules and native UXP caveats: [companion design contract](../premiere-companion/DESIGN.md).

## Verified

- TypeScript and ESLint checks passed.
- Frontend: 3,462 tests passed, two skipped.
- Browser: 332 passed, three opt-in real-media tests skipped. An initial lasso
  test failed; 24 targeted repeat cases and the final complete run passed without
  changing that application behavior. Its intermittent cause is not established.
- Native Rust: 467 passed, 20 ignored; strict Clippy passed.
- Companion: 28 tests passed; built-panel browser checks at 280/340px and
  100%/125% text passed. These are not a substitute for native UXP testing.
- Sidecar checksums and self-contained dependencies passed; yt-dlp restored to
  the locked upstream artifact and diarizer rebuilt from existing sources.
- Production catalog isolation, packaged companion bytes/permissions, NDI
  bridge/runtime and privacy metadata checks passed.
- DMG checksum verified. Read-only mounting confirmed build 2026090701 and the
  bundled companion; image was ejected without installing or launching the app.

## Still experimental / disabled

- Live-room comment-to-marker delivery remains disabled pending permission to
  share project/sequence identity with peers and completion of that wiring.
- Automatic marker placement remains disabled: NDI timing is not yet verified
  sequence timecode. Do not expect ordinary room comments to populate Premiere.
- Actual Premiere installation, host typography, local pairing, marker
  transactions, Undo and real-media timing still need validation. Use a disposable
  project. The companion does not replace Premiere's NDI output plugin.
- No public upload, notarization, DMG-installed media soak, or release approval
  was performed. Existing uncommitted work and previous archived builds remain.

## SHA-256

```text
41ec9254e7d22149c48dd7b9c9cc33dbae4002e5423fd8c16f3c2d68953c3443  Sauce Bunny 0.5.0 (2026090701).dmg
610380d5438f500790eeb1fd6ffba593ced14b8ae66133a64b8a803cedb2a765  Premiere Companion 0.1.0 (2026090701).zip
21c77fa31741b1d8d2cd6874a2ac7bcb8802c6132a46915d8347d12c6fc71e59  SauceBunnyPremiere.ccx
```
