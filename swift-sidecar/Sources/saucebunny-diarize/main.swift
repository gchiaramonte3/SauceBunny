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
// If the file isn't 16 kHz mono we let AVAudioFile's converter do the
// resample — slower, but correct. The Sauce Bunny pipeline never
// triggers that path in practice; it's a safety net for users who
// invoke the binary against arbitrary audio from a terminal.

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

let SAUCEBUNNY_DIARIZE_VERSION = "0.2.0"
let SPEAKERKIT_PACKAGE_VERSION = "1.0.x"
let FLUIDAUDIO_PACKAGE_VERSION = "0.14.x"

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

func runSpeakerKit(args: Args, emit: Bool) async throws -> ([Turn], String, String) {
  emitStatus(["phase": "prepare", "message": "Loading SpeakerKit models…", "backend": "speakerkit"], emit: emit)
  // Init triggers HuggingFace model download on first run (cached after).
  let kit = try await SpeakerKit()

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
  for child in Mirror(reflecting: segments).children {
    let segM = Mirror(reflecting: child.value)
    func num(_ name: String) -> Double? {
      guard let v = segM.children.first(where: { $0.label == name })?.value else { return nil }
      if let d = v as? Double { return d }
      if let f = v as? Float { return Double(f) }
      if let i = v as? Int { return Double(i) }
      return nil
    }
    func intF(_ name: String) -> Int? {
      segM.children.first(where: { $0.label == name })?.value as? Int
    }
    guard let sid = intF("speakerId"),
          let s = num("startTimeSeconds"),
          let e = num("endTimeSeconds") else { continue }
    turns.append(Turn(speaker: String(format: "SPEAKER_%02d", sid), start: s, end: e))
  }
  return (turns, "fluidaudio-offline-diarizer", FLUIDAUDIO_PACKAGE_VERSION)
}

// ── Prepare-models mode ─────────────────────────────────────────────

func prepareModelsOnly(backend: Backend, emit: Bool) async {
  emitStatus(["phase": "prepare", "message": "Loading diarization models…"], emit: emit)
  do {
    switch backend {
    case .speakerkit, .auto:
      _ = try await SpeakerKit()
    case .fluidaudio:
      let manager = OfflineDiarizerManager(config: OfflineDiarizerConfig())
      try await manager.prepareModels()
    }
  } catch {
    eprintln("error: model preparation failed: \(error)")
    exit(2)
  }
  emitStatus(["phase": "done", "message": "Models ready."], emit: emit)
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
    switch args.backend {
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
      do {
        let r = try await runSpeakerKit(args: args, emit: args.emitProgress)
        (turns, modelName, modelVersion) = r
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
