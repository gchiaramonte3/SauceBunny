# Windows: what it would actually take

Asked 2026-08-25: "can you bundle this application as a Windows version as well?"

Short answer: **yes, technically — but it is a project, not a build flag, and none of it
can be produced from a Mac.** `CLAUDE.md:30` currently says "macOS 14+, Apple Silicon
only. No Windows/Linux builds"; this document is the costing behind that line, so the
next person to ask gets numbers instead of a shrug.

## It cannot be cross-compiled from macOS. Measured, not assumed.

`cargo check --target x86_64-pc-windows-msvc` was run. It fails before reaching a single
line of app code, in `ring` (a transitive C dependency of iroh/reqwest):

```
ring-0.17.14/include/ring-core/check.h:27:11: fatal error: 'assert.h' file not found
error occurred in cc-rs: ... "--target=x86_64-pc-windows-msvc" ... curve25519.c
```

There is no Windows C runtime or MSVC SDK on the machine, and `cc` cannot invent one.
Four more walls stand behind that first one, in order:

1. **`objc2` refuses to build.** `objc2`, `objc2-foundation` and `objc2-app-kit` sit in
   plain `[dependencies]` (`src-tauri/Cargo.toml:30,35,42`), not under a macOS target
   table, so Cargo resolves them for every target. `objc2` carries a literal
   `compile_error!("objc2 only works on Apple platforms")`. Same story for `xattr`
   (`Cargo.toml:52`), which is unix-only.
2. **A framework link that is illegal off-Apple.** `#[link(name = "CoreGraphics", kind =
   "framework")]` at `src-tauri/src/commands/media.rs:2617` is completely ungated;
   `kind="framework"` is an error on non-Apple targets (rustc E0455). It backs the
   screen-capture permission preflight and display enumeration.
3. **Tauri cannot bundle it here.** MSI needs WiX (Windows-only). Tauri documents NSIS
   cross-compilation as an untested last resort, and states a cross-compiled installer
   needs a custom sign command. `tauri.conf.json` has `targets: ["app","dmg"]` and no
   `bundle.windows` section at all.
4. **Three of the eight sidecars have no Windows form.** `externalBin` lists eight;
   `saucebunny-diarize`, `saucebunny-dictate` and `saucebunny-capture` are Swift built on
   Core ML, the Speech framework and ScreenCaptureKit respectively
   (`swift-sidecar/Package.swift:29` is `platforms: [.macOS(.v14)]`). `whisper-cli` and
   `llama-server` exist on Windows but must be rebuilt with MSVC.

Everything past step 1 needs a `windows-latest` runner or a Windows box.

## Nothing here is impossible — it is expensive

Every blocker was put through an adversarial pass whose job was to refute it. **All of
them fell**: each has a real Windows route. The reason is architectural and worth
stating, because it is the thing that makes a port tractable at all — **the hard parts
are separate processes behind frozen contracts.** The diarizer is a spawned binary that
emits a v1 JSON envelope whose Rust consumer reads exactly three fields (`speaker`,
`start`, `end` — `transcript.rs:2701`). Replacing it on Windows means writing a new
binary that prints the same JSON, not touching the app.

Better still, the app **already degrades gracefully** when these are missing, because
that is what a macOS checkout does before `npm run build:diarizer` has been run:

- `detectSpeakers` defaults to **off** (`src/App.tsx:246`);
- six call sites catch a diarizer failure and still report success — "Speaker detection
  failed — transcript saved without speaker labels" (`transcript.rs:1468, 1635, 2378,
  2516, 2637`);
- screen share already falls back to plain ffmpeg when the capture sidecar is absent
  (`stream_proxy.rs:2079`), gated on `ShareSources.capture_engine` (`media.rs:2743`).

## Cost

| Area | Days | Note |
|---|---:|---|
| Release tooling + packaging | 18 | `otool` in 11 scripts, `codesign`, `notarytool`, `hdiutil`, `PlistBuddy`. The verifiers each encode a defect that really shipped; recreating them without those gates is a regression |
| Screen capture parity | 10–15 | Windows.Graphics.Capture + WASAPI loopback. ~2d for a display-only fallback via `gdigrab`/`ddagrab` |
| Diarization replacement | 8–14 | sherpa-onnx (Apache-2.0) or pyannote-rs (MIT) behind the same JSON contract. **~1d to simply ship without it** |
| Rust backend cfg-gating + native APIs | 20 | Trash, clipboard, displays, FIFO→named pipes, sidecar triple/PATH/exec-bit |
| Live dictation | 5–8 | Or 0 — the ffmpeg dictation path survives the port |
| Hardware encoding | 3.5 | nvenc/qsv/amf probing. **Licensing decision:** libx264 is GPL, unlike the LGPL ffmpeg recorded in THIRD-PARTY-LICENSES.md |
| Keyboard | 3 | See below — this one actively misbehaves |
| **Total, full parity** | **~90–110** | |
| **Reduced build** | **~55–65** | drops diarization, window/portion share, native dictation, Finder tags |

Roughly **15–20 of those days are doable on a Mac**: cfg-gating until `cargo check
--target` passes, the keyboard port, path separators, and parameterising the target
triple through the 16 files that hardcode `aarch64-apple-darwin`. The frontend needs
little: the Playwright suite already runs **234/234 green in Chromium**, which is the
engine WebView2 ships.

**Not in the day count:** Windows code signing is a procurement problem first. Since the
2023 CA/B rules the key must live on FIPS-140-2 L2 hardware or a cloud HSM, and an OV
certificate still trips SmartScreen until reputation accrues. Start that early.

## The one blocker that misbehaves rather than degrades

`keybindings.ts:223` serialises only `metaKey` as `"mod"` and drops `ctrlKey` entirely.
On Windows every `mod+` binding becomes unreachable AND the bare key fires instead:
Ctrl+W → `mark.gotoOut`, Ctrl+K → `play.toggle`, Ctrl+I/O → set marks. Five hand-coded
listeners additionally reject `ctrlKey` outright (`TranscriptViewer.tsx:701, 727`;
`LibraryBrowser.tsx:373`). Anything else on this list fails loudly or turns itself off;
this one silently does the wrong thing.

## What Windows would still be

Even the reduced build keeps the spine: import and library, the player and timeline,
frame-accurate marks and clip export, transcription and captions, the transcript reader
and review, co-review sessions, and display screen-sharing. What it loses is speaker
labels (and the cast/speaker-colour surfaces built on them), window/portion sharing,
native live dictation, and Finder tags — the last of which has no meaning on Windows
anyway, since the feature exists to interoperate with Finder.
