# Local audio content: findings and presentation policy

Research and source review: September 21, 2026. Scope: editor-facing audio
labels and frame-based navigation. No new weights or runtime are installed.

## What the current model can do

Sauce Bunny runs the pinned MIT Audio Spectrogram Transformer (AST) locally
through its existing MLX implementation. It produces independent scores for
527 AudioSet classes, not a single mutually exclusive class. Speech and music
can both be present. The vocabulary also covers animals, vehicles, weather,
alarms, impacts, human non-speech sounds and musical instruments.

Sources: [MIT model card](https://huggingface.co/MIT/ast-finetuned-audioset-10-10-0.4593),
[Google AudioSet](https://research.google.com/audioset/),
[AudioSet ontology](https://research.google.com/audioset/ontology/index.html).

The reported UI was ranking three raw scores and emphasizing tentative genres.
That obscured ordinary mixed speech/music and displayed very weak incidental
classes. Changing the display is useful without claiming a more accurate model.

## Candidate upgrades, not installed or benchmarked here

| Candidate | Why evaluate it | Constraint |
| --- | --- | --- |
| EfficientAT DyMN | Compact local multi-label sound tagging. The authors report DyMN10 at 10.57M parameters and 47.7 AudioSet mAP; DyMN20 at 40.02M and 49.1. | CPU/Core ML or MLX deployment and licensing artifacts must be verified. Published aggregate scores do not prove better speech/music results on editorial mixes. |
| Qwen2-Audio-7B-Instruct through MLX-Audio | Rich descriptions of speech, environmental sound and music; upstream model is Apache 2.0, and MLX-Audio documents Apple Silicon support with a 4-bit artifact. | Larger and generative: benchmark latency, memory, hallucinations, cancellation and source grounding. Not a replacement for measured timing or Whisper transcription. |
| Audio Flamingo Next | Current audio-language model supporting speech, sounds, music and long-audio reasoning. | Its official card specifies the NVIDIA OneWay Noncommercial License. Not an automatic shipping choice for this product; also not validated in our Mac runtime. |

Primary sources: [EfficientAT authors](https://github.com/fschmid56/EfficientAT),
[Qwen2-Audio model card](https://huggingface.co/Qwen/Qwen2-Audio-7B-Instruct),
[MLX-Audio implementation](https://github.com/Blaizzy/mlx-audio),
[Audio Flamingo Next model card](https://huggingface.co/nvidia/audio-flamingo-next-hf).

Recommendation: first benchmark EfficientAT against the existing AST for coarse
labels on manually annotated editorial footage. Separately evaluate Qwen2-Audio
for optional sound descriptions. This is an engineering recommendation, not a
claim that either wins on the user's footage. Preserve bounded single-job
inference, explicit downloads and offline operation. Do not use a larger picture
model as an audio classifier or infer music from images/transcript words.

## Implemented UI policy: audio-content.v1

- Preserve immutable native evidence, source identity, PCM coverage and scores.
- Accept only the pinned AST/checkpoint/preprocessing combination, or the
  existing named Apple SoundAnalysis fallback with its own preprocessing.
- Independent Speech and Music scores at or above 0.5 produce their respective
  labels, or Speech + Music when both qualify. This threshold is an experimental
  display policy, not calibrated certainty. Do not sum correlated parent/child
  scores. No omitted badge asserts that a sound is absent.
- AST windows shorter than five seconds abstain, following the existing music
  summary policy. Apple windows require their full three-second context.
- A conservative explicit vocabulary maps strong common non-speech events to
  SFX with up to two labels. It does not treat every other class, instrument,
  mood or low-ranked sound as a sound effect. SFX means non-speech sound here,
  not proof of an added post-production effect.
- Unknown, weak or malformed evidence is Unclassified. Decode gaps are Not
  analyzed. Silence requires measured digital-zero energy, never missing labels.
- Both endpoints use the same Clip source-frame flooring convention and actual
  fractional rate. End is exclusive. Clicks seek the displayed frame, not the
  original fractional audio-sample position. This presentation grid does not
  claim frame-level sound-event detection from a ten-second classifier window.
- Omit sub-frame windows from the main list, retaining them in Info as less than
  one frame. Do not enlarge them, invent coverage, shift later windows or delete
  evidence. Raw data is retained for future model/segmentation improvements.
- Scores, limitations and tentative genres remain in Analysis info. Default
  results use grayscale icons/text. All-tab audio is collapsed; Audio tab shows
  the ranges directly.

## Validation boundary

Unit/browser tests must cover mixed labels, low scores, SFX, silence, gaps,
unknown classifiers, short windows, invalid scores, 23.976/24/25/29.97/59.94,
zero-length display fragments, source offsets, keyboard seeks, compact All-tab
presentation, Info disclosure and narrow/enlarged layouts. These are policy/UI
tests, not a new accuracy benchmark or a packaged real-model certification.

### Verification for this change

- Full `npm run verify` passed with serialized Rust tests and the existing video
  test runtime: 4,471 frontend unit tests, 771 Rust library tests and 470 browser
  tests passed. TypeScript, lint, Clippy, Swift and the remaining native gates
  passed. Existing fixture/environment-dependent skips remain (including 29
  Rust library tests and 12 browser tests).
- An additional WebKit check passed at 360, 440 and 680 pixels, including 125%
  typography, keyboard seeks, Info dismissal and fractional-rate endpoints.
  The inspected screenshot uses deterministic test evidence, not fresh model
  output. Browser checks use mocked IPC, not a packaged WKWebView.
- Updated the opt-in native-evidence browser assertions to match the new view;
  their real-model/fixture runs were not enabled for this presentation change.
- No model replacement, download, app installation or DMG rebuild was performed.
