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
    // FluidAudio — fallback. 0.x; we use Mirror reflection to absorb
    // property renames between releases.
    .package(
      url: "https://github.com/FluidInference/FluidAudio.git",
      from: "0.14.0"
    ),
  ],
  targets: [
    .executableTarget(
      name: "saucebunny-diarize",
      dependencies: [
        .product(name: "SpeakerKit", package: "argmax-oss-swift"),
        .product(name: "FluidAudio", package: "FluidAudio"),
      ],
      path: "Sources/saucebunny-diarize"
    ),
  ]
)
