# Multitrack transcript accuracy, October 4: words, bleed, voiceprints, engines

**Goal (the owner, October 4):** more accurate transcripts from AAF Audio's
iso mics. Since every person has their own channel, tell each channel's
**owner** from the **bleed** of everyone else, using what each voice sounds
like if that helps, and find the local models the app is not yet using.

**Source:** a read of the current pipeline (file references below) and three
research passes on October 4: local speech-to-text models, voiceprint and
crosstalk methods, and diarizers. Published numbers are quoted with their
sources at the end. They are other people's benchmarks, some self-reported;
**phase 0 exists so that no default changes until it wins on the owner's own
footage.**

**Status (2026-10-04):** phases 1 to 4 are built and tested; phase 0's
scorer is built and waits for the owner's four scenes; phase 5's harness is
the scorer's `--hyp` input, and running the candidates waits on those scenes
and on decision 3. Each phase's Status line says what was built and what was
measured. Decision 1 is built as recommended (easy to change); decisions 2
and 3 are not built; decision 4 is built as recommended.

**Rules that hold in every phase:**
- **Local first.** Every model runs on the Mac. No new cloud call.
- **Label, never delete.** Bleed is marked and hidden by choice, never
  removed from the transcript. Every label can be overridden by hand and the
  override wins. This replaces the "no automatic cross-track deletion" stance
  in `docs/AAF-MULTITRACK.md` with "automatic labels, manual final say".
- **Voiceprints are biometric data.** They stay out of `~/Documents` (iCloud
  sync), live in `app_data_dir()`, are shown and deletable in Settings, and
  never reach an assistant, an export or a co-review peer.
- **Real footage and real transcripts are never committed.** The test set in
  phase 0 lives outside the repo; CI runs on synthetic fixtures.
- **The String Outs bar is locked.** Nothing here adds anything to the
  transport or timeline tool row.
- The CLAUDE.md contracts, `npm run verify`, and the build-ID bump whenever
  an invoke shape changes.

| Phase | Goal | Depends on |
|---|---|---|
| 0 | A hand-checked test set from the owner's footage and a scorer | owner: pick the scenes |
| 1 | Keep each word's real time instead of guessing it | — |
| 2 | Parakeet Ultra and cast names as vocabulary | 0 to prove it |
| 3 | The bleed resolver: owner, bleed or overtalk for every word | 1 |
| 4 | Voiceprints: learn each mic's owner, settle the hard cases | 3 |
| 5 | Engine and aligner bake-off: Qwen3-ASR, Granite, a forced aligner | 0, 1 |
| Later | Local LLM name correction; voting across engines | 5 |

**Decisions only the owner can make** (everything else runs as written):

1. **What bleed looks like by default (phase 3).** Recommended: hidden from
   All voices, search, Ask and the assistants; shown dimmed on the mic's own
   tab with "heard on Rosa's mic", with a View toggle to show it everywhere.
2. **Remembering voices across episodes (phase 4).** Off by default. On, a
   cast member's voiceprint is kept and used to label unlabelled mics in the
   next AAF. Biometric, so opt-in per cast and deletable.
3. **Download budget for a new engine (phase 5).** A new engine means a
   further model download measured in gigabytes. Ship it only if it wins
   phase 5, and as a choice beside Parakeet, not a replacement.
4. **Whisper in multitrack.** Recommended: keep it as the fallback it is
   today, add large-v3-turbo, and stop recommending medium.en.

---

## What is there today

Read from the code (paths relative to the repo):

- **Engines.** Parakeet TDT 0.6B v3 is the default, through FluidAudio 0.15.3
  on Core ML (`saucebunny-diarize --asr`,
  `swift-sidecar/Sources/saucebunny-diarize/main.swift:460-502`). Whisper is
  the fallback, with tiny.en to medium.en (default medium.en,
  `src/hooks/use-multitrack-transcription.ts:17-41`). Language is fixed to
  English.
- **Chunks.** 120 s owned windows with 1 s of context either side; all-zero
  windows skipped (`src-tauri/src/commands/aaf/transcribe.rs:38-51, 244-249`).
  Parakeet runs one process per window and reloads the model each time
  (`:186-191`). No gain, no denoise, no normalisation.
- **Word times are guessed.** Parakeet returns a time and a confidence for
  every token (`TokenTiming`, FluidAudio `AsrTypes.swift:142`); the sidecar
  folds them into caption cues of up to 84 characters (`main.swift:487`,
  `SrtCore.swift`) and only the cue's start and end survive. `cueSentenceMin`
  (break at a sentence end) is declared and never used. Word positions are
  then estimated from each word's length and snapped to the quietest 5 ms
  within 80 ms (`src-tauri/src/speech.rs:130-168`, `WORD_SNAP_SECONDS`).
  `AafCue` (`src-tauri/src/commands/aaf/model.rs:99`) has no words and no
  confidence.
- **No cast names reach the model.** No Whisper prompt, no Parakeet vocabulary.
  FluidAudio 0.15.3 already has a custom-vocabulary feature
  (`ASR/Parakeet/SlidingWindow/CustomVocabulary/`).
- **No owner versus bleed.** Stated in the code (`transcribe.rs:1`, warnings
  at `:274-278`). The per-mic analysis in `speech.rs` (floor at the 15th
  percentile per 60 s, activity at floor +12 dB, reactions at +18 dB) never
  looks at another track. String Outs lists overlapping words as `crosstalk`
  by time alone (`src/lib/edit-model.ts:190-211`).
- **No voiceprints.** SpeakerKit and FluidAudio diarize single-file
  transcripts only; their output is `{speaker, start, end}`. FluidAudio's
  `DiarizerManager.extractSpeakerEmbedding` (an L2-normalised 256-number
  WeSpeaker voiceprint) is in the build and never called. The cast roster
  holds names, colours and avatars, no voice data.
- **Known problems, from the repo's own notes:** Whisper invents recurring
  phrases on bleed-only mics; a line spoken by one person on another's lav
  "would count as" the wearer's (`docs/AAF-ASSEMBLY-RESEARCH.md:255-258`); VAD
  missed a quiet phrase (`docs/MULTITRACK-TRANSCRIPTION-PERFORMANCE.md`).

---

## Phase 0: a test set and a scorer

Nothing below changes a default without a number from here.

**Status: scorer built, scenes not yet chosen.** `sauce-bunny --eval [dir]`
(`src-tauri/src/eval.rs`, a mode of the app's own executable) scores every
scene in `~/Documents/Sauce Bunny Eval/` against the app's current
transcript and bleed labels: WER on owner words with S/D/I, cast names right
and false swaps, word-start error (mean, 90th percentile, share within one
frame), owner words wrongly hidden, bleed left showing, off-mic flagged.
`--eval-template <document> <from> <to> <out.csv> [tracks]` writes the
current transcript of those mics as the CSV to correct by hand, and a
scene's `"tracks"` limits scoring to the mics labelled (one minute of AFF
BANK 1 is 1,493 rows across 20 mics, 412 for two). A round trip on a real
minute scores itself perfectly. The CSV format is a word per row: track,
start, end (sequence seconds), text, who said it, owner/bleed/offmic. What
stands in for the synthetic CI scenes: the resolver, the orchestration and
the scorer are unit-tested on generated levels and words (`bleed.rs`,
`ownership.rs`, `eval.rs`); building scenes from public clips with added
reverb was not needed to test the logic and would add audio fixtures to the
repo.

1. **The owner picks four scenes**, each 3 to 5 minutes, from real shows: a
   dinner argument (overtalk), a car (close, noisy), outdoors (wind, distance),
   a confessional (one voice, clean). At least eight mics in two of them.
2. **Hand labels**, per word: the text, its start and end to the frame, who
   actually said it, and whether this channel is its owner, bleed, or
   off-mic (crew, someone unmiked). A small labelling view is not needed: a
   CSV per scene, filled from the existing transcript and corrected by hand,
   is enough.
3. **Storage:** `~/Documents/Sauce Bunny Eval/` (outside the repo, never
   committed), with the AAF path recorded but not copied.
4. **`scripts/eval-transcripts.mjs`** (dev only, not shipped) runs an engine
   over the scenes through the same commands the app uses and reports:
   - WER per scene and overall (owner words only), and **name accuracy** on
     cast names, with false swaps counted separately;
   - **word-time error**: mean and 90th percentile of |start error| in ms,
     and the share of words within one frame;
   - for phases 3 and 4: **owner words wrongly hidden** (the headline: a
     hidden real line is worse than a visible duplicate), leftover
     duplicates, overtalk kept correctly, and off-mic flagged.
5. **CI fixtures:** synthetic scenes built from public single-speaker clips,
   with bleed made by attenuating 10 to 25 dB, delaying 3 to 10 ms and adding
   room reverb, so the scorer and resolver are tested without real footage.

**Done when:** the scorer reproduces the current baseline (Parakeet v3,
estimated word times, no bleed labels) on all four scenes, and the synthetic
fixtures run in `npm run verify`.

---

## Phase 1: keep each word's real time

The cheapest accuracy win: Parakeet already measured these times.

**Status: built (7b90dbb).** As written, with two measured differences.
Parakeet's token END times overlap the next token by up to about 80 ms on
real speech ("We" 0.00-0.24 s, "drove" 0.16-0.48 s), so a word now ends where
the next begins. The batch is eight windows (sixteen minutes of audio) per
model load. Item 5's review mark is a dotted underline on the word in the
AAF Audio reader (`MultitrackCueText`), since a cue-level note would not say
which word.

1. **Words travel with cues.** `AafCue` gains an optional
   `words: Vec<AafWord>` with `{text, start_sample, end_sample, confidence}`
   (`#[serde(default)]`, ts-rs regenerated), so documents written before this
   load unchanged and the schema stays 2.
2. **The sidecar emits words.** `--asr` returns the token timings grouped
   into words (a word starts at a token beginning with the SentencePiece word
   marker), each with the mean token confidence, alongside the cues. Cues
   break at a sentence end once they reach `cueSentenceMin`, as the constant
   always said.
3. **`place_words` prefers stored words.** When a cue has words, use them,
   then snap each boundary to the quietest 5 ms within 40 ms (half the old
   reach, since the start point is now measured). Without words, the current
   estimate runs as before, so Whisper and old documents are unaffected.
4. **One Parakeet load per track,** not per window: the sidecar takes a list
   of window files and answers them in order. Speed only, but a real one on a
   20-mic, 3-hour AAF.
5. **Low confidence shows.** Words under a confidence threshold (start at
   0.5, set from phase 0) carry a `review` mark the reader already knows how
   to draw (the `boundary_review` treatment), not a new colour.

**Done when:** phase 0's word-time error for Parakeet improves on every
scene (expected: Parakeet's native times are about 80 ms mean error, against
a length-based guess); a Rust test proves an old document without words loads
and estimates as before; a Swift test proves words from token timings never
split inside a word and keep a word's confidence; break-test by dropping the
stored words.

---

## Phase 2: Parakeet Ultra and cast names

**Status: built (7b90dbb, f7d07ba).** FluidAudio 0.15.3 -> 0.17.5 (Ultra is
`AsrModelVersion.ultra` from 0.17.3); the installed v3 model already had
every file 0.17.5 expects. 0.17.5 also links text-processing-rs's
NemoTextProcessing (Apache-2.0, statically, opt-out only from a Swift 6.2
manifest), recorded in THIRD-PARTY-LICENSES. Ultra is offered first in AAF
Audio's picker with its own cancellable download, not in Settings, since
that is where it is used. Cast names are an opt-in "Spell cast names" (the
mic owners' names), **off by default**, because the first real run showed
why: on Parakeet v3 at the cautious similarity, FluidAudio's rescorer fixed
"Siomara" to "Xiomara" and also turned "it was funny" into "it Saoirse". A
replacement is now taken only when it is a respelling (at most two words,
60% of letters shared), applied to the measured words so their times
survive; the same clip then reads "Xiomara ... it was funny" ("Sersha" stays
as heard). Whisper large-v3-turbo (multilingual, 1.62 GB at the pinned
commit) is offered and AAF Audio picks the most accurate installed Whisper.
Whisper's stock inventions and loops are labelled on the cue (`suspect`),
never removed. The "on a mic with no activity under it" half is not built:
it needs the mic's level at the moment a cue is saved, which transcription
does not have, so the label is text-only for now.

1. **Upgrade FluidAudio** from 0.15.3 to the first release that carries
   Parakeet Ultra (0.17.3 per FluidAudio's model list; confirm on upgrade),
   re-running the diarizer and dictation tests, since both depend on it.
2. **Offer Parakeet Ultra** in the multitrack model picker as the
   recommended engine, keeping v3 installed and selectable. Same contract as
   v3, about 0.5 GB. Moondream reports 8.48% WER on AMI against v3's 9.52%;
   phase 0 decides whether it becomes the default.
3. **Cast names as vocabulary.** The names come from the mic labels and the
   cast roster for the AAF. Parakeet gets them through FluidAudio's custom
   vocabulary on its **cautious settings** (published measurements: the
   default settings caught 87% of target words but swapped 21% of look-alike
   words; cautious caught 41% with 9.3% swaps), tuned on phase 0's name
   accuracy versus false swaps. Whisper gets them as `--prompt`.
4. **Whisper large-v3-turbo** joins the Whisper choices (decision 4), and the
   picker stops recommending medium.en.
5. **A hallucination filter for Whisper:** drop a cue that is a known
   recurring phrase on a mic with no activity under it, and collapse n-gram
   repeats. Labelled, never deleted (the rule above).

**Done when:** phase 0 shows Ultra at least as good as v3 on WER and word
time on all four scenes before it becomes the default; name accuracy rises
with false swaps under a set ceiling (start at 5% of name occurrences); the
picker lists Ultra first and still runs v3.

---

## Phase 3: the bleed resolver

**Status: built (6ca5e2f).** 3a and 3c as written; 3b runs inside Check
voices (phase 4), because both need short clips of real audio and the
overviews 3a reads are levels only. Levels are compared against each mic's
own floor (Boakye's normalisation), which equalises gain without the
separate calibration step 1 describes. Two rules were tightened by tests:
bleed needs the same words on the louder mic (a quiet copy with different
words stays visible as unsure), and overtalk needs this mic within 10 dB of
the loudest (a misheard copy 20 dB down is not someone talking over). The
editor's call is per cue rather than per word, from the right-click menu
("Rosa, on their own mic" / "Bleed from Dev's mic" / "Use the automatic
call"). The ablation and the 1% ceiling wait on phase 0's scenes.

Every person is heard loudest and first on their own lav. A neighbour's lav
a metre or two away hears them about 15 to 20 dB quieter and a few
milliseconds later, and the same words appear on both channels. Meeting
transcription has used exactly these cues since the 2000s (sources below);
nobody has published it for reality-TV iso mics, so the thresholds are
starting points for phase 0 to set.

**Where it runs:** Rust, a new `src-tauri/src/bleed.rs` (business logic) and
one command, `aaf_ownership(document_id)`, returning a label per word for
every track, cached by the document's modification time. It reads the
waveform pyramids `speech.rs` already builds (about 5 ms a reading) and, for
3b only, short PCM windows from the existing audio index.

### 3a. Level and duplicate text

1. **Calibrate each mic.** Per channel, the speech level of its own clearly
   dominant stretches (its median), so a hot lav and a quiet one compare
   fairly. Levels are taken in 150 Hz to 4 kHz, where voices live and wind
   and rumble do not.
2. **Per word, Δ** = this channel's calibrated level over the word (±100 ms)
   minus the loudest other channel's.
3. **Duplicate text:** the same word (normalised, fuzzy-matched so "gonna"
   meets "going to") within ±150 ms on another channel.
4. **Labels:**
   - **owner** if Δ ≥ +10 dB;
   - **bleed** if another channel is at least 6 dB louder over the word and
     carries the same words (`heard_on` = that channel);
   - **overtalk** if two channels are each dominant over their own words and
     the texts differ: both are kept, both are owners;
   - **unsure** otherwise. Unsure words stay visible (the headline metric
     punishes hiding a real line) until phase 4 settles them.
5. **Off-mic:** speech on no lav strongly (every channel weak, the same text
   on several) is labelled off-mic, never given to a mic's owner.

### 3b. Who arrived first

For words still unsure after 3a, the time lag between the two strongest
channels (GCC-PHAT over the word): the owner's channel leads by about 3 to
9 ms at speaking distances. Each channel's fixed latency (wireless systems
differ by a few ms) is measured once per AAF from its dominant stretches and
subtracted first.

### 3c. Where the labels show

- **AAF Audio:** bleed is dimmed on the mic's own tab with "heard on Rosa's
  mic"; All voices and search skip it (decision 1). A word's label can be
  changed from its context menu, and the change is stored and wins.
- **String Outs:** the source pane's All voices skips bleed; `deleteWords`'s
  `crosstalk` list uses the labels instead of time overlap alone.
- **Assistants:** the context layer's lines carry `heard_on`, and search
  skips bleed unless asked, so Ask and `sauce-bunny --mcp` stop citing the
  same line twice.

**Done when:** on phase 0's scenes, owner words wrongly hidden stay under a
set ceiling (start at 1%) while most duplicates are labelled; the synthetic
fixtures cover each label, including true overtalk; a unit test per rule and
a break-test that removes the duplicate-text check; the ablation (level, then
+text, then +lag) is recorded in this spec.

---

## Phase 4: voiceprints

**Status: built (6ca5e2f).** `saucebunny-diarize --embed` returns one
voiceprint per span from FluidAudio's WeSpeaker model; its embeddings were
measured NOT to be unit length despite the doc comment (a voice against
itself dotted to about 13), so the sidecar normalises them. On clean
synthetic speech the same voice scores about 0.75 and different voices about
0.0, so 0.5 with a 0.1 margin has room; bleed will narrow it. Check voices
learns each owner from the best ten-minute window of dominant stretches
(and, on sequences over half an hour, a second window from the other half
of the day, which is how a mic swap shows), then listens to up to 600 unsure
words in clips of at most a minute, and when the voice cannot decide, asks
which mic heard the word first (cross-correlation within 20 ms; the owner
leads by 2 ms or more). A word in another cast member's voice is labelled
`other` ("Sounds like Ellie") and stays visible. Mic swaps are warned about
rather than split into periods, and that mic decides nothing by voice;
splitting the day is the next step if the warnings prove common.
`voiceprint-contract` pins where voiceprints may go.

A speaker-embedding model turns 2 to 3 seconds of speech into 256 numbers
that capture what a voice sounds like (the shape of the vocal tract, the pitch
range): the "frequency or sound each person has". The app already ships one
(FluidAudio's WeSpeaker model). It is the tie-breaker, not the main signal:
published results show voiceprints degrade on short clips, on distant,
reverberant audio (several times more errors far-field) and on overlapped
speech, which is where bleed lives.

1. **Auto-enrol.** For each channel, the stretches of at least 2 s where it is
   dominant by 15 dB or more and no other channel is active, about 60 s in
   all; average their voiceprints into the channel owner's, dropping
   outliers. No one records a sample.
2. **Settle unsure words.** Compare a 1.5 s window around the word with every
   enrolled owner. Owner if it matches this channel's owner best by a clear
   margin; attribute to the matching person if it matches someone else (the
   "talking into another person's mic" case); stay unsure otherwise.
   FluidAudio's own measurement on clean audio puts same-speaker similarity
   around 0.8 and different-speaker around 0.26; bleed narrows that, so the
   margins come from phase 0.
3. **Mic swaps.** When the voice dominating a channel stops matching its
   owner for more than a minute, start a new ownership period from there and
   say so in the warnings, rather than labelling a whole afternoon bleed.
4. **Twins and look-alikes.** Two owners whose voiceprints are too alike are
   flagged, and the resolver relies on level and lag alone for them.
5. **Runtime:** a new `--embed` mode in `saucebunny-diarize` takes a 16 kHz
   file and a list of spans, and returns one voiceprint per span. Rust calls
   it once per AAF. Voiceprints are stored at
   `app_data_dir()/voiceprints/<document-id>.json`, never in the document.
6. **Settings ▸ Transcription** shows how many voiceprints are kept and a
   button that deletes them all. Decision 2 (across episodes) adds a per-cast
   switch, off by default.

**Done when:** phase 0 shows unsure words falling and owner words wrongly
hidden not rising; a scripted mic swap in a synthetic fixture opens a new
period; a twin fixture (one voice on two channels) is flagged; a contract
pins that no voiceprint reaches `~/Documents`, the wire or the context
layer.

---

## Phase 5: engine and aligner bake-off

**Status: harness ready, not run.** Any engine's words can be scored with
`sauce-bunny --eval --hyp words.json`, a JSON list of
`{ "track", "start", "end", "text" }` in sequence seconds, so a candidate run
outside the app (mlx-qwen3-asr, transcribe.cpp for Granite) is compared on
the same scenes and metrics. Running them needs the scenes (phase 0) and
several gigabytes of models (decision 3), so nothing is installed or shipped.

Run through phase 0's scorer, against Parakeet Ultra with phase 1's times.

| Candidate | Why | Mac runtime | License |
|---|---|---|---|
| **Qwen3-ASR 1.7B** + **Qwen3-ForcedAligner** | Best average WER on the Open ASR Leaderboard; takes cast names as context; aligner about 32 to 48 ms word error | MLX (`mlx-qwen3-asr`), or `speech-swift` (Swift, MLX and Core ML) | Apache-2.0 |
| **IBM Granite Speech 4.1 2B** (and "plus") | Lowest AMI WER (about 7%); a keyword list measurably helps; "plus" gives about 40 ms word times but no punctuation and 3.5 min segments | community MLX builds, `transcribe.cpp` | Apache-2.0 |
| **A forced aligner on any engine's text** | Moves every engine onto measured word times (Whisper's run about 150 ms early, Parakeet's sit on an 80 ms grid) | Qwen3-ForcedAligner, as above | Apache-2.0 |

1. **Runtime choice comes first:** the app already ships an MLX runtime in
   the video sidecar; `speech-swift` would put it in `swift-sidecar` instead.
   Pick by size, start-up time and the `otool -L` self-containment rule.
2. **The bar to ship an engine:** better WER *and* word time than Parakeet
   Ultra on at least three of the four scenes, at a speed that keeps a 3-hour,
   20-mic AAF under a stated limit (set in phase 0 from today's run).
3. **Guards for decoder-style models** (Qwen3-ASR): fed only labelled speech
   from phase 3, in segments of 30 s or less, never raw silence, and passed
   through the phase 2 hallucination filter.
4. **Known limits to design around:** the aligner takes at most 300 s per
   call and returns a zero-length span for about 2.5% of words (fall back to
   the neighbouring estimate there).

**Done when:** the table above carries phase 0's numbers, and a winner is
either shipped behind decision 3 or recorded as not worth it.

**Considered and set aside:** Cohere Transcribe (accurate, but no word times
and it invents text on non-speech; a voter at most), Canary-Qwen, Voxtral,
Kyutai, Moonshine, VibeVoice, Gemma (weaker on conversational speech or no
word times), Apple's SpeechTranscriber (macOS 26 only; the app supports 14),
TheWhisper (its SDK checks a licence online). Licence traps: CrisperWhisper
and the MMS-300m aligner are CC-BY-NC, as are DiariZen's weights. No new
diarizer is needed for multitrack: the channels already say who is where.
Voice isolation before transcription is out: denoising made every recognizer
worse in all 40 configurations one 2025 study tried.

---

## Later

- **Local LLM name correction:** the local Qwen fixes names against the cast
  list, substitutions only, then the aligner re-times the words. Reported up
  to 30% relative reduction in name errors.
- **Voting across engines (ROVER):** reported to cut WER sharply against one
  engine alone, at two to three times the compute. Worth it only for a final
  pass on selected scenes.
- **NVIDIA's multitalker Parakeet** takes per-speaker activity and
  transcribes each speaker separately; phase 3's labels are exactly that
  input. NeMo-only today, so it waits for a Mac runtime.

---

## Sources

- Open ASR Leaderboard results, 2 October 2026:
  <https://huggingface.co/datasets/hf-audio/open-asr-leaderboard-results/blob/main/english_short_latest.csv>
- Parakeet Ultra: <https://huggingface.co/moondream/parakeet-ultra>; in FluidAudio:
  <https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Models.md>
- FluidAudio custom-vocabulary measurements:
  <https://github.com/FluidInference/FluidAudio/issues/967>
- Qwen3-ASR technical report: <https://arxiv.org/html/2601.21337v1>;
  aligner zero-length spans: <https://github.com/QwenLM/Qwen3-ASR/issues/197>;
  MLX port: <https://github.com/moona3k/mlx-qwen3-asr/>;
  speech-swift: <https://github.com/soniqo/speech-swift>
- Granite Speech 4.1 plus: <https://huggingface.co/ibm-granite/granite-speech-4.1-2b-plus>
- Word-timing benchmark (FA-BENCH): <https://arxiv.org/html/2609.32396>
- Cross-channel speech detection: Boakye & Stolcke 2006
  <https://www.isca-archive.org/interspeech_2006/boakye06_interspeech.html>;
  Wrigley et al. 2005 <https://staffwww.dcs.shef.ac.uk/people/S.Wrigley/pdf/tsap2005.pdf>;
  Pfau, Ellis & Stolcke 2001 <https://www.ee.columbia.edu/~dpwe/pubs/asru01-sad.pdf>
- Voiceprint degradation with distance and duration:
  <https://arxiv.org/abs/2002.06033>; close-talk enrolment, far-field test:
  <https://arxiv.org/abs/2005.08046>
- Self-enrolment from where a speaker dominates (SE-DiCoW):
  <https://arxiv.org/abs/2601.19194>; TS-VAD: <https://arxiv.org/abs/2005.07272>
- Denoising before ASR hurts: <https://arxiv.org/abs/2512.17562>
- WeSpeaker models and licence:
  <https://github.com/wenet-e2e/wespeaker/blob/master/docs/pretrained.md>
- Name correction with an LLM: <https://arxiv.org/abs/2506.10779>;
  ROVER across engines: <https://arxiv.org/pdf/2603.25750>
- Multitalker Parakeet: <https://huggingface.co/nvidia/multitalker-parakeet-streaming-0.6b-v1>
