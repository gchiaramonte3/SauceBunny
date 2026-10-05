//
//  saucebunny-diarize
//
//  Offline speaker diarization CLI for Sauce Bunny. Two backends:
//
//    speakerkit  — Argmax SpeakerKit (pyannote v4 on Core ML, MIT, 1.0)
//    fluidaudio  — FluidAudio (pyannote community-1 on Core ML, 0.x)
//    auto        — try speakerkit first, fall back to fluidaudio on init error
//
//  USAGE:
//      saucebunny-diarize --input <audio.wav> --output <turns.json>
//                         [--backend speakerkit|fluidaudio|auto]
//                         [--num-speakers N | --min-speakers N --max-speakers N]
//                         [--emit-progress]
//      saucebunny-diarize --prepare-models [--backend ...] [--emit-progress]
//      saucebunny-diarize --version
//      saucebunny-diarize --help
//
//  EXIT CODES:
//      0  success
//      1  bad arguments
//      2  model preparation failed
//      3  audio processing failed
//      4  JSON serialization or write failed
//      5  both backends unavailable (auto mode could not init either)
//
//  OUTPUT JSON (schema v1 — unchanged across backends so the Rust
//  caller and TS viewer are backend-agnostic):
//      {
//        "schema_version": 1,
//        "model": "speakerkit-pyannote4" | "fluidaudio-offline-diarizer",
//        "model_package_version": "1.0.0" | "0.14.x",
//        "audio_seconds": 4013.0,
//        "wall_clock_seconds": 32.7,
//        "turn_count": 184,
//        "turns": [
//          { "speaker": "SPEAKER_00", "start": 0.18, "end": 3.42 },
//          …
//        ]
//      }
//

import Foundation
import SrtCore
import AVFoundation
import SpeakerKit
import FluidAudio

// ── WAV loader ──────────────────────────────────────────────────────
//
// SpeakerKit expects a `[Float]` of mono samples at the model's native
// rate (16 kHz). We could pull this helper out of WhisperKit's
// `AudioProcessor`, but the Sauce Bunny audio prep pipeline already
// emits 16 kHz mono WAV (ffmpeg / mediabunny WAV encoder), so we can
// keep the dependency footprint smaller by reading the buffer with
// AVAudioFile directly.
//
// If the file isn't 16 kHz we resample with AVAudioConverter (AVAudioFile's
// read(into:) only converts encoding/interleaving — NEVER sample rate, so the
// old pass-through fed e.g. 48 kHz samples to a 16 kHz model and produced
// timestamps stretched ~3×, silently). The Sauce Bunny pipeline always emits
// 16 kHz mono WAV; this path is the safety net for users who invoke the
// binary against arbitrary audio from a terminal.

func loadWavAsFloatArray(path: String) throws -> [Float] {
  let url = URL(fileURLWithPath: path)
  let file = try AVAudioFile(forReading: url)
  guard let buf = AVAudioPCMBuffer(
    pcmFormat: file.processingFormat,
    frameCapacity: AVAudioFrameCount(file.length)
  ) else {
    throw NSError(domain: "saucebunny", code: 3,
                  userInfo: [NSLocalizedDescriptionKey: "AVAudioPCMBuffer alloc failed for \(path)"])
  }
  try file.read(into: buf)

  // Resample + downmix in one converter pass when the rate isn't the model's
  // 16 kHz. The already-16 kHz path below stays byte-identical.
  let srcRate = file.processingFormat.sampleRate
  if srcRate != 16_000 {
    guard let dstFormat = AVAudioFormat(
      commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false
    ), let converter = AVAudioConverter(from: file.processingFormat, to: dstFormat) else {
      throw NSError(domain: "saucebunny", code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "cannot build 16 kHz resampler for \(path)"])
    }
    let dstCapacity = AVAudioFrameCount((Double(file.length) * 16_000 / srcRate).rounded(.up)) + 1024
    guard let dst = AVAudioPCMBuffer(pcmFormat: dstFormat, frameCapacity: dstCapacity) else {
      throw NSError(domain: "saucebunny", code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "resample buffer alloc failed for \(path)"])
    }
    var fed = false
    var convErr: NSError?
    let status = converter.convert(to: dst, error: &convErr) { _, outStatus in
      if fed { outStatus.pointee = .endOfStream; return nil }
      fed = true
      outStatus.pointee = .haveData
      return buf
    }
    if status == .error {
      throw convErr ?? NSError(domain: "saucebunny", code: 3,
                               userInfo: [NSLocalizedDescriptionKey: "resample to 16 kHz failed for \(path)"])
    }
    guard let ch = dst.floatChannelData else {
      throw NSError(domain: "saucebunny", code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "resampled buffer has no float channel data"])
    }
    return Array(UnsafeBufferPointer(start: ch[0], count: Int(dst.frameLength)))
  }

  let frames = Int(buf.frameLength)
  let channels = Int(buf.format.channelCount)
  guard let chData = buf.floatChannelData else {
    throw NSError(domain: "saucebunny", code: 3,
                  userInfo: [NSLocalizedDescriptionKey: "audio buffer has no float channel data"])
  }
  if channels == 1 {
    return Array(UnsafeBufferPointer(start: chData[0], count: frames))
  }
  // Multi-channel — downmix to mono by averaging.
  var out = [Float](repeating: 0, count: frames)
  for ch in 0..<channels {
    let src = UnsafeBufferPointer(start: chData[ch], count: frames)
    for i in 0..<frames { out[i] += src[i] }
  }
  let invN = 1.0 / Float(channels)
  for i in 0..<frames { out[i] *= invN }
  return out
}

// ── Argument parsing ────────────────────────────────────────────────

enum Backend: String { case speakerkit, fluidaudio, auto }

struct Args {
  var input: String?
  var output: String?
  var emitProgress: Bool = false
  var showVersion: Bool = false
  var showHelp: Bool = false
  var prepareModelsOnly: Bool = false
  var backend: Backend = .auto
  var numSpeakers: Int?
  var minSpeakers: Int?
  var maxSpeakers: Int?
  // ── ASR (Parakeet) mode (r90) ──
  var asr: Bool = false              // transcribe --input WAV → --output SRT
  var prepareAsrModels: Bool = false // download/cache the Parakeet model + exit
  var modelsDir: String?             // where the Parakeet Core ML model lives
  var words: String?                 // also write the measured words as JSON here
  var batch: String?                 // JSON list of {input, output, words}: one model load for all
  var asrModel: ParakeetVersion = .v3
  // ── Voiceprints (accuracy spec, phase 4) ──
  var embed: Bool = false            // one voiceprint per span of --input
  var spans: String?                 // JSON list of [start, end] seconds
}

/// Which Parakeet the app asked for. Ultra (FluidAudio 0.17.3+) is a
/// post-trained v3 with the same tokenizer and API; v3 stays the default so an
/// older caller gets what it always got.
enum ParakeetVersion: String {
  case v3, ultra
  var fluid: AsrModelVersion { self == .ultra ? .ultra : .v3 }
  var label: String { self == .ultra ? "Parakeet Ultra" : "Parakeet" }
}

func parseArgs(_ argv: [String]) -> Args {
  var a = Args()
  var i = 1
  while i < argv.count {
    let arg = argv[i]
    switch arg {
    case "--input", "-i":
      i += 1; if i < argv.count { a.input = argv[i] }
    case "--output", "-o":
      i += 1; if i < argv.count { a.output = argv[i] }
    case "--emit-progress":
      a.emitProgress = true
    case "--prepare-models":
      a.prepareModelsOnly = true
    case "--asr":
      a.asr = true
    case "--prepare-asr-models":
      a.prepareAsrModels = true
    case "--models-dir":
      i += 1; if i < argv.count { a.modelsDir = argv[i] }
    case "--words":
      i += 1; if i < argv.count { a.words = argv[i] }
    case "--batch":
      i += 1; if i < argv.count { a.batch = argv[i] }
    case "--embed":
      a.embed = true
    case "--spans":
      i += 1; if i < argv.count { a.spans = argv[i] }
    case "--asr-model":
      i += 1
      if i < argv.count, let v = ParakeetVersion(rawValue: argv[i].lowercased()) { a.asrModel = v }
      else { FileHandle.standardError.write(Data("Unknown --asr-model; use v3 or ultra\n".utf8)) }
    case "--backend":
      i += 1
      if i < argv.count, let b = Backend(rawValue: argv[i].lowercased()) {
        a.backend = b
      }
    case "--num-speakers":
      i += 1; if i < argv.count { a.numSpeakers = Int(argv[i]) }
    case "--min-speakers":
      i += 1; if i < argv.count { a.minSpeakers = Int(argv[i]) }
    case "--max-speakers":
      i += 1; if i < argv.count { a.maxSpeakers = Int(argv[i]) }
    case "--version", "-v":
      a.showVersion = true
    case "--help", "-h":
      a.showHelp = true
    default:
      FileHandle.standardError.write(Data("Unknown argument: \(arg)\n".utf8))
    }
    i += 1
  }
  return a
}

// ── stdio helpers ───────────────────────────────────────────────────

let stderr = FileHandle.standardError
let stdout = FileHandle.standardOutput

func eprintln(_ s: String) { stderr.write(Data((s + "\n").utf8)) }

func emitStatus(_ obj: [String: Any], emit: Bool) {
  guard emit else { return }
  if let data = try? JSONSerialization.data(withJSONObject: obj),
     var s = String(data: data, encoding: .utf8) {
    s += "\n"
    stdout.write(Data(s.utf8))
  }
}

// ── Version / help ──────────────────────────────────────────────────

let SAUCEBUNNY_DIARIZE_VERSION = "0.3.0"
let SPEAKERKIT_PACKAGE_VERSION = "1.0.x"
let FLUIDAUDIO_PACKAGE_VERSION = "0.17.5"

func printVersion() {
  print("saucebunny-diarize \(SAUCEBUNNY_DIARIZE_VERSION) (SpeakerKit \(SPEAKERKIT_PACKAGE_VERSION) + FluidAudio \(FLUIDAUDIO_PACKAGE_VERSION))")
}

func printHelp() {
  let help = """
  saucebunny-diarize \(SAUCEBUNNY_DIARIZE_VERSION)
  Offline speaker diarization for Sauce Bunny.

  USAGE:
      saucebunny-diarize --input <audio.wav> --output <turns.json> [options]
      saucebunny-diarize --prepare-models [options]
      saucebunny-diarize --asr --input <audio.wav> --output <cues.srt> [--words <words.json>]
      saucebunny-diarize --asr --batch <items.json>
      saucebunny-diarize --prepare-asr-models
      saucebunny-diarize --version
      saucebunny-diarize --help

  OPTIONS:
      --backend speakerkit|fluidaudio|auto
                            Diarizer backend. Default `auto` tries
                            SpeakerKit first and falls back to FluidAudio
                            on init error.
      --emit-progress       Stream newline-delimited phase JSON on stdout.
      --num-speakers N      Tell the clusterer exactly N speakers.
      --min-speakers N      Lower bound on estimated speaker count.
      --max-speakers N      Upper bound on estimated speaker count.
      --prepare-models      Download/load Core ML models and exit (no diarize).
      --asr                 Transcribe with Parakeet instead of diarizing.
      --asr-model v3|ultra  Which Parakeet (default v3).
      --models-dir DIR      Where the Parakeet Core ML models live.
      --words FILE          Also write each word's measured time and confidence.
      --batch FILE          JSON list of {input, output, words}; one model load.
      --prepare-asr-models  Download the chosen Parakeet and exit.
      --embed               One voiceprint per span of --input (16 kHz mono):
                            --spans FILE ([[start, end], ...] seconds) and
                            --output FILE (a list of 256 numbers, or null).
  """
  print(help)
}

// ── Output JSON envelope ────────────────────────────────────────────

struct Turn {
  let speaker: String
  let start: Double
  let end: Double
}

func writeEnvelope(
  outPath: String,
  modelName: String,
  modelVersion: String,
  audioSeconds: Double,
  wallClockSeconds: Double,
  turns: [Turn]
) throws {
  let turnsJSON: [[String: Any]] = turns.map {
    ["speaker": $0.speaker, "start": $0.start, "end": $0.end]
  }
  let envelope: [String: Any] = [
    "schema_version": 1,
    "model": modelName,
    "model_package_version": modelVersion,
    "audio_seconds": audioSeconds,
    "wall_clock_seconds": wallClockSeconds,
    "turn_count": turns.count,
    "turns": turnsJSON,
  ]
  let data = try JSONSerialization.data(
    withJSONObject: envelope,
    options: [.prettyPrinted, .sortedKeys]
  )
  try data.write(to: URL(fileURLWithPath: outPath), options: .atomic)
}

// ── Backend: SpeakerKit ─────────────────────────────────────────────
//
// Typed 1.0 API — no reflection needed. AudioProcessor loads + resamples
// the WAV into the Float array SpeakerKit expects; diarize() takes
// optional PyannoteDiarizationOptions for speaker-count hints.

// Init split from diarize so `auto` mode can fall back to FluidAudio ONLY on
// init/model errors — once diarization has STARTED, a failure is a real audio
// issue and retrying another backend would just hide it (and report the
// misleading exit 5 "both backends unavailable" instead of exit 3).
func initSpeakerKit(emit: Bool) async throws -> SpeakerKit {
  emitStatus(["phase": "prepare", "message": "Loading SpeakerKit models…", "backend": "speakerkit"], emit: emit)
  // Init triggers HuggingFace model download on first run (cached after).
  let offline = ProcessInfo.processInfo.environment["SAUCE_DIARIZER_OFFLINE"] == "1"
  return try await SpeakerKit(PyannoteConfig(download: !offline, load: offline))
}

func runSpeakerKit(args: Args, emit: Bool) async throws -> ([Turn], String, String) {
  let kit = try await initSpeakerKit(emit: emit)
  return try await runSpeakerKitDiarize(kit: kit, args: args, emit: emit)
}

func runSpeakerKitDiarize(kit: SpeakerKit, args: Args, emit: Bool) async throws -> ([Turn], String, String) {
  emitStatus(["phase": "process", "message": "Running SpeakerKit diarization…"], emit: emit)
  let audio = try loadWavAsFloatArray(path: args.input!)

  // Speaker-count hint. SpeakerKit takes a single Int? on the options
  // type. We honour --num-speakers; --min/--max are FluidAudio-only
  // (SpeakerKit's pyannote-v4 model doesn't expose those bounds yet
  // — when it does we'll wire them here without changing the CLI).
  let options = PyannoteDiarizationOptions(numberOfSpeakers: args.numSpeakers)
  let result = try await kit.diarize(audioArray: audio, options: options)

  // SpeakerKit SpeakerSegment: { speaker: SpeakerInfo, startTime: Float,
  // endTime: Float, frameRate: Float, … }. `speaker.speakerId` is an
  // Int — format to the zero-padded SPEAKER_NN shape Sauce Bunny's
  // frontend humanises into "Speaker N".
  let turns: [Turn] = result.segments.map { seg in
    // speakerId is Int? on SpeakerInfo (the cluster sometimes can't
    // assign a stable id). Fall back to -1 → "SPEAKER_-1" which the
    // frontend humaniser maps to "Unknown speaker".
    let sid = seg.speaker.speakerId ?? -1
    let id = sid >= 0 ? String(format: "SPEAKER_%02d", sid) : "SPEAKER_UNK"
    return Turn(speaker: id, start: Double(seg.startTime), end: Double(seg.endTime))
  }
  return (turns, "speakerkit-pyannote4", SPEAKERKIT_PACKAGE_VERSION)
}

// ── Backend: FluidAudio (fallback) ──────────────────────────────────
//
// Same Mirror-reflection approach we shipped in B.1 — robust against
// FluidAudio's 0.x property renames. Only the *struct* names change
// across releases; the property names we read have been stable.

func runFluidAudio(args: Args, emit: Bool) async throws -> ([Turn], String, String) {
  emitStatus(["phase": "prepare", "message": "Loading FluidAudio models…", "backend": "fluidaudio"], emit: emit)

  var config = OfflineDiarizerConfig()
  if let exact = args.numSpeakers, exact > 0 {
    config = config.withSpeakers(exactly: exact)
  } else if args.minSpeakers != nil || args.maxSpeakers != nil {
    config = config.withSpeakers(min: args.minSpeakers, max: args.maxSpeakers)
  }
  let manager = OfflineDiarizerManager(config: config)
  try await manager.prepareModels()

  emitStatus(["phase": "process", "message": "Running FluidAudio diarization…"], emit: emit)
  let result: Any = try await manager.process(URL(fileURLWithPath: args.input!))

  // Mirror reflection — defense against 0.x API churn.
  var turns: [Turn] = []
  let mirror = Mirror(reflecting: result)
  guard let segments = mirror.children.first(where: { $0.label == "segments" })?.value else {
    throw NSError(
      domain: "saucebunny", code: 3,
      userInfo: [NSLocalizedDescriptionKey: "FluidAudio result lacks `segments` (API rename?)"]
    )
  }
  // FluidAudio 0.14.x's TimedSpeakerSegment.speakerId is a STRING (numeric,
  // from `String(nextSpeakerId)`; "" for unattributed). The old `as? Int` read
  // was always nil, so EVERY segment was skipped and the fallback silently
  // returned zero turns. Accept String or Int and normalize to SPEAKER_%02d;
  // non-numeric IDs (future API churn) get stable first-seen indices.
  var unknownIds: [String: Int] = [:]
  for child in Mirror(reflecting: segments).children {
    let segM = Mirror(reflecting: child.value)
    func num(_ name: String) -> Double? {
      guard let v = segM.children.first(where: { $0.label == name })?.value else { return nil }
      if let d = v as? Double { return d }
      if let f = v as? Float { return Double(f) }
      if let i = v as? Int { return Double(i) }
      return nil
    }
    func idF(_ name: String) -> String? {
      guard let v = segM.children.first(where: { $0.label == name })?.value else { return nil }
      if let s = v as? String { return s }
      if let i = v as? Int { return String(i) }
      return nil
    }
    guard let sid = idF("speakerId"), !sid.isEmpty,
          let s = num("startTimeSeconds"),
          let e = num("endTimeSeconds") else { continue }
    let idx: Int
    if let n = Int(sid) {
      idx = n
    } else if let seen = unknownIds[sid] {
      idx = seen
    } else {
      let next = unknownIds.count
      unknownIds[sid] = next
      idx = next
    }
    turns.append(Turn(speaker: String(format: "SPEAKER_%02d", idx), start: s, end: e))
  }
  return (turns, "fluidaudio-offline-diarizer", FLUIDAUDIO_PACKAGE_VERSION)
}

// ── Prepare-models mode ─────────────────────────────────────────────

func prepareModelsOnly(backend: Backend, emit: Bool) async {
  emitStatus(["phase": "prepare", "message": "Loading diarization models…"], emit: emit)
  do {
    switch backend {
    case .speakerkit:
      _ = try await SpeakerKit()
    case .fluidaudio:
      let manager = OfflineDiarizerManager(config: OfflineDiarizerConfig())
      try await manager.prepareModels()
    case .auto:
      // Mirror the diarize path's auto semantics: SpeakerKit first, FluidAudio
      // on init failure. Otherwise a SpeakerKit download hiccup reports the
      // pre-warm as failed even though a real run would succeed via fallback.
      do {
        _ = try await SpeakerKit()
      } catch let primaryErr {
        eprintln("warning: SpeakerKit prepare failed (\(primaryErr)) — preparing FluidAudio fallback.")
        emitStatus(["phase": "fallback", "message": "SpeakerKit unavailable, preparing FluidAudio…"], emit: emit)
        let manager = OfflineDiarizerManager(config: OfflineDiarizerConfig())
        try await manager.prepareModels()
      }
    }
  } catch {
    eprintln("error: model preparation failed: \(error)")
    exit(2)
  }
  emitStatus(["phase": "done", "message": "Models ready."], emit: emit)
  exit(0)
}

// ── ASR: Parakeet (r90) ─────────────────────────────────────────────
//
// FluidAudio's Parakeet TDT v3 (multilingual) on Core ML — same package as the
// diarizer fallback. transcribe() yields per-token timings; we group them into
// caption-grade SRT cues (≤84 chars, break on sentence end) so the output is
// the SAME .srt contract whisper-cli produces. The Rust caller + the
// diarize-merge step are therefore engine-agnostic.

// Cue construction moved to the SrtCore target so it can be TESTED - it had
// never been executed by any automated tier, and a cue-breaking bug shipped
// through that gap twice. `srtTimecode` and `tokensToSrt` now live there.
// The Rust caller passes --models-dir (app_data_dir/models/parakeet) so the
// Core ML bundle is app-managed + reused across runs, not buried in
// ~/Library/Application Support/FluidAudio.
func asrModelsDirURL(_ args: Args) -> URL? {
  args.modelsDir.map { URL(fileURLWithPath: $0) }
}

func prepareAsrModelsOnly(args: Args) async {
  let size = args.asrModel == .ultra ? "~0.6 GB" : "~0.5 GB"
  emitStatus(["phase": "prepare", "message": "Downloading \(args.asrModel.label) model (\(size), first run only)…", "backend": "parakeet"], emit: args.emitProgress)
  do {
    _ = try await AsrModels.download(to: asrModelsDirURL(args), version: args.asrModel.fluid)
  } catch {
    eprintln("error: \(args.asrModel.label) model download failed: \(error)")
    exit(2)
  }
  emitStatus(["phase": "done", "message": "\(args.asrModel.label) model ready."], emit: args.emitProgress)
  exit(0)
}

/// One file to transcribe: the SRT goes to `output`, the measured words (when
/// asked for) to `words`.
struct AsrItem: Decodable {
  let input: String
  let output: String
  let words: String?
}

func runAsrMode(args: Args) async {
  // Either one file (--input/--output, the single-file transcript path) or a
  // batch manifest (multitrack windows), which loads the model ONCE: loading
  // it per two-minute window was most of the time on a long mic.
  let items: [AsrItem]
  let batch = args.batch != nil
  if let manifest = args.batch {
    guard let data = FileManager.default.contents(atPath: manifest),
          let list = try? JSONDecoder().decode([AsrItem].self, from: data), !list.isEmpty else {
      eprintln("error: --batch needs a JSON list of {input, output, words}")
      exit(1)
    }
    items = list
  } else {
    guard let inPath = args.input, let outPath = args.output else {
      eprintln("error: --asr needs --input <wav> and --output <srt>")
      exit(1)
    }
    items = [AsrItem(input: inPath, output: outPath, words: args.words)]
  }
  for item in items where !FileManager.default.fileExists(atPath: item.input) {
    eprintln("error: input file not found: \(item.input)")
    exit(1)
  }
  let started = Date()
  let label = args.asrModel.label
  do {
    emitStatus(["phase": "prepare", "message": "Loading \(label) model…", "backend": "parakeet"], emit: args.emitProgress)
    // Load from the app-managed dir (offline). If absent, the model wasn't
    // downloaded yet — surface a clear error so the UI prompts a download.
    let models: AsrModels
    if let dir = asrModelsDirURL(args) {
      models = try await AsrModels.load(from: dir, version: args.asrModel.fluid)
    } else {
      models = try await AsrModels.downloadAndLoad(version: args.asrModel.fluid)
    }
    let asr = AsrManager(config: .default)
    try await asr.loadModels(models)

    for (index, item) in items.enumerated() {
      emitStatus(["phase": "process", "message": "Transcribing with \(label)…", "backend": "parakeet",
                  "item": index + 1, "items": items.count], emit: args.emitProgress)
      // TdtDecoderState() is a throwing initializer; a fresh state per file,
      // since the files are separate windows, not one stream.
      var state = try TdtDecoderState()
      let result = try await asr.transcribe(URL(fileURLWithPath: item.input), decoderState: &state)
      let tokens = (result.tokenTimings ?? []).map {
        CueToken(token: $0.token, startTime: Double($0.startTime), endTime: Double($0.endTime), confidence: $0.confidence)
      }
      let srt = tokensToSrt(tokens)
      if srt.isEmpty && !batch {
        eprintln("error: Parakeet produced no transcript (no token timings)")
        exit(3)
      }
      // In a batch an empty window is an answer ("nothing said here"), not a
      // failure: it gets an empty file so the caller can tell it from a crash.
      try srt.write(to: URL(fileURLWithPath: item.output), atomically: true, encoding: .utf8)
      if let wordsPath = item.words {
        let data = try JSONEncoder().encode(tokensToWords(tokens))
        try data.write(to: URL(fileURLWithPath: wordsPath), options: .atomic)
      }
    }
  } catch {
    eprintln("error: \(label) transcription failed: \(error)")
    exit(3)
  }
  emitStatus(["phase": "done", "message": "\(label) transcript ready.",
              "wall_clock_seconds": Date().timeIntervalSince(started)], emit: args.emitProgress)
  exit(0)
}

// ── Voiceprints (accuracy spec, phase 4) ────────────────────────────
//
// A WeSpeaker embedding per span: 256 numbers that describe what a voice
// sounds like, scaled to unit length, so the cosine of two is their dot product. The
// app learns each mic owner's voice from stretches where that mic clearly
// dominates and compares unsure words against them. Nothing here is stored:
// Rust keeps the voiceprints, in the app's support folder, never Documents.

/// Shorter than this a voiceprint says more about the room than the voice.
let embedMinSeconds = 0.5

func runEmbedMode(args: Args) async {
  guard let inPath = args.input, let spansPath = args.spans, let outPath = args.output else {
    eprintln("error: --embed needs --input <wav>, --spans <json> and --output <json>")
    exit(1)
  }
  guard let data = FileManager.default.contents(atPath: spansPath),
        let spans = try? JSONDecoder().decode([[Double]].self, from: data) else {
    eprintln("error: --spans must be a JSON list of [start, end] seconds")
    exit(1)
  }
  do {
    emitStatus(["phase": "prepare", "message": "Loading the voice model…", "backend": "fluidaudio"], emit: args.emitProgress)
    let samples = try loadWavAsFloatArray(path: inPath)
    let manager = DiarizerManager()
    manager.initialize(models: try await DiarizerModels.downloadIfNeeded())
    emitStatus(["phase": "process", "message": "Listening to \(spans.count) stretches…", "backend": "fluidaudio"], emit: args.emitProgress)
    var out: [[Float]?] = []
    for span in spans {
      guard span.count == 2, span[0].isFinite, span[1].isFinite, span[1] - span[0] >= embedMinSeconds else { out.append(nil); continue }
      let from = max(0, Int(span[0] * 16_000)), to = min(samples.count, Int(span[1] * 16_000))
      // The embedding model reads at most ten seconds.
      guard to - from >= Int(embedMinSeconds * 16_000) else { out.append(nil); continue }
      let clip = Array(samples[from..<min(to, from + 160_000)])
      // Measured: FluidAudio 0.17.5's embeddings are NOT unit length (a voice
      // against itself dots to about 13), whatever its doc comment says.
      // Normalised here, so a cosine is a plain dot product downstream.
      guard let raw = try? manager.extractSpeakerEmbedding(from: clip) else { out.append(nil); continue }
      let norm = raw.reduce(0) { $0 + $1 * $1 }.squareRoot()
      out.append(norm > 0 && norm.isFinite ? raw.map { $0 / norm } : nil)
    }
    let json = try JSONEncoder().encode(out)
    try json.write(to: URL(fileURLWithPath: outPath), options: .atomic)
  } catch {
    eprintln("error: voiceprints failed: \(error)")
    exit(3)
  }
  emitStatus(["phase": "done", "message": "Voiceprints ready."], emit: args.emitProgress)
  exit(0)
}

// ── Main ────────────────────────────────────────────────────────────

@main
struct Main {
  static func main() async {
    let args = parseArgs(CommandLine.arguments)

    if args.showHelp { printHelp(); exit(0) }
    if args.showVersion { printVersion(); exit(0) }
    if args.prepareModelsOnly {
      await prepareModelsOnly(backend: args.backend, emit: args.emitProgress)
    }
    // Parakeet ASR (r90) — separate modes from diarization; each exits.
    if args.prepareAsrModels { await prepareAsrModelsOnly(args: args) }
    if args.asr { await runAsrMode(args: args) }
    if args.embed { await runEmbedMode(args: args) }

    guard let inPath = args.input, let outPath = args.output else {
      eprintln("error: --input and --output are required (try --help)")
      exit(1)
    }
    guard FileManager.default.fileExists(atPath: inPath) else {
      eprintln("error: input file not found: \(inPath)")
      exit(1)
    }

    let started = Date()
    var turns: [Turn] = []
    var modelName = ""
    var modelVersion = ""

    // Backend selection. `auto` is "try SpeakerKit, fall back on init
    // error." We deliberately only auto-fallback for init/model errors
    // — once diarization has STARTED, a failure is a real audio issue
    // and retrying with another backend just hides it.
    // Analysis may reuse cached SpeakerKit weights, never initiate a download
    // or fall back to an auto-downloading backend when that cache is missing.
    let backend: Backend = ProcessInfo.processInfo.environment["SAUCE_DIARIZER_OFFLINE"] == "1" ? .speakerkit : args.backend
    switch backend {
    case .speakerkit:
      do {
        let r = try await runSpeakerKit(args: args, emit: args.emitProgress)
        (turns, modelName, modelVersion) = r
      } catch {
        eprintln("error: SpeakerKit failed: \(error)")
        exit(3)
      }
    case .fluidaudio:
      do {
        let r = try await runFluidAudio(args: args, emit: args.emitProgress)
        (turns, modelName, modelVersion) = r
      } catch {
        eprintln("error: FluidAudio failed: \(error)")
        exit(3)
      }
    case .auto:
      // Fallback fires ONLY on init/model failure. A post-init failure
      // (unreadable WAV, processing error) is a real audio problem — exit 3
      // so the Rust caller maps it to "audio processing failed" instead of
      // the misleading "both backends unavailable".
      var kit: SpeakerKit? = nil
      do {
        kit = try await initSpeakerKit(emit: args.emitProgress)
      } catch let primaryErr {
        eprintln("warning: SpeakerKit unavailable (\(primaryErr)) — falling back to FluidAudio.")
        emitStatus(["phase": "fallback", "message": "SpeakerKit unavailable, trying FluidAudio…"], emit: args.emitProgress)
        do {
          let r = try await runFluidAudio(args: args, emit: args.emitProgress)
          (turns, modelName, modelVersion) = r
        } catch let fallbackErr {
          eprintln("error: both backends failed. SpeakerKit: \(primaryErr). FluidAudio: \(fallbackErr)")
          exit(5)
        }
      }
      if let kit {
        do {
          let r = try await runSpeakerKitDiarize(kit: kit, args: args, emit: args.emitProgress)
          (turns, modelName, modelVersion) = r
        } catch {
          eprintln("error: SpeakerKit failed: \(error)")
          exit(3)
        }
      }
    }

    let audioSeconds = turns.map { $0.end }.max() ?? 0
    let wallClock = Date().timeIntervalSince(started)

    do {
      try writeEnvelope(
        outPath: outPath,
        modelName: modelName,
        modelVersion: modelVersion,
        audioSeconds: audioSeconds,
        wallClockSeconds: wallClock,
        turns: turns
      )
    } catch {
      eprintln("error: failed to write \(outPath): \(error)")
      exit(4)
    }

    emitStatus([
      "phase": "done",
      "turns": turns.count,
      "speakers": Set(turns.map { $0.speaker }).count,
      "backend": modelName,
    ], emit: args.emitProgress)
    exit(0)
  }
}
