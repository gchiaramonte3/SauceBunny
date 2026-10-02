# Multitrack transcription performance, September 22, 2026

## Change

Whisper reuses one model initialization for up to four independent two-minute
windows. Accurate remains the default, with one recognizer and bounded audio
preparation. Parakeet is unchanged. Inputs are never concatenated; each output
keeps its original source offset and boundary context.

Multitrack's model controls and Generate/Regenerate dialog share a compact
Options disclosure. Fast decoding and Skip non-speech are opt-in and remembered.
An active selected-track run snapshots both settings. Skip non-speech only uses
the cached Silero detector; when absent, full audio is used without a download.
Quiet or overlapping dialogue can be missed when the filter is enabled.

Pipeline records selected options, batch size, source-frame range and sanitized
Whisper load/encode/decode timings. It does not log recognized dialogue. Saved
track warnings record the options and any missing-detector fallback. Stop and
atomic per-track commits retain their existing contract.

## Local measurement

Apple M4 Max, bundled whisper-cli, Medium English, 10 threads. One comparison
pass, four 120-second synthetic windows. Generated speech occurs at 5, 45 and
95 seconds, with the last phrase attenuated to 0.03 amplitude. These are local
recognition measurements, not a NEXIS, real-dialogue accuracy or end-to-end AAF
throughput benchmark.

| Mode | Wall time | Compared with separate launches |
| --- | ---: | ---: |
| Four separate Accurate launches | 12.872 s | baseline |
| Four inputs, one Accurate launch | 9.636 s | 25% less time |
| Four inputs, one Fast launch | 6.116 s | 52% less time |
| Four inputs, Accurate plus speech filter | 4.098 s | 68% less time |

The filtered run missed the deliberately quiet last phrase. It is therefore
disabled by default; this result is not an accuracy endorsement. Unfiltered
runs retained the quiet phrase but also hallucinated some repeated text in
silent sections. Neither setting makes recognition authoritative.

## Reproducible regression

The ignored Rust test `real_batch_retains_independent_srt_origins_and_one_model_load`
runs the production argument builder against the bundled binary and real model.
Provide `SB_AAF_ASR_TEST_WAV` (a two-minute speech fixture with a phrase after
40 seconds) and `SB_AAF_ASR_TEST_MODEL`; optional `SB_AAF_ASR_TEST_VAD` checks
the filtered path. It checks one model initialization, individual output paths,
fractional-rate source offsets and valid bounded cues. Invalid model timestamps
remain review items, never invented timecodes.

Automated controls cover defaults, saved preferences, an immutable multi-track
run snapshot, Parakeet independence, disabled controls, Stop-after-commit,
navigation/reconciliation and narrow layouts at 100% and 125% text size.

Verification completed: 4,578 frontend unit tests, 810 Rust unit tests, 476 browser
tests and all other `npm run verify` gates passed (the suite retains its explicit
skips). The real-model regression also passed with the speech filter both off
and on. An additional filtered generated-media run alternated different speech
and silent inputs: both silent SRT files stayed empty, different speech stayed isolated,
and a single model load served all four inputs. Killing that recognizer after
processing began took 16 ms. This last measurement tests the bundled subprocess,
not a full packaged-app Stop interaction. The existing Stop/commit tests cover
the frontend/native persistence contract separately.

## Limits

The user confirmed successful reference-AAF/NEXIS access on their other Mac.
This development Mac has no live NEXIS connection, so the networked speedup must
be measured there. No original media or committed production transcripts were
changed for these tests. No macOS 14 device was available for runtime testing.
