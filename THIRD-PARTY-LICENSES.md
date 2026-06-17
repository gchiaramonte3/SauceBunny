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

## ⚠️ Bundled ffmpeg / ffprobe are GPL

The ffmpeg and ffprobe binaries are the **GPL** static builds from
[osxexperts.net](https://www.osxexperts.net/) (see `scripts/fetch-ffmpeg.sh` /
`scripts/fetch-ffprobe.sh`). Because they are GPL-licensed and redistributed
inside the released `.dmg`, that distribution must satisfy GPLv3 for the ffmpeg
component: ship a copy of the GPLv3 text and provide the corresponding source
(or a written offer for it). ffmpeg runs as an isolated subprocess, so it does
**not** relicense Sauce Bunny's own MIT source — but anyone cutting a public
release should either (a) keep the GPL build and meet the above obligation, or
(b) switch `scripts/fetch-ffmpeg.sh` to an explicitly **LGPL** ffmpeg build
(no `--enable-gpl` / `--enable-nonfree`) to avoid it. See
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
| mediabunny, @mediabunny/mp3-encoder | MPL-2.0 (the mp3 encoder embeds LAME, LGPL) — unmodified upstream; source available at https://github.com/Vanilagy/mediabunny |
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
