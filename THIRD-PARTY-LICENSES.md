# Third-Party Licenses & Acknowledgements

Sauce Bunny itself is licensed under the [MIT License](LICENSE). It does not
contain or link any copyleft source code. However, the distributed app **bundles
several third-party binaries** (each invoked as a *separate subprocess*, not
linked into the app) and uses third-party libraries, a font, and — at the user's
option, downloaded at runtime — machine-learning models. Their licenses are
disclosed below.

The sidecar binaries are **not** checked into this repository; they are fetched
or built locally by `npm run setup` (see `scripts/`). This notice covers what
ships inside a released `.dmg`.

---

## ⚠️ Bundled ffmpeg / ffprobe are GPL — compliance terms

The ffmpeg and ffprobe binaries are the **GPLv3** static builds from
[osxexperts.net](https://www.osxexperts.net/) (see `scripts/fetch-ffmpeg.sh` /
`scripts/fetch-ffprobe.sh`). They run as isolated subprocesses, so they do
**not** relicense Sauce Bunny's own MIT source. Because the GPL binaries are
redistributed inside the released `.dmg`, that distribution complies with GPLv3
as follows:

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
| `ffmpeg`, `ffprobe` | https://ffmpeg.org (osxexperts.net build) | **GPLv3** — see note above |
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
