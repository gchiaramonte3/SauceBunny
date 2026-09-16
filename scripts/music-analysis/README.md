# Offline music-analysis feasibility checks

Developer diagnostics, **not an installed feature or production runtime recipe**.
These scripts do not start playback, capture a device, change preferences, or
upload media. They take explicitly supplied local fixtures. Inference is offline;
model downloads are a separate, explicit preparation step.

## Findings (September 16, 2026)

Do not ship `laion/larger_clap_music` at revision
`a0b4534a14f58e20944452dff00a22a06ce629d1`. Its checksum-valid weights loaded
without missing or mismatched tensors, but six different content descriptions
had pairwise text cosines above 0.9994. Music, speech, noise, and silence received
nearly indistinguishable rankings. Direct forward and feature APIs agreed;
Transformers 4.57.6 and 5.17.0 reproduced the same numbers. This is not evidence
that changing the runtime fixes it. The upstream model has an
[unresolved report of the same symptom](https://huggingface.co/laion/larger_clap_music/discussions/2).

The original checkpoint recommended by
[LAION for music](https://github.com/LAION-AI/CLAP#pretrained-models),
`music_audioset_epoch_15_esc_90.14.pt`, produced distinct features after strict
conversion. Both runtime versions agreed on the tested controls. Piano ranked
first among instruments for the synthetic arpeggio and its speech mixture.
However, CLAP's content prompts still ranked speech above music for that known
musical control. **It is not a validated music-presence detector.** It also ranks
genres and instruments for silence when forced to choose. Never turn its top
label or a softmax into a claim of certainty.

[Apple SoundAnalysis](https://developer.apple.com/documentation/soundanalysis)
version1 is available locally without a separate model download. On this Mac it
exposed 303 labels, including music, speech, singing and instrument families,
but no genre taxonomy. Measured music scores (not calibrated percentages):

| Generated control | Music score range |
| --- | --- |
| Damped harmonic arpeggio | 0.898–0.919 |
| Speech mixed with arpeggio | 0.729–0.836 |
| Speech only | 0.040–0.117 |
| Gaussian noise | 0.089–0.142 |
| Digital silence | 0.248 |

These are smoke controls, not held-out accuracy or a selected production
threshold. Silence even ranked music first, so taking the top label is wrong.
Check signal energy separately; retain uncertainty for low-evidence audio.
Apple's labels and behavior must also be tested on the minimum supported OS.

The reviewed scene fixture yielded 14 overlapping three-second Apple windows,
not sample-accurate music boundaries. The default hop is 1.5 seconds, and the
last partial window is not covered. Do not label that tail as analyzed.
The CLAP probe covers three sequential ten-second windows (the final one is
short and uses the model's repeat padding). Neither a window edge nor a change
in its score is an editorial cut.

Single observations on this development Mac: original CLAP inference took
roughly 45–65 ms per ten-second window on four CPU threads, excluding loading
and extraction, with process peak RSS about 1.1 GB. Apple's analysis calls took
roughly 33–63 ms for these 10–24-second files, excluding classifier construction
and PCM extraction. A repeat while the full automated suite was running took
roughly 0.3–1.04 seconds per CLAP window, with 1.32 seconds for model loading;
Apple's fixture analysis took 224 ms. These observations demonstrate sensitivity
to concurrent workload, not cold-start, p95 or minimum-laptop guarantees.

## Reproduce in an isolated environment

Use Python 3.12 and a scratch virtual environment, not the application's frozen
runtime. The measured primary stack was torch 2.14.0, transformers 5.17.0,
numpy 2.5.3, scipy 1.18.1 and safetensors 0.8.0. The comparison used transformers
4.57.6, tokenizers 0.22.2 and huggingface-hub 0.36.2 in a separate environment.
These diagnostics do not add PyTorch to the app; `build-video.sh` still excludes it.

Create a fresh work directory and explicitly download only these public files
with `huggingface_hub`, `token=False`, telemetry and implicit tokens disabled:

| Directory | Repository / revision | Files |
| --- | --- | --- |
| `model/` | `laion/larger_clap_music` / `a0b4534a14f58e20944452dff00a22a06ce629d1` | JSON metadata, tokenizer vocabulary/merges, README, `pytorch_model.bin` |
| `original/` | `lukewys/laion_clap` / `b3708341862f581175dba5c356a4ebf74a9b6651` | `music_audioset_epoch_15_esc_90.14.pt` |

The Hub file is 776,444,665 bytes, SHA-256
`5c289311f4a030d768af7ffbfdecd01b008aa64824211899a4e59f4f9d154fd1`.
The original is 2,352,471,003 bytes including unused training state, SHA-256
`fae3e9c087f2909c28a09dc31c8dfcdacbc42ba44c70e972b58c1bd1caf6dedd`.
Do not load a different file or fall back to unrestricted pickle deserialization.

`convert.py` verifies the original checksum, uses `weights_only=True` with only
the required NumPy scalar/dtype constructors allowed, and requires every learned
inference tensor. Known training heads and separately implemented spectrogram
buffers are listed in its conversion receipt. It writes safetensors plus a hash
receipt and refuses to overwrite an existing `converted/` directory. It is based
on the Apache-2.0
[Hugging Face conversion mapping](https://github.com/huggingface/transformers/blob/v4.35.0/src/transformers/models/clap/convert_clap_original_pytorch_to_hf.py),
with strict missing/extra-key checks. `compare_original.py` now separately checks
numerical equivalence against pinned LAION inference components; shape-complete
weight conversion alone is not that proof. See the follow-up below.

From the repository root, replace the example paths with the scratch environment
and the explicitly approved fixture. No automatic media discovery occurs:

```sh
python scripts/music-analysis/convert.py --work-dir /absolute/scratch/music
python scripts/music-analysis/probe.py /absolute/approved-fixture.mp4 \
  --work-dir /absolute/scratch/music --converted \
  --ffmpeg /absolute/bundled-ffmpeg --speech /absolute/generated-speech.aiff \
  --write-controls --output /absolute/scratch/music/original-results.json
```

Omit `--converted` and choose a different output filename to reproduce the bad
Hub checkpoint. Generate speech with macOS `say -o` (file output, no microphone
or playback). The probe writes generated musical notes, speech, their mixture,
noise and silence to PCM WAV only when `--write-controls` is supplied. It records
all similarity rankings and between-text cosine ranges instead of cherry-picking
only successful labels. The vocabulary intentionally remains the same in both
checkpoint tests, including the content prompts that performed poorly.

```sh
xcrun swiftc scripts/music-analysis/sound-analysis.swift -o /absolute/scratch/sound-analysis
/absolute/scratch/sound-analysis /absolute/generated_musical_arpeggio.wav > /absolute/scratch/apple.json
```

The Swift prototype accepts only the generated or decoded WAV/AIFF fixtures.
It reports all labels, raw scores, actual analysis windows, OS version and default
window policy. No score threshold or genre inference is applied.

Harness-only tests (NumPy required, no models, media, network or app state):

```sh
python -m unittest discover -s scripts/music-analysis -p 'test_*.py'
```

These cover reproducible controls, PCM chunk/tail fidelity, malformed samples,
extraction failure and child cleanup on an early-closed generator. They do not
measure classifier accuracy, native cancellation or production source timing.

## Reference parity and supervised candidate follow-up

`compare_original.py` checks the original HTSAT implementation at LAION CLAP
commit `1fd4c37df5ffbfcfbad5415c170bc66cf94c9994`, its exact preparation functions
and the original RoBERTa/projection weights. It deliberately bypasses the training
package's automatic downloads. It verifies source and converted hashes, rejects
modified upstream tracked sources, and feeds identical int16-quantized PCM to
both paths. The tested stack additionally used librosa 1.0.0, torchlibrosa 0.1.0,
soundfile 0.14.0, numba 0.67.0 and llvmlite 0.49.0 in an isolated environment.

Eight generated/scene windows and 16 public-audio windows passed the `1e-4`
normalized-embedding/cosine-score absolute tolerance. Maximum public-audio score
difference was `7.4834e-5`; text embeddings matched exactly. This verifies these
components, not the full upstream package, classification accuracy or readiness
for production. The same prompts often mislabeled jazz/trumpet as speech and
forced music styles onto speech and birdsong. Do not adopt this prompt policy.

```sh
python scripts/music-analysis/compare_original.py \
  --upstream /absolute/scratch/CLAP --work-dir /absolute/scratch/music \
  --ffmpeg /absolute/bundled-ffmpeg --audio /absolute/approved-fixture.wav \
  --output /absolute/scratch/clap-parity.json
```

The alternative supervised candidate is
[`MIT/ast-finetuned-audioset-10-10-0.4593`](https://huggingface.co/MIT/ast-finetuned-audioset-10-10-0.4593),
revision `f826b80d28226b62986cc218e5cec390b1096902`. Download only
`model.safetensors`, `config.json`, `preprocessor_config.json` and the model card
in a separate, explicit preparation step. The 346,404,948-byte weight file has
SHA-256 `ae0c1e2ad4e1381d851fa9bf298ba13ebc9c5a914cdee2dbe427a6583869924d`.
The MLX adapter verifies all three inference artifact hashes (including labels
and preprocessing). The model card identifies BSD-3-Clause for the checkpoint;
the adapted Transformers implementation retains Apache-2.0 attribution and license.
No weights or audio files are committed or automatically downloaded here.

`ast_probe.py` evaluates all 527 independent sigmoid scores on genuinely
resampled 16 kHz audio. `ast_mlx_compare.py` compares the candidate
`video-sidecar/audio_ast.py` against the pinned PyTorch reference offline.
The candidate uses NumPy/Kaldi preprocessing and MLX operations, not PyTorch.
It is deliberately **not** registered in the app model catalog or dispatcher.

```sh
python scripts/music-analysis/ast_probe.py --model-dir /absolute/scratch/ast \
  --ffmpeg /absolute/bundled-ffmpeg --audio /absolute/approved-fixture.wav \
  --output /absolute/scratch/ast-results.json
python scripts/music-analysis/ast_mlx_compare.py --model-dir /absolute/scratch/ast \
  --ffmpeg /absolute/bundled-ffmpeg --audio /absolute/approved-fixture.wav \
  --output /absolute/scratch/ast-parity.json
```

Repeat `--audio` to include multiple files. With MLX 0.32.2 and Transformers
5.17.0, all 24 tested windows had identical preprocessing and passed absolute
tolerances of `1e-3` for logits and `1e-4` for scores. Warm MLX inference was
roughly 40–45 ms per window in single observations, with about 1.25 GB peak Metal
allocation. Those are neither p95 nor minimum-laptop or packaged-app guarantees.
A separate fresh-process smoke produced 527 finite scores from generated silence
without importing PyTorch. Four lightweight adapter tests cover invalid PCM,
checkpoint rejection before GPU loading, feature shape and stable independent
sigmoid scores; they do not replace the real-weight parity check.

The small corpus used the five generated controls, the approved scene fixture
and these public librosa example assets (retrieved with its checksum registry):

| Example | Attribution | SHA-256 of HQ Ogg |
| --- | --- | --- |
| `vibeace` | Kevin MacLeod, Vibe Ace | `73d6443ef90a7c022f164e5aa90e56c2291585930b39b1656d0765abbc1f1779` |
| `brahms` | Brahms, Hungarian Dance No. 5; US Army Strings | `8e93ff0182a93168b15346c497b164cb49d2a97bf1e987a1149ea579e914532e` |
| `trumpet` | Mihai Sorohan, Solo Trumpet 06 | `beb954ae2c9c16919b5ca6973d6d5196cdcb196b46a3c2a201dd8861e7e324de` |
| `libri1` | The Ashiel Mystery, Garth Comira; LibriSpeech | `f09254a0daf4b14b292868d46dc2e3c8e158d19fafff739ad4c3931e2ce7b1b0` |
| `robin` | InspectorJ, Bird Whistling, Robin, Single, 13 | `a3b3ecf749befde43bdf35f839fdcb8d399a4deb5666de6f399c35ce12936baa` |

Retain each asset's attribution/terms from the
[librosa registry](https://github.com/librosa/librosa/tree/main/librosa/util/example_data)
and linked `librosa.org/data/audio/` metadata before reuse. Current TOML metadata
identifies CC-BY-4.0 for the four non-Brahms examples and public domain for Brahms;
some older text files say CC-BY-3.0. No audio is redistributed here. `fishin` was
excluded because its metadata disagreed and included noncommercial terms.

AST ranked speech for narration, birds for birdsong and trumpet/brass for the
trumpet example. Music scores were higher on the musical controls than speech
alone, but digital silence still scored Music at about `0.272`. Signal energy,
short-window uncertainty and representative held-out calibration remain necessary.
This smoke comparison establishes a candidate, not a production decision rule.

## Integration consequences and remaining gates

The later native evidence transport is documented in
[Video Intelligence](../../docs/VIDEO-INTELLIGENCE.md#native-audio-evidence-transport-internal-september-16).
It uses AVAssetReader plus bounded SNAudioStreamAnalyzer windows, not this
file-analyzer probe. It preserves edit-mapped output PTS and rejects the generated
AAC gap case when native decoding changes source timing. Raw evidence transport
is implemented and the feature-flagged AI Summary preview displays its raw,
unverified evidence. Music-presence policy and style inference remain unvalidated.

- The earlier minimal PyAV/FFmpeg build lacked the audio filters needed by
  `av.AudioResampler`. The decoder recipe now enables `aformat`, `aresample`,
  `abuffer` and `abuffersink`, keeping decoding in the owned Python process.
  `video-sidecar/audio_pcm.py` preserves decoded source anchors, quantized packet
  PTS, real gaps and unpadded tails in bounded ten-second, 16 kHz mono windows.
  `music_analysis.py` closes the decoder/model on failure or cancellation and
  requires a final matching source hash before completion. Focused tests cover
  these contracts, including generated real AAC with edit lists and a gap.
  Run them with `npm run test:video`; provide `AUDIO_TEST_FFMPEG` to enable the
  real AAC fixtures. A rebuilt scratch LGPL runtime analyzed the reviewed
  23.5-second scene fixture into windows [0, 10), [10, 20), [20, 23.5) seconds.
  The model catalog now offers an explicit download; the feature-flagged AI
  Summary controller selects this worker when the verified receipt is ready,
  otherwise retaining native audio evidence. It never downloads during analysis.
  The compact wire format retains all 527 float32 scores with one vocabulary,
  and the Rust collector rejects incomplete or mismatched evidence.
  Existing frozen runtimes must be rebuilt against the changed decoder recipe;
  scratch success is not packaged-app validation.
- `SNAudioFileAnalyzer` raised an uncaught Objective-C exception on the MP4
  fixture. PCM WAV succeeded. The prototype's extension guard is not an
  untrusted-file validator; production needs validated extraction and owned
  child-process isolation. No microphone permission is needed for local files.
- Retain the selected audio stream, nonzero origins, gaps, resampler delay and
  source microsecond intervals. This proof's FFmpeg extraction assumes contiguous
  zero-origin audio; it is not a production time-map adapter.
- Evaluate native evidence and the supervised AST candidate, **not** Qwen's
  image-only output or the current CLAP prompt policy. Verify on reviewed real music,
  mixed dialogue, effects, silence and short clips before choosing a policy.
  Model inference needs a production packaging, memory and licensing review; no weights or
  Python test dependencies are added to the app by this directory.
- A clean AI Summary should distinguish "Music detected, style unclear", a
  tentative style with supporting source ranges, "No audio track", "Not analyzed"
  and a technical failure. Scores are not user-facing confidence percentages.
  Keep visual/shot/transcript results usable if optional audio analysis fails.
- Persist model/classifier identity, OS where relevant, preprocessing/vocabulary
  version, actual coverage and source fingerprint with evidence. Stop/source
  changes must reject late audio results, and no partial coverage may be marked
  complete. Verify cancellation and packaged WKWebView behavior before rollout.

The music feature is **not integrated or release-ready**. These tests establish
a candidate path and reject a broken checkpoint; they do not finish the overall
scene-analysis / AI Summary goal.
