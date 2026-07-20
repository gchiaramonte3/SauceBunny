# Sauce Bunny — Versioning & Update Mechanism: Decision Document

**Status:** decided, implementation-ready. **Date:** 2026-07-19.
**Verified repo state:** `/Users/gchiaramonte/Desktop/Clip Pull` and `/Users/gchiaramonte/sb-ui-v3` are two working copies of `github.com/gchiaramonte3/SauceBunny`, **both currently at `577db83`** ("pipeline: report how long each stage took"). They are in sync as of this session; edit either, but do the release work in one and pull in the other.

---

## 1. THE VERSION SCHEME — decided

### Recommendation: strict SemVer for the release version + a date-based `CFBundleVersion` build number.

This resolves the "reads nicely vs. updater can compare" conflict cleanly, because it puts each concern in the field that actually serves it:

- `tauri.conf.json > version` is **hard-validated as strict SemVer at config-parse time** (`tauri-utils-2.9.3/src/config.rs:3460-3512` — `Version::from_str(value).map_err(|_| DeError::custom("`tauri.conf.json > version` must be a semver string"))`). Non-SemVer does not build.
- That same string becomes `CFBundleShortVersionString` *and* the default `CFBundleVersion` (`config.rs:3617-3619`), and becomes `PackageInfo.version` (`tauri-codegen-2.6.3/src/context.rs:273-287`) — which is exactly what `getVersion()` returns and what the updater compares (`plugins-workspace` `updater.rs`: `release.version > self.current_version`, `semver` crate ordering).

**Therefore, rejected outright:**

| Candidate | Verdict | Why |
|---|---|---|
| yt-dlp style `2026.07.04` | **Invalid** | Leading zeros are illegal SemVer → Tauri config parse error, hard build failure. |
| Strada style `2026.7.17-1` | **Wrong for us** | `-1` is a SemVer **prerelease**: verified `semver.lt("2026.7.17-1","2026.7.17") === true`. Strada gets away with it because **Sparkle compares `CFBundleVersion`**, not the short string; Tauri compares the short string. Copying it copies the one field whose meaning flips between the two frameworks. |
| `1.1.0+2026071901` (build metadata) | **Silently broken** | SemVer excludes build metadata from precedence: `1.1.0+A == 1.1.0+B`. The updater would never offer an update. Worst failure mode of the four — looks correct, never fires. |
| git-commit-count build number | **Rejected** | Not monotonic across rebases/shallow clones. Repo is at ~201 commits; a rebase can lower it. |

**Steal from Strada the part that is actually good:** the monotonic date build number — but put it in `bundle.macOS.bundleVersion` (schema-confirmed key, `MacConfig` is `deny_unknown_fields`, so the spelling is exact), *not* in the short version. This field is currently unset (`src-tauri/tauri.conf.json:67-70` has only `minimumSystemVersion` and `entitlements`), which is why two "1.0.0" DMGs are indistinguishable in Finder Get Info, `mdls`, and crash reports.

### Exact strings for the next release: **0.2.0**

Do **not** ship "1.0.0" just because the file says so. Verified: the only git tag is `v0.1.0`, `CHANGELOG.md:41` has `## [0.1.0] — 2026-06-16` as the newest released heading, there is a **draft** GitHub Release at `v0.1.0`, and the `[Unreleased]` block (`CHANGELOG.md:6`) is enormous (co-review/P2P over iroh QUIC, ProRes fix, ScreenCaptureKit share). The `1.0.0` in the three files was never released and never tagged — it is drift, not a release.

```
src-tauri/tauri.conf.json:4     "version": "0.2.0"
src-tauri/tauri.conf.json       bundle.macOS.bundleVersion: "2026071901"
src-tauri/Cargo.toml:3          version = "0.2.0"
package.json:4                  "version": "0.2.0"
git tag                         v0.2.0   (annotated)
CHANGELOG.md                    ## [0.2.0] — 2026-07-19
```

Resulting bundle: `CFBundleShortVersionString = 0.2.0`, `CFBundleVersion = 2026071901`, DMG `Sauce Bunny_0.2.0_aarch64.dmg`.

Then **delete or repurpose the stale `v0.1.0` draft release** — a draft at that tag will confuse `/releases/latest/` later.

Cargo.toml and package.json are functionally shadowed (Cargo.toml is fallback-only; package.json is inert), but keep all three in lockstep so a future reader — or a future removal of the `version` key — cannot silently resurrect an old number.

> Do **not** use the `"version": "../package.json"` path indirection that the config schema allows. It is resolved **CWD-relative** (`config.rs:3460-3505`: `let path = PathBuf::from(value); if path.exists()`), and this project runs `cargo check` from `src-tauri/` but `npm run tauri build` from the repo root. It would work in one and hard-fail in the other. Use the sync script + guard instead.

### Bump rule

**Short version — hand-bumped, once per release:**
- **MAJOR** — reserved. Only a break in a user-facing contract (transcript library layout, review-doc JSON schema, the v1 Swift envelope).
- **MINOR** — the default at this velocity. Any release adding user-visible surface.
- **PATCH** — fix-only releases.
- **Never** a prerelease (`-rc.1`) or build-metadata (`+meta`) suffix. Prerelease sorts *below*; build metadata is *ignored*. Both break updater ordering. If a beta channel is ever wanted, use a second manifest endpoint, not a suffix.

**Build number `bundle.macOS.bundleVersion` — `YYYYMMDDNN`, never decreases:**
- `NN` = build ordinal for that UTC day, starting `01`.
- Same-day respin → `2026071902`, `03`, … New day → resets to `01`; the date prefix keeps it globally monotonic.
- Bump on **every DMG handed to anyone**, including respins of an unchanged short version. This is the field that makes two `0.2.0` DMGs distinguishable.

**Rule of thumb:** short version changes when *what the app does* changes; build number changes when *the bytes* change.

---

## 2. BACKEND_BUILD_ID — coexists, does not merge

**Decision: keep them strictly separate.** Do not replace, do not subsume, do not derive one from the other.

Current state, verified in sync: `src-tauri/src/commands/system.rs:715` and `src/lib/build-id.ts:10` both `"2026-07-19-r126-pipeline-timing"`, guarded by `src/lib/build-id.test.ts:16-23`, checked at startup in `src/App.tsx:1243-1251`.

Justification:

1. **The build-id is structurally incapable of failing in a shipped DMG.** It detects *intra-build incoherence* — a stale `target/debug` Rust binary against a hot-reloaded Vite bundle. That skew only exists because `tauri dev` compiles the halves independently. A `tauri build` compiles and staples them in one pass. The release version answers a completely different question: "which artifact is this, across machines and across time."
2. **Merging breaks one of them by construction.** The build-id churns per Rust-command change (~126 bumps so far). Fuse them and you must either bump the release version 126 times (meaningless to a tester) or bump at release cadence (the dev guard goes blind between releases). The current bug is already "the version never gets bumped" — merging guarantees the same fate for whichever concern loses.
3. **Different audiences.** `CFBundleShortVersionString` is user-visible by Apple's definition. `BACKEND_BUILD_ID`'s remediation text is literally "restart `npm run tauri dev`" — meaningless to someone holding a DMG.
4. **They already compose correctly.** `src/lib/diagnostics.ts:22-27` defines `appVersion`, `expectedBuildId`, and `backendBuildId` as three distinct fields; `src/App.tsx:3916-3933` populates all three into the diagnostics export. The version identifies the release; the build-id proves the halves match. Don't regress that.

The only coupling worth adding is **presentational**: an About row rendering `0.2.0 (2026071901)`.

`BACKEND_BUILD_ID` continues on its existing cadence per CLAUDE.md, untouched by this scheme.

---

## 3. UPDATE MECHANISM — decided, with the blocker stated plainly

### Decision: `tauri-plugin-updater` is the long-term target. **Sparkle rejected. Self-installing updates are BLOCKED on notarization. Ship a check-only notifier NOW.**

#### 3a. Sparkle — rejected

Sparkle's one real advantage is genuine and I won't hide it: **delta updates**. `src-tauri/binaries/` is 179 MB uncompressed (ffprobe 60M, ffmpeg 49M, yt-dlp 36M, llama-server 20M, diarize 9.7M, whisper-cli 3.1M) and the DMG is ~101-103 MB. Sidecars change rarely — close to the ideal delta case. Full-download-per-release is the strongest honest argument against my recommendation.

Rejected anyway, on four grounds:
1. The constitution forbids unjustified dependencies. Sparkle means an embedded ObjC framework + a `generate_appcast` XML toolchain + `tauri-plugin-sparkle-updater` at **v0.2.4, 28 stars, 7.6k downloads, one maintainer**. The shim, not Sparkle, is the risk.
2. Sparkle's built-in UI is a *liability* here. This app has hard design rules (`cp-` prefix, no green focus rings per `src/lib/focus-contract.test.ts`, grey chip CTAs). Sparkle's stock dialog violates all of them; suppressing it means writing custom UI anyway, erasing the main benefit.
3. GitHub Releases bandwidth is free and unmetered for public repos (`gh repo view` → PUBLIC), and the user base is small.
4. **Deltas are a later optimization; the minisign keypair is the thing you must get right on day one** — it is compiled into every shipped binary and cannot be rotated for users already in the field.

Revisit only if download size becomes a real user complaint.

#### 3b. What is blocked on notarization, and why — the non-obvious part

The naive blocker everyone assumes is **false**: a Tauri self-update does *not* get Gatekeeper-blocked. Verified chain — Gatekeeper assesses only items carrying `com.apple.quarantine`; quarantine is opt-in via `LSFileQuarantineEnabled` (Apple DTS/Quinn, Developer Forums 725487); `src-tauri/tauri.conf.json` does not set that key; and Tauri's macOS `install_inner` (plugins-workspace `updater.rs`) downloads via reqwest, extracts with the Rust `tar` crate, and does `fs::rename` swaps with **no xattr work at all**. So an un-notarized self-update relaunches fine.

**The real blockers are three, and the first one is decisive for *this specific app*:**

1. **TCC permission wipe on every single update.** macOS keys camera / microphone / screen-recording grants to the code signature (cdhash / designated requirement). An **ad-hoc signature produces a new identity on every build**, so macOS treats each update as a different app, drops the grants, and the re-prompt can silently fail to appear (requiring manual System Settings cleanup or `tccutil`). Sauce Bunny's headline features — the co-review room, dictation, and the `saucebunny-capture` ScreenCaptureKit sidecar — depend on all three. Today that pain is once-per-manual-install; auto-update makes it **once-per-release, silently**. That is strictly *worse* than manual installation. A Developer ID cert gives a stable TeamIdentifier and the grants survive.
2. **The updater payload is the known-broken flavor.** The updater consumes the raw bundler `.app.tar.gz`. Per the project's own verified notes (`~/.claude/projects/.../memory/dmg-signing-state.md`), an identity-less `npm run tauri build` yields `flags=0x20002 adhoc,linker-signed`, `codesign --verify` fails with "code has no resources", and the app reports "is damaged" on any other Mac. The working ad-hoc DMG requires a manual staged `ditto` → `xattr -cr` → `codesign --force --deep` recipe that **has no place in the updater pipeline**.
3. **It solves the wrong half.** Self-update fixes installs 2..N. Install #1 — the browser-downloaded, quarantined, un-notarized DMG that decides whether someone ever becomes a user — is untouched, and on macOS 15 Sequoia Apple *removed* the Control-click → Open override, so it now costs a trip through System Settings → Privacy & Security → Open Anyway → admin password.

Corroborating: Squirrel.Mac/Electron flatly require code signing for auto-update; Sparkle's own docs recommend Developer ID + notarization.

**Do not build on the quarantine-escape behavior.** It is an Apple implementation detail, undocumented as a guarantee, and the trend line is unambiguously toward more friction for non-notarized software.

#### 3c. What ships NOW: check-only notifier, zero new dependencies

- Plain unauthenticated `GET` of a static `latest.json` on GitHub Releases.
- **User-triggered** via Help > Check for Updates… (opt-in background check deferred to Phase 3).
- Compare against `getVersion()` — already imported at `src/App.tsx:3`.
- On newer: quiet in-app notice → button opens the releases page via `tauri-plugin-opener` (**already a dependency**).
- No new npm package, no Rust crate, no minisign keypair, no manifest signature. ~10-30 lines.

**Privacy:** the request carries User-Agent + IP and nothing else. **Never use the `{{current_version}}` / `{{target}}` / `{{arch}}` endpoint template variables** — they are the only mechanism by which client state leaks, and a static manifest doesn't need them. Static URL = zero-identifier request. Disclose it in one line on the Welcome screen and `SECURITY.md`, with a Settings toggle.

**This is forward-compatible:** when notarization exists, the same UI flips from "open release page" to "download and install." Nothing built in Phase 1/2 is thrown away.

#### 3d. Live bug to fix while you're in there

`src-tauri/src/lib.rs:261-265`:
```rust
"report_bug" => Some("https://github.com/saucebunny/saucebunny/issues/new/choose"),
"open_repo" | "check_updates" => Some("https://github.com/saucebunny/saucebunny/releases"),
```
All three URLs point at a repo that **does not exist** — `curl -L` returns **404**. The real remote is `github.com/gchiaramonte3/SauceBunny` (200). The Help > Check for Updates… menu item (`lib.rs:108`) currently opens a 404.

---

## 4. PHASED IMPLEMENTATION PLAN

### Phase 1 — Version scheme + release hygiene (works TODAY, no Apple credentials, no new deps)

**Files to touch:**

| Path | Change |
|---|---|
| `src-tauri/tauri.conf.json:4` | `"version": "0.2.0"` |
| `src-tauri/tauri.conf.json` (bundle.macOS, ~line 67) | add `"bundleVersion": "2026071901"` |
| `src-tauri/Cargo.toml:3` | `version = "0.2.0"` |
| `package.json:4` | `"version": "0.2.0"` |
| `package.json` scripts | add `"set-version": "bash scripts/set-version.sh"`, `"publish:release": "bash scripts/publish-release.sh"` |
| `CHANGELOG.md:6` | move `[Unreleased]` body under `## [0.2.0] — 2026-07-19` |
| **new** `scripts/set-version.sh` | writes the semver into all three files + stamps/increments `YYYYMMDDNN` |
| `scripts/check-notarization-ready.sh` | append version-lockstep gate before the "Toolchain" section |
| **new** `scripts/publish-release.sh` | tag + `gh release create --draft` + asset upload, with refusal gates |
| `src-tauri/src/lib.rs:261-265` | fix the three 404 URLs to `gchiaramonte3/SauceBunny` |
| `.claude/skills/release-dmg/SKILL.md:11` | "macOS 13+" → 14+ (stale vs. `tauri.conf.json:68`) |
| `.claude/skills/release-dmg/SKILL.md:95-116` | lists 6 sidecars; `externalBin` (`tauri.conf.json:51-60`) has **8** — add `saucebunny-dictate`, `saucebunny-capture` |

Working drafts of the three scripts exist at `/private/tmp/claude-501/-Users-gchiaramonte-Desktop-Clip-Pull/92bfcb45-9457-47f6-8505-f1e0999a9728/scratchpad/{set-version.sh,check-version-lockstep.sh.snippet,publish-release.sh}` — verified to produce zero formatting churn in `tauri.conf.json` and to leave `tauri = { version = "2" ... }` in Cargo.toml untouched.

**Version-lockstep gate must fail on:** drift across the three files; a non-bare-semver version; a version already tagged; missing `bundleVersion` (warn); `BACKEND_BUILD_ID` mismatch between `system.rs:715` and `build-id.ts:10`.

**Why a guard rather than an indirection:** a sync mechanism someone forgets drifts silently — that is precisely how this repo reached four disagreeing version sources. The guard lives inside the preflight the user *already runs before every build* and cannot be forgotten.

**CI (cheap, do it):** add `push: tags: ['v*']` to `.github/workflows/ci.yml:3-6` so the existing four jobs re-run on tags. **Do not add a DMG-building job** — `scripts/fetch-ffmpeg.sh:47-56` scrapes the osxexperts.net *homepage* for "whatever zip is latest today," and yt-dlp/ffprobe fetches have the same semantics, so a CI build of a tag would silently bundle different sidecars than `SIDECAR-VERSIONS.md` records. Plus 4 of the 8 sidecars are stubbed as zero bytes in both workflows (`ci.yml:24-31`, `nightly-sidecars.yml:84-91`). Build the DMG **locally**.

**Gates for Phase 1:**
```bash
npx tsc --noEmit
npm test
npm run test:e2e
(cd src-tauri && cargo check && cargo test --lib && cargo clippy -- -D warnings)
(cd swift-sidecar && swift build)
npm run check:release      # now includes the lockstep gate
```

### Phase 2 — About surface + check-only notifier (works TODAY, no Apple credentials, no new deps)

**Files to touch:**

| Path | Change |
|---|---|
| `src/App.tsx` | wire the existing `menu:check_updates` event (emitted at `lib.rs:273-275`, already consumed at `App.tsx:4379-4387`) to a real check |
| `src/lib/` — **new** `update-check.ts` | `fetch()` the static manifest, semver-compare against `getVersion()`, persist `saucebunny.lastUpdateCheck` in localStorage (existing namespace convention) |
| `src/components/` (Settings modal) | About row: `0.2.0 (2026071901)` + "Check for updates" chip (grey chip CTA per project convention, no green) |
| `src/styles/app.css` | any new `cp-`-prefixed classes |
| Welcome screen + `SECURITY.md` | one-line disclosure: "Sauce Bunny checks a static file on GitHub for new versions. No identifying information is sent." |

CTA opens `https://github.com/gchiaramonte3/SauceBunny/releases/latest` via `tauri-plugin-opener`. Manifest endpoint: `https://github.com/gchiaramonte3/SauceBunny/releases/latest/download/latest.json` — **no template variables**.

No Rust changes → **no `BACKEND_BUILD_ID` bump needed** in this phase.

**Gates:** same as Phase 1, plus manual `npm run tauri dev` with no console errors.

### Phase 3 — `tauri-plugin-updater` (BLOCKED until §5 is done and a notarized DMG has shipped)

Gate on **both**: (a) Developer ID cert exists and a notarized DMG has actually shipped, and (b) release cadence is high enough that manual re-download genuinely hurts.

**Files to touch:**

| Path | Change |
|---|---|
| `src-tauri/Cargo.toml` (after line 33) | `tauri-plugin-updater = "2"` |
| `src-tauri/tauri.conf.json` bundle | `"createUpdaterArtifacts": true` (`bundle.targets` already includes `"app"` — precondition satisfied) |
| `src-tauri/tauri.conf.json:73` | replace `"plugins": {}` with `updater: { pubkey: "<contents>", endpoints: ["…/releases/latest/download/latest.json"] }` |
| `src-tauri/src/lib.rs` (after line 136) | `.plugin(tauri_plugin_updater::Builder::new().build())` |
| `src-tauri/src/commands/system.rs` | `check_for_update` + `install_update`, `Result<T, AppError>`, `#[derive(ts_rs::TS)]` on `UpdateInfo`; emit download progress as a window event |
| `src-tauri/src/commands/system.rs:715` **and** `src/lib/build-id.ts:10` | **bump both together** — new invoke surface |
| `src/bindings/UpdateInfo.ts` | regenerates via `cargo test --lib` |
| `src-tauri/capabilities/default.json` | **only if** a runtime ACL error appears — Rust-side `UpdaterExt` should bypass the JS ACL, but this is unconfirmed |
| `scripts/publish-release.sh` | rename tarball to space-free (**GitHub rewrites spaces in asset names** → manifest 404), generate `latest.json` inlining the `.sig` **contents**, upload all three assets |

**Rollout sequence — do not skip step 2:**
1. Ship **0.2.0** notarized, carrying the updater plugin. Users on older builds install this one manually; nothing before it can ever auto-update.
2. Ship **0.2.1** as a trivial change, used purely to exercise check → download → install → relaunch. Then **verify camera / mic / screen-recording TCC grants survived**, and `ls -l` the sidecars inside the updated bundle to confirm exec bits survived the tar round-trip.
3. Only then enable an opt-in background check (once per launch, throttled ≥24h). **Never** auto-download, **never** auto-install — this app runs long transcription/diarization jobs and hosts live co-review sessions.

**Gates:** all of Phase 1's, plus `cargo test --lib` (regenerates bindings + enforces build-id parity), plus the manual 0.2.0→0.2.1 update test.

---

## 5. ONE-TIME APPLE SETUP — FOR THE USER, BY THE USER

**These are your credentials. Do not paste any password, app-specific password, `.p12`, or API key into a chat with any agent, and do not commit them. Run every command yourself.**

Two gates in `scripts/check-notarization-ready.sh` **already pass** with no work: entitlements wiring (lines 99-103) and `minimumSystemVersion == "14.0"` (lines 110-115). The *only* failing gates are the credential ones (lines 119-139). Hands-on time once enrollment is Active: **20-30 minutes**.

**Step 1 — Confirm enrollment (5 min).** developer.apple.com/account → Membership. You need status **Active** and a 10-character **Team ID**. Having an Apple developer account ≠ being enrolled in the paid $99/yr program. Individual approval can take 24-48h. **Check this first** — nothing below works until it shows Active.

**Step 2 — Create a Developer ID Application certificate (10 min).** Either:
- *Xcode:* Settings → Accounts → your Apple ID → Manage Certificates → **+** → **Developer ID Application**.
- *Portal:* Keychain Access → Certificate Assistant → Request a Certificate From a CA → "Saved to disk" → upload the `.certSigningRequest` at developer.apple.com/account/resources/certificates → **+** → **Developer ID Application** → download the `.cer` → double-click.

⚠️ It must be **Developer ID Application** — not "Apple Development" (sets `get-task-allow`, notarization hard-rejects; caught by `check-notarization-ready.sh:124-126`), not "Mac App Distribution."
⚠️ **Export a `.p12` backup immediately** (Keychain Access → right-click → Export). The private key exists only on the Mac that generated the CSR.

**Step 3 — Verify (10 sec).**
```
security find-identity -v -p codesigning
```
Must print `Developer ID Application: <Your Name> (TEAMID)`. Today it prints `0 valid identities found`.

**Step 4 — App-specific password (2 min).** appleid.apple.com → Sign-In and Security → App-Specific Passwords → **+** → label `saucebunny-notary`. The `xxxx-xxxx-xxxx-xxxx` string is shown **once**.

**Step 5 — Store it in the Keychain (1 min)** so it never sits in plaintext (`DISTRIBUTION.md:84-89`):
```
xcrun notarytool store-credentials "saucebunny-notary" \
  --apple-id "your@apple.id" --team-id "YOURTEAMID" --password "<app-specific-password>"
```

**Step 6 — Export env vars in the shell that runs the build (2 min)** (`DISTRIBUTION.md:92-97`):
```
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (YOURTEAMID)"
export APPLE_ID="your@apple.id"
export APPLE_PASSWORD="@keychain:saucebunny-notary"
export APPLE_TEAM_ID="YOURTEAMID"
```
⚠️ Tauri accepts **exactly one** notary combo — this Apple-ID trio *or* the API-key trio (`APPLE_API_KEY`/`APPLE_API_ISSUER`/`APPLE_API_KEY_PATH`). Setting both is a documented footgun (`SKILL.md:52-59`). If **neither** is set, Tauri signs and **silently skips notarization** — the quiet failure mode to watch for.

**Step 7 — Gate (30 sec).** `npm run check:release` must be all ✓ and exit 0. Then `npm run tauri build` produces the signed + notarized + stapled DMG in one pass; verify with `SKILL.md:174-194`.

**Step 8 — Phase 3 only: the minisign keypair.** `npx tauri signer generate -w ~/.tauri/saucebunny-updater.key`. **Back the private key and its password up off this machine before the first signed build.** Losing it permanently ends your ability to update every installed copy. `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` must be **real environment variables** — Tauri's docs are explicit that `.env` files do not work. The `pubkey` in `tauri.conf.json` is the key **contents**, not a path.

---

## 6. RELEASE RUNBOOK (Phase 1+2, replaces §2/§8 of the release-dmg skill)

```bash
npm run set-version -- 0.2.0             # 1. all three files + bundleVersion
                                          # 2. move [Unreleased] under ## [0.2.0]
npm run setup                             # 3. SKIP if binaries/ is fresh — these
                                          #    fetch "latest" and change what you ship
npx tsc --noEmit && npm test && npm run test:e2e
(cd src-tauri && cargo check && cargo test --lib && cargo clippy -- -D warnings)
(cd swift-sidecar && swift build)
npm run check:release                     # 4. must be all ✓ (now incl. lockstep)
git commit -am "release: 0.2.0"           # 5. BEFORE building — publish gate needs
                                          #    a clean tree + DMG newer than HEAD
npm run tauri build                       # 6. sign + notarize + staple in one pass
                                          # 7. verify (SKILL.md §7 steps 1-5)
npm run publish:release                   # 8. tag + draft release + upload
                                          #    add -- --publish to go live
```

`publish-release.sh` refuses to run if: the DMG is missing, the DMG is **older than HEAD** (the single easiest release mistake), the tree is dirty, the DMG isn't notarized+stapled (override `SB_ALLOW_UNSIGNED=1`), or `CHANGELOG.md` lacks a `## [X.Y.Z]` section. Defaults to `--draft`; publishing is outward-facing — confirm with the user before the first `--publish`.

⚠️ `gh` must be authenticated as **gchiaramonte3**, not GasperC3, or the push 403s on a keychain mismatch. Fix: `gh auth setup-git`.

---

## 7. RESIDUAL RISKS

**Blocking:** no Developer ID certificate on this Mac. Every DMG until §5 is done is ad-hoc signed and greets downloaders with a Gatekeeper wall. All the version tooling is worthless if the artifact scares people off — this is the real critical path.

**Reproducibility:** (a) `src-tauri/Cargo.lock` is **gitignored** (`.gitignore:8`) — a tag cannot reproduce its own dependency graph. Unusual for a shipping binary crate; worth a separate decision. (b) Sidecar fetches are unpinned (`fetch-ffmpeg.sh:47-56` scrapes a homepage) — running `npm run setup` right before a release *changes what you ship versus what you tested*. Pinning versions + checksums is the deeper fix and the precondition for ever moving the build to CI.

**A CI-built DMG would ship zero-byte sidecars.** Both workflows `touch` stubs. `check-notarization-ready.sh:34-42` catches this — but only if it runs, so any future release workflow must *call* `npm run check:release` as a gate, not mention it in a comment.

**Phase 3 specifics:** ~100 MB per update with no deltas (never auto-download; show the size; show a determinate progress bar). Running from a mounted DMG makes the bundle swap fail on a read-only volume — detect and say "Move Sauce Bunny to Applications first" rather than surfacing a raw IO error. Verify sidecar exec bits survive the tar round-trip (same failure class as `sidecar-corruption-restore.md`). The GitHub Release must **not** be a draft or prerelease or `/releases/latest/` silently serves the previous manifest. Test the `releases/latest/download/` redirect actually resolves through `objects.githubusercontent.com` for Tauri's HTTP client; fall back to a committed `raw.githubusercontent.com` path if not.

**Lower-confidence claims, flagged honestly:** (1) the Rust-side updater needing no `updater:default` capability is reasoned, not documented — add it if a runtime ACL error appears; (2) Apple's `CFBundleVersion` 10-digit budget comes from the *archived* key reference, and `2026071901` technically exceeds it — inconsequential here since Strada ships exactly this form and only App Store Connect enforces the rule, which this app never faces; (3) "macOS Tahoe 26.2+ tightens Gatekeeper further" comes from secondary sources — directionally believable, not quotable as fact.

**First notarization run will surface sidecar issues.** All 8 `externalBin` entries get re-signed; `DISTRIBUTION.md:143-156` lists the common rejects (unsigned nested binary, missing hardened runtime, library-validation failure from yt-dlp's PyInstaller dylibs). Budget one or two rejected submissions before the first clean pass — that is normal.