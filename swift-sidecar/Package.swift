// swift-tools-version: 5.9
//
// Sauce Bunny diarizer sidecar.
//
// One executable, `saucebunny-diarize`. Two diarization backends:
//
//   1. **SpeakerKit** (primary, r41) — Argmax's MIT-licensed pyannote-v4
//      port on Core ML. 1.0 stable API, typed result types, lower macOS
//      floor (13.0). What new installs use by default.
//
//   2. **FluidAudio** (fallback) — pyannote community-1 on Core ML.
//      0.x API, accessed through Mirror reflection in main.swift so a
//      property rename doesn't break us at compile time. Kept because
//      it's a known-good safety net if SpeakerKit's model download
//      fails or its init throws on a given machine.
//
// Selection: CLI `--backend speakerkit|fluidaudio|auto`. `auto` (the
// default) tries SpeakerKit first and falls back to FluidAudio on init
// error. The JSON envelope written to --output is identical across
// backends, so the Rust caller and JS viewer don't care which ran.

import PackageDescription

let package = Package(
  name: "saucebunny-diarize",
  // macOS 14 because FluidAudio (the fallback) needs it. SpeakerKit
  // alone would let us drop to 13; we lift the floor when FluidAudio
  // is no longer needed.
  platforms: [.macOS(.v14)],
  dependencies: [
    // SpeakerKit — primary diarizer. 1.0 stable, typed API.
    .package(
      url: "https://github.com/argmaxinc/argmax-oss-swift.git",
      from: "1.0.0"
    ),
    // FluidAudio — diarizer fallback AND the Parakeet ASR engine (r90).
    // Pinned EXACT: the ASR API (AsrManager.transcribe(_:decoderState:)) is
    // 0.15.x and the 0.x line churns, so we lock the version and re-verify on
    // any bump. Diarizer result-parsing uses Mirror reflection to stay robust.
    .package(
      url: "https://github.com/FluidInference/FluidAudio.git",
      exact: "0.15.3"
    ),
  ],
  targets: [
    // Pure cue-construction for the Parakeet ASR path, with NO dependencies so
    // `swift test` is fast and needs no models on disk. It lives in its own
    // target because an executable target cannot be imported by tests, and
    // this logic had never been executed by any automated tier - CI compiles
    // the sidecars and nothing runs them. A cue-breaking bug shipped through
    // that gap twice; see Sources/SrtCore/SrtCore.swift.
    .target(name: "SrtCore", path: "Sources/SrtCore"),
    .testTarget(
      name: "SrtCoreTests",
      dependencies: ["SrtCore"],
      path: "Tests/SrtCoreTests"
    ),
    .executableTarget(
      name: "saucebunny-diarize",
      dependencies: [
        "SrtCore",
        .product(name: "SpeakerKit", package: "argmax-oss-swift"),
        .product(name: "FluidAudio", package: "FluidAudio"),
      ],
      path: "Sources/saucebunny-diarize"
    ),
    // Dictation sidecar — on-device live speech-to-text via Apple's Speech
    // framework. NO external dependencies (system Speech + AVFoundation only),
    // so it stays light and compiles anywhere; SFSpeechRecognizer is macOS 13+
    // and runs comfortably under this package's macOS 14 floor.
    .executableTarget(
      name: "saucebunny-dictate",
      path: "Sources/saucebunny-dictate"
    ),
    // Screen-share capture engine — ScreenCaptureKit windows/displays/portion
    // + system audio. NO external dependencies (system SCK/AVFoundation only).
    .executableTarget(
      name: "saucebunny-capture",
      path: "Sources/saucebunny-capture"
    ),
  ]
)
