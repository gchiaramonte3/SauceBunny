# Third-Party Licenses & Acknowledgements

Original Sauce Bunny application code is licensed under the [MIT License](LICENSE).
The current Tauri application does not link libobs; the developer-only GPL
helper exception is documented below. The app does link weak copyleft:
mediabunny, `@mediabunny/prores` and turbores are MPL-2.0, and LAME inside
`@mediabunny/mp3-encoder` is LGPL — all bundled into the JS by Vite, and all
listed below. Redistributors therefore carry MPL source-availability and LGPL
relinking obligations for those components. The distributed app additionally
**bundles several third-party binaries** (each invoked as a *separate
subprocess*, not linked into the app) and uses third-party libraries, a font,
and — at the user's
option, downloaded at runtime — machine-learning models. Their licenses are
disclosed below.

The sidecar binaries are **not** checked into this repository; they are fetched
or built locally by `npm run setup` (see `scripts/`). This notice covers what
ships inside a released `.dmg`.

---

## Embedded OBS development helper (not shipped)

OBS-linked source in `obs-sidecar/` is GPL-2.0-or-later. The independent
`raw-frame.hpp` wire-format header explicitly carries MIT instead. The GPL v2 text is in
[`obs-sidecar/COPYING`](obs-sidecar/COPYING); the “or later” grant appears in
the source notices. It embeds OBS Studio 32.2.2/libobs and uses SIMDe 0.8.2
headers (MIT). Original application files retain their existing MIT notices.
The current engine, OpenGL backend and OBS FFmpeg plugin are built from pinned
OBS source, with recorded capture-privacy/global-input patches. Runtime libraries
and SIMDe headers come from the hash-pinned OBS dependency archive; its supplied
license collection is retained in the private runtime. A generated Mach-O
inventory records actual dynamic linkage, not complete static source coverage.

These private probes/workers are **not** registered as release sidecars or included
in current DMGs. An internal-only app stager can embed the two application
helpers and their dependency closure in `Contents/Helpers/OBS.bundle`, retaining
the supplied license/source materials beneath its `Contents/Resources`.
Its inventory remains explicitly non-distributable. These temporary bundles contain OBS's FFmpeg dependencies
and must not be redistributed as a finished licensing package. Before any
release including OBS, complete the corresponding-source/build-materials and
dependency-notice inventory and review the final combination, including the
separate NDI SDK terms. A subprocess boundary alone is not a blanket exemption.
See [the implementation and verification record](docs/EMBEDDED-OBS-CAPTURE.md).

The separate development sender in `src-tauri/native/ndi_sender*` is original
MIT code. It shares only that MIT wire header, not libobs or OBS-derived code.
It compiles against NDI SDK headers and dynamically loads the NDI runtime only
for an explicit broadcast invocation. This architectural separation does not
itself clear the combined distribution; the review and source-material gates
above still apply. It is not included in current DMGs.

---

## AAF reader

The `saucebunny-aaf` subprocess contains the first-party MIT reader, pyaaf2
1.7.1, CPython 3.12.14, and the PyInstaller 6.22.3 bootloader/runtime. The
component notices, including the PyInstaller bootloader exception and Python's
incorporated notices, are retained in
[`aaf-sidecar/THIRD-PARTY-LICENSES.txt`](aaf-sidecar/THIRD-PARTY-LICENSES.txt).
That notice file is included both in the helper and in the app's resources.
The build recipe and pinned build dependencies are in `scripts/build-aaf.sh`
and `aaf-sidecar/requirements-build.txt`.

## Local video intelligence worker

The separate `saucebunny-video` process contains original MIT code, CPython
3.12.14, MLX/MLX-VLM, usearch, PyAV and their pinned dependencies. The complete
build/runtime dependency inventory and supplied notices are packaged under
`video-runtime/saucebunny-video/_internal/licenses/dependencies/`, including
Python's incorporated notices and the PyInstaller bootloader exception.
Downloaded Qwen repositories include their model licenses; their exact
revisions and artifact hashes are in `video-sidecar/models.json`.

The experimental, currently unregistered `video-sidecar/audio_ast.py` adapts
Transformers' Audio Spectrogram Transformer inference to MLX/NumPy. Its upstream
copyright and Apache-2.0 notice are retained in the file; the complete license
is in [`licenses/TRANSFORMERS-APACHE-2.0.txt`](licenses/TRANSFORMERS-APACHE-2.0.txt).
The adaptation replaces PyTorch model operations and uses pinned local
safetensors only. It is not part of the dispatched worker or model catalog.
The separately downloaded MIT AST checkpoint is not included in this repository;
see the pinned provenance in `scripts/music-analysis/README.md` before packaging.

This worker dynamically links an **LGPL-2.1-or-later-only FFmpeg 8.0.3 build**,
not the application's separate GPL FFmpeg command-line sidecar. GPL/nonfree
features and external codec autodetection are disabled. PyAV is compiled from
pinned source against these libraries; vendor wheel codec libraries and OpenCV
are excluded from the frozen runtime. Exact unmodified FFmpeg source, license
and configure log are included under `_internal/licenses/ffmpeg/`.

Rebuild recipes and hash locks are in `scripts/build-video*.sh` and
`video-sidecar/requirements*.txt`. Dynamic libraries remain replaceable in
`_internal/av/.dylibs/`; a modified local macOS app copy may need re-signing.
The app does not forbid reverse engineering of these LGPL components for
debugging modifications. Redistributors must retain the accompanying source,
notices and applicable LGPL rights; a subprocess boundary alone does not remove
license obligations.

---

## NDI runtime (proprietary, optional feature)

NDI-enabled macOS builds include the standard NDI 6.3.2 runtime as
`Contents/Frameworks/libndi.dylib`, loaded dynamically only when Premiere/NDI
setup or receiving is requested. It is not an MIT-licensed component.
Sauce Bunny's own source remains MIT licensed.

Copyright (C) 2023-2026 Vizrt NDI AB. All rights reserved.
NDI® is a registered trademark of Vizrt NDI AB. Sauce Bunny is not endorsed
by NDI. Information: <https://ndi.video/>.

The bundle includes the vendor's complete `libndi_licenses.txt`, the scoped
`NDI-RUNTIME-TERMS.txt`, and version/checksum provenance under
`Contents/Resources/licenses/`. The build validates the standard SDK runtime
and its vendor signature before staging it; NDI Tools, the SDK, and the Adobe
Premiere output plugin are not distributed with Sauce Bunny.

The editor installs the official Premiere plugin through
<https://ndi.video/tools/>. Remote reviewers do not install NDI Tools or the SDK.
Redistribution must comply with the current NDI SDK license and
<https://docs.ndi.video/all/developing-with-ndi/sdk/licensing>, including the
required end-user terms, attribution, and applicable codec licensing.

---

## Rust crates and npm packages

Beyond the bundled binaries above, the app links ~750 Rust crates and ships a
handful of npm runtime packages. They are **all permissive or weak copyleft** —
there is no GPL or AGPL anywhere in either graph, which is what keeps Sauce
Bunny's own source MIT.

`npm run check:licenses` re-verifies that in a few seconds and fails on a
strong-copyleft arrival, so the claim stays true rather than being a snapshot
of the day it was written. CI runs it on every push.

| graph | count | licences seen |
|---|---|---|
| Rust (`cargo metadata`) | ~750 crates | MIT, Apache-2.0, MIT/Apache dual, BSD-2/3, Zlib, Unicode-3.0, ISC, MPL-2.0, Unlicense |
| npm (`node_modules`) | ~250 packages | MIT, ISC, Apache-2.0, BSD-2/3, MPL-2.0, BlueOak-1.0.0, CC0-1.0 |

The MPL-2.0 entries are mediabunny and its extensions (already detailed above);
MPL is file-level copyleft and does not reach the app around it.

Shipped npm runtime dependencies, individually:

| package | licence |
|---|---|
| `react`, `react-dom` | MIT |
| `mediabunny`, `@mediabunny/mp3-encoder`, `@mediabunny/prores` | MPL-2.0 |
| `@tauri-apps/api` and the dialog / notification plugins | MIT OR Apache-2.0 |
| `@fontsource/nunito-sans` | OFL-1.1 |
| `opus-decoder` | MIT |
| `perfect-freehand` | MIT |

The bundled **ffmpeg / ffprobe are the exception** and are GPL — they run as
separate subprocesses, are never linked, and the written offer below covers
redistributing them.

---

## ⚠️ Bundled ffmpeg / ffprobe are GPL — compliance terms

The ffmpeg and ffprobe binaries are static builds from
[osxexperts.net](https://www.osxexperts.net/) and
[ffmpeg.martin-riedl.de](https://ffmpeg.martin-riedl.de/) (see
`scripts/fetch-ffmpeg.sh` / `scripts/fetch-ffprobe.sh`).

**The two binaries differ, and the difference is checkable rather than
remembered.** `ffmpeg -version` reports `--enable-gpl` and does NOT report
`--enable-version3`, which puts that build at **GPLv2 or later**. `ffprobe
-version` reports `--enable-gpl` AND `--enable-version3`, which puts it at
**GPLv3 or later**. Neither reports `--enable-nonfree`. Do not "correct" the
table below to a single row: it would relabel a genuinely GPLv3 binary as v2.
This file
previously called them "the GPLv3 static builds", which overstated the
upstream terms. Nothing about the compliance below changes: "or later" lets a
redistributor pass the work on under v3, which is what Sauce Bunny does and
why the v3 text is what ships.

They run as isolated subprocesses over argv and are never linked, so they do
**not** relicense Sauce Bunny's own MIT source. Because the GPL binaries are
redistributed inside the released `.dmg`, that distribution complies as
follows:

- **License text** — the full GNU GPL v3 ships with the app at
  `Sauce Bunny.app/Contents/Resources/licenses/GPLv3.txt` (source:
  [`licenses/GPLv3.txt`](licenses/GPLv3.txt)) and a copy of this notice ships
  alongside it.
- **Written offer for corresponding source (GPLv3 §6)** — the complete
  corresponding source for the bundled ffmpeg/ffprobe and their GPL-licensed
  dependencies is published by the FFmpeg project at
  [ffmpeg.org/download.html](https://ffmpeg.org/download.html) (and the
  respective upstreams). For the exact version bundled in a given release (the
  build version is recorded by `scripts/fetch-ffmpeg.sh` at fetch time), a copy
  of that corresponding source is available for at least three years on request
  by opening an issue at
  [github.com/gchiaramonte3/SauceBunny/issues](https://github.com/gchiaramonte3/SauceBunny/issues).

To avoid the GPL obligation entirely, switch `scripts/fetch-ffmpeg.sh` to an
explicitly **LGPL** ffmpeg build (no `--enable-gpl` / `--enable-nonfree`); see
[ffmpeg.org/legal.html](https://ffmpeg.org/legal.html).

---

## Bundled / built sidecar binaries (shipped in the `.dmg`)

| Binary | Upstream | License |
|---|---|---|
| `yt-dlp` | https://github.com/yt-dlp/yt-dlp | The Unlicense (public domain) |
| `deno` 2.8.0 | https://github.com/denoland/deno/tree/v2.8.0 | MIT; runtime license in `licenses/DENO-LICENSE.md` |
| `ffmpeg` | https://ffmpeg.org ([osxexperts.net](https://www.osxexperts.net/) build) | **GPLv2 or later** — `--enable-gpl`, no `--enable-version3`; see note above |
| `ffprobe` | https://ffmpeg.org ([ffmpeg.martin-riedl.de](https://ffmpeg.martin-riedl.de/) build) | **GPLv3 or later** — `--enable-gpl --enable-version3`; see note above |
| `whisper-cli` (whisper.cpp) | https://github.com/ggerganov/whisper.cpp | MIT |
| `llama-server` (llama.cpp) | https://github.com/ggml-org/llama.cpp | MIT |
| `saucebunny-diarize` | this repo (`swift-sidecar/`) | MIT — links SpeakerKit ([argmax-oss-swift](https://github.com/argmaxinc/argmax-oss-swift), MIT, with Apache-2.0 swift-transformers portions) and [FluidAudio](https://github.com/FluidInference/FluidAudio) (Apache-2.0) |

## Frontend libraries (npm)

| Package | License |
|---|---|
| react, react-dom | MIT |
| perfect-freehand | MIT |
| opus-decoder | MIT |
| @tauri-apps/* (api + plugins + cli) | MIT or Apache-2.0 |
| vite, vitest, typescript, @vitejs/plugin-react, @types/* | MIT / Apache-2.0 |
| mediabunny, @mediabunny/mp3-encoder, @mediabunny/prores | MPL-2.0 (the mp3 encoder embeds LAME, LGPL; @mediabunny/prores wraps the turbores WASM ProRes decoder) — unmodified upstream; source at https://github.com/Vanilagy/mediabunny |
| turbores (WASM Apple ProRes decoder, pulled in by @mediabunny/prores) | MPL-2.0 — unmodified upstream; source at https://github.com/Vanilagy/turbores |
| @fontsource/nunito-sans (packaging) | MIT |

## Font

**Nunito Sans** is licensed under the **SIL Open Font License 1.1**
(© the Nunito Sans Project Authors). See https://fonts.google.com/specimen/Nunito+Sans.

## Rust / Tauri

Tauri and the Rust crate dependencies (see `src-tauri/Cargo.toml` and
`Cargo.lock`) are permissively licensed (MIT / Apache-2.0 / BSD class). Tauri
itself is dual MIT / Apache-2.0.

## Machine-learning models (downloaded at runtime by the user)

Sauce Bunny does **not** redistribute model weights. The app downloads them on
demand from the user's chosen source; each model carries its **own** upstream
license, which the user accepts by downloading it:

- **Whisper** speech models & **Silero VAD** — from
  [huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp)
  and [ggml-org/whisper-vad](https://huggingface.co/ggml-org/whisper-vad) (MIT).
- **Speaker-diarization models** (SpeakerKit / FluidAudio, pyannote-derived) —
  fetched by the diarizer on first run; see their upstream repos for terms.
- **LLM GGUF models** for the AI Summary tab (e.g. Qwen, Llama 3.2, Gemma) —
  each governed by its own model license (Apache-2.0, the Llama Community
  License, the Gemma Terms of Use, etc.). Review the model card before use.

---

*If you redistribute Sauce Bunny or a build of it, verify this list against your
actual bundle — licenses and bundled versions can change.*
