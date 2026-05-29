# Distribution

Sauce Bunny ships as a **notarized, self-hosted `.dmg`** distributed via
your own download page (or GitHub Releases, or Homebrew Cask). It does
**NOT** target the Mac App Store. This document is the source of truth
for why, the release workflow that gets a clean Gatekeeper experience,
and the constraints that follow.

---

## Why not the Mac App Store

Three blockers, in order of severity. Future contributors should know
these so the codebase doesn't drift toward MAS compliance at the cost
of the actual product.

### 1. Bundled `yt-dlp`

App Store Review Guideline **5.2.3** explicitly bans apps that let
users download from streaming services they don't own ("Apps that
enable users to view, listen to, or display content from media
services they do not have the rights to may not be permitted").
YouTube downloaders have been rejected on this rule for ~15 years.
There is no appeal path.

We have made the explicit decision to keep `yt-dlp`. Section 1 of
this doc is therefore load-bearing — the codebase should NOT chase
MAS-only changes (App Sandbox, security-scoped bookmarks, helper-
app refactor of sidecars, etc.) because the product is barred from
that distribution channel on a separate rule.

### 2. App Sandbox + arbitrary subprocess spawning

App Store apps MUST run in the App Sandbox. The sandbox blocks
`posix_spawn` of arbitrary executables — even bundled ones — unless
they're declared via the narrow `LSEnvironment` / helper-app
mechanism. Sauce Bunny spawns `ffmpeg`, `whisper-cli`, `yt-dlp`, and
`saucebunny-diarize` as Tauri sidecars. Possible to refactor each
into a notarized helper app inside the bundle, but expensive and
doesn't move the product forward.

### 3. `--cookies-from-browser` reads other apps' data

`yt-dlp`'s YouTube-auth flow reads Chrome/Safari cookies from
`~/Library/Application Support/...`. Sandboxed apps can't read other
apps' Application Support directories without per-folder user
consent prompts. Either drop the feature (which we use to bypass
YouTube's bot-detection) or scope it to a user-picked file.

---

## What this means for our build

The above constraints are App-Store-specific. For self-hosted
notarized `.dmg`, none of them apply:

| Concern | App Store | Self-hosted notarized DMG |
|---|---|---|
| yt-dlp bundled | ❌ rejected | ✅ allowed |
| Spawn arbitrary subprocesses | ❌ sandbox-blocked | ✅ allowed |
| Read cookies from other apps | ❌ requires user picker | ✅ allowed |
| Write to `~/Documents/Sauce Bunny/` | ⚠️ requires entitlement | ✅ default-allowed |
| `com.apple.security.cs.disable-library-validation` | ❌ banned entitlement | ✅ allowed |
| Apple Developer Program required | ✅ yes ($99/yr) | ✅ yes ($99/yr) |
| Notarization required | N/A (App Store does it) | ✅ via `xcrun notarytool` |
| Gatekeeper / "App is from an unidentified developer" warning | Auto-handled | Solved by notarization + stapling |

We get the same trust signal (Gatekeeper green-lights the download)
via notarization without paying the product cost of sandbox compliance.

---

## Release flow (first time setup)

### One-time

1. **Enroll in the Apple Developer Program** — $99/yr. https://developer.apple.com/programs/
2. **Generate a Developer ID Application certificate** in your Apple
   Developer account. Download + install into your Keychain. This is
   NOT the same as a "Mac Developer" or "Mac App Distribution" cert
   — make sure it's the **Developer ID Application** flavour.
3. **Create an app-specific password** for `notarytool` at
   https://appleid.apple.com/. Store it in keychain:
   ```bash
   xcrun notarytool store-credentials "saucebunny-notary" \
     --apple-id "your@apple.id" \
     --team-id "YOURTEAMID" \
     --password "<app-specific-password>"
   ```
4. **Export environment variables** for the build (or put them in
   your shell profile):
   ```bash
   export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (YOURTEAMID)"
   export APPLE_ID="your@apple.id"
   export APPLE_PASSWORD="@keychain:saucebunny-notary"
   export APPLE_TEAM_ID="YOURTEAMID"
   ```

### Each release

```bash
# 1. Make sure every sidecar is current + dep-clean (no /opt/homebrew refs)
npm run refresh:sidecars         # yt-dlp from official release
npm run refresh:ffmpeg           # ffmpeg static arm64 from osxexperts
npm run build:whisper            # whisper.cpp from source, static
npm run build:diarizer           # saucebunny-diarize from swift-sidecar/

# 2. Confirm cargo + tsc + swift all pass
npx tsc --noEmit
(cd src-tauri && cargo check)
(cd swift-sidecar && swift build)

# 3. Build, sign, and notarize the DMG in one shot
#    (Tauri reads APPLE_* env vars and calls codesign + notarytool for us)
npm run tauri build

# 4. Output lands at:
#    src-tauri/target/release/bundle/dmg/Sauce Bunny_<version>_aarch64.dmg
#    The notarization ticket is automatically stapled — no manual step.

# 5. Verify before shipping
spctl --assess --verbose=4 --type install "src-tauri/target/release/bundle/dmg/Sauce Bunny_*.dmg"
# Expect: "accepted, source=Notarized Developer ID"

# 6. Upload the .dmg to your distribution channel (GitHub Releases,
#    your site, Homebrew Cask formula, etc.).
```

If notarytool rejects the build, run:
```bash
xcrun notarytool history --keychain-profile saucebunny-notary
xcrun notarytool log <submission-id> --keychain-profile saucebunny-notary
```

The log JSON's `issues` array names every offending binary + the rule
it violated. The most common rejects for apps like ours:

- **Unsigned binary** — usually a sidecar that wasn't re-signed by
  Tauri's bundler. Check `codesign -dv <path>` on each binary under
  `src-tauri/target/release/bundle/macos/Sauce Bunny.app/Contents/MacOS/`.
- **Hardened Runtime missing on a binary** — same fix path.
- **Library validation failed** — yt-dlp / PyInstaller dylib in /tmp.
  Means our `entitlements.plist` isn't being applied. Check that
  `tauri.conf.json` → `bundle.macOS.entitlements` points at the file.
- **`get-task-allow` is true** — only happens with development certs.
  Make sure `APPLE_SIGNING_IDENTITY` is `Developer ID Application: …`
  not `Apple Development: …`.

---

## Sidecar discipline (the rule that bites every distribution)

Every binary in `src-tauri/binaries/` MUST be self-contained. The
audit:

```bash
for bin in src-tauri/binaries/*-aarch64-apple-darwin; do
  otool -L "$bin" | grep -E '/opt/homebrew/|/usr/local/|/Users/' \
    && echo "✗ $bin LEAKS" \
    || echo "✓ $(basename $bin)"
done
```

If anything prints `✗ LEAKS`, the app crashes at startup on a user's
Mac without that exact Homebrew install. The `cp /opt/homebrew/bin/X
src-tauri/binaries/X-aarch64-apple-darwin` pattern is **forbidden**
for this reason. Each updater script under `scripts/` enforces the
audit as a guard rail and refuses to install a leaky binary.

| Binary | Updater | Source |
|---|---|---|
| `yt-dlp-aarch64-apple-darwin` | `npm run refresh:sidecars` | yt-dlp's static single-file release |
| `ffmpeg-aarch64-apple-darwin` | `npm run refresh:ffmpeg` | osxexperts.net (static arm64) |
| `whisper-cli-aarch64-apple-darwin` | `npm run build:whisper` | whisper.cpp source, `-DBUILD_SHARED_LIBS=OFF` |
| `saucebunny-diarize-aarch64-apple-darwin` | `npm run build:diarizer` | `swift-sidecar/` (ours) |

---

## Entitlements explained (`src-tauri/entitlements.plist`)

We grant the minimum the Hardened Runtime requires for the app to
function. Each entitlement loosens a specific check that would
otherwise block real runtime behaviour.

| Entitlement | Why we need it |
|---|---|
| `com.apple.security.cs.allow-jit` | whisper.cpp's Metal compute kernels are technically JIT-compiled at first use. WKWebView's JavaScript JIT also relies on this. |
| `com.apple.security.cs.disable-library-validation` | yt-dlp ships as a PyInstaller bundle that self-extracts its dylibs to a randomized `/tmp` directory and `dlopen()`s them. Those dylibs are signed by PyInstaller, not by our Developer ID, so library validation blocks the load without this entitlement. |
| `com.apple.security.network.client` | Allowed by default for Developer ID + Hardened Runtime, but declared explicitly so the entitlement surface is documented. |

**NOT declared** (and why):

- `com.apple.security.app-sandbox` — not a sandboxed app (see top of doc).
- `com.apple.security.cs.allow-unsigned-executable-memory` — only needed if we have code that writes to executable memory pages (we don't; the Metal JIT goes through Apple's API which doesn't trip this).
- `com.apple.security.cs.allow-dyld-environment-variables` — only needed if we set `DYLD_*` env vars at runtime (we don't).
- `com.apple.security.cs.debugger` — debug-only, never ship.

If you add a new runtime behaviour that needs a new entitlement,
add it here with a one-line "why" comment in the plist + a row in
the table above. The principle is least-privilege: every additional
entitlement is one more bypass of macOS's protection model and one
more thing a future security review has to justify.

---

## Open-source posture

The product is licensed MIT (see `LICENSE`). Contributors should:

- Treat the **sidecar discipline** above as a hard rule, not a
  guideline. A PR that introduces `cp /opt/homebrew/bin/X …` should
  be closed.
- Add new Tauri commands behind `Result<T, AppError>` (not
  `Result<T, String>`). See CLAUDE.md refactor priority #4.
- Add new cross-boundary structs with `#[derive(ts_rs::TS)]` so the
  generated TS binding is the single source of truth. See CLAUDE.md
  refactor priority #3.
- Run `npm run tauri build` locally and confirm `spctl --assess`
  accepts the resulting `.dmg` before opening a release PR.
