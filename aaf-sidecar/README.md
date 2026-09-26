# Local AAF reader

`saucebunny-aaf` is a read-only, bounded subprocess. It does not open media
locators, start an editor, download packages, or contact a service at runtime.
It imports a single top-level audio composition from embedded mono PCM WAVE
or PCMDescriptor essence. The application's multitrack page owns playback,
transcription jobs and caching; this subprocess only reads AAF and audio.

## JSON and commands

- `inspect --input PATH`: schema version 1, sequence name/ID, rational
  `edit_rate {numerator,denominator}`, absolute record `start_frame`, relative
  `duration_frames`, `timecode_fps`, `drop_frame`, `source_fingerprint`, tracks,
  and warnings. Track IDs are AAF slot IDs, not array indices. Person labels
  come from `TRK1` metadata when consistent; they identify a microphone, not
  a verified speaker for every word.
- `extract --input PATH --track ID --start-frame N --duration-frames N
  --output WAV [--peaks-output JSON]`: at most 600 seconds of lossless mono
  source PCM with handles removed and timeline gaps filled with silence.
  Start and duration are relative **sequence** edit units. The WAV begins at
  the requested range, not at the source file's beginning.
- `peaks --input PATH --track ID --output JSON`: scans one complete track in
  192 KiB blocks, producing at most 2048 normalized `[minimum,maximum]` pairs.
  It never writes a full-length audio copy. The JSON includes `sample_rate`,
  `sample_count`, `samples_per_peak` and the relative start/duration.

All commands accept `--expected-fingerprint` and reject stale input. Identity
uses SHA-256 of size, nanosecond mtime and the first/last 64 KiB: this is a
bounded cache identity, **not** a cryptographic full-file integrity claim.
The selected input is opened read-only. New output files are published with
exclusive atomic links; existing outputs and symlinks are never overwritten.
Exit 2 carries a versioned JSON error on stderr; cancellation exits 130.

## Limits and fidelity

There is no source-file-size cap. Fingerprints read only 64 KiB at each end,
using 64-bit offsets for AAF and linked MXF sources. The reader caps duration at
24 hours, sequence audio tracks at 64 (256 expanded microphone lanes),
graph expansions at 10,000 and traversal depth at 16. Source/track edit rates
stay rational. A single nearest-sample (ties upward) rule is used at boundaries;
48 kHz at 24000/1001 maps exactly to 2002 samples per frame. Never concatenate
whole embedded files: the files can contain Avid handles and different recorder
roll boundaries. PCM decoding and waveform accumulation are bounded in memory.

Non-zero slot origins, transitions, non-PCM media, multichannel essence,
non-frame-aligned nested edits, mixed PCM formats within one track and unhandled
effects are rejected with actionable messages. Static Audio Gain is explicitly
ignored with a raw-microphone warning; automated gain is rejected. Avid mixer
solo/mute does not suppress imported tracks. None of these choices claims to
recreate an Avid master mix or guarantee speech-recognition accuracy.

## Build and cancellation

`AAF_PYTHON=/path/to/python3.12 bash scripts/build-aaf.sh` uses CPython 3.12.14
and SHA-256-pinned wheels. The resulting Apple Silicon one-file sidecar embeds
the interpreter, pyaaf2 and its required standard-library modules. Neither
Homebrew, system Python nor the build environment is needed on a user's Mac.
The build first audits a one-folder package's complete native dependency graph,
then builds the one-file artifact with the same modules. Set
`APPLE_SIGNING_IDENTITY` to sign the internal runtime and bootloader together.
The outer app's distribution signing/notarization remains a release gate.
Developers must supply that interpreter explicitly if `python3.12` is not on
PATH. CI can provision it with `actions/setup-python` and version `3.12.14`;
other developer machines can use a supported CPython build. Do not copy the
system Python or a developer's environment into application resources manually.

The app must register the subprocess before awaiting output, kill it on Stop,
and put its `TMPDIR` in the owned job directory. A frozen worker checks ownership
before reading the AAF and checks every 50 ms for ownership loss if its
one-file bootloader parent is killed. Forced termination can leave temporary
files; the job owner cleans only its job directory after all processes stop.

`bash scripts/test-aaf.sh` runs synthetic fixture tests. If the selected
`AAF_PYTHON` lacks pyaaf2 1.7.1, the test script creates an isolated environment
under `node_modules/.cache/aaf-tests` and installs only its hash-pinned wheel.
Subsequent runs reuse that environment. No system/site packages are changed,
and application runtime never invokes this setup. Tests need no private media.

Primary implementation references:

- [pyaaf2 API](https://pyaaf.readthedocs.io/en/latest/api/aaf2.html)
- [PyInstaller packaging and one-file lifecycle](https://pyinstaller.org/en/v6.22.3/operating-mode.html)
- [CPython 3.12 audioop](https://docs.python.org/3.12/library/audioop.html)
