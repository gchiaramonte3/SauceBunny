// Sauce Bunny dictation sidecar — `saucebunny-dictate`.
//
// On-device, live-streaming speech-to-text for short review comments, using
// Apple's Speech framework (SFSpeechRecognizer + AVAudioEngine). Unlike the
// ffmpeg→whisper batch path, this emits PARTIAL transcripts WHILE you speak,
// so words appear in the composer in real time and stay editable before posting.
//
// Protocol — one JSON object per stdout line (the Rust caller parses these and
// re-emits them as Tauri events):
//   {"info":  "<diagnostic>"}            — startup notes (on-device on/off, listening)
//   {"level": 0.0–1.0}                   — mic RMS for the waveform (throttled)
//   {"partial":"<text>","final":false}   — live interim transcript
//   {"partial":"<text>","final":true}    — finalized transcript (then exit 0)
//   {"error": "<message>"}               — fatal; non-zero exit
//
// Stop: send a newline on stdin (or close it) → finalize → final result → exit.
// Args: optional locale id (default "en-US").
//
// macOS 13+ (SFSpeechRecognizer on-device). A SpeechAnalyzer/SpeechTranscriber
// fast path for macOS 26+ is a future addition (needs a Tahoe SDK to compile).

import Foundation
import AVFoundation
import Speech

let firstArg = CommandLine.arguments.dropFirst().first
// `--version` / `--help` exit immediately WITHOUT touching the mic or Speech —
// safe for the build smoke test and headless CI (no TCC prompt).
if firstArg == "--version" || firstArg == "--help" {
    print("saucebunny-dictate (Apple Speech / SFSpeechRecognizer, on-device)")
    exit(0)
}
let localeId = firstArg ?? "en-US"

func emit(_ obj: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: obj),
          let s = String(data: d, encoding: .utf8) else { return }
    print(s)
    fflush(stdout)
}

func die(_ msg: String, _ code: Int32) -> Never {
    emit(["error": msg])
    exit(code)
}

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId))
        ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")) else {
    die("no speech recognizer available for \(localeId)", 2)
}

let engine = AVAudioEngine()
let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true

var lastLevelEmit = Date(timeIntervalSince1970: 0)
var finished = false

func finish(_ code: Int32) -> Never {
    if engine.isRunning { engine.stop() }
    engine.inputNode.removeTap(onBus: 0)
    exit(code)
}

func rms(_ buffer: AVAudioPCMBuffer) -> Float {
    guard let ch = buffer.floatChannelData?[0] else { return 0 }
    let n = Int(buffer.frameLength)
    if n == 0 { return 0 }
    var sum: Float = 0
    for i in 0..<n { let s = ch[i]; sum += s * s }
    let mean = sum / Float(n)
    return mean.squareRoot()
}

func startRecognizing() {
    if recognizer.supportsOnDeviceRecognition {
        request.requiresOnDeviceRecognition = true
        emit(["info": "on-device:on locale:\(recognizer.locale.identifier)"])
    } else {
        // No on-device model for this locale — refuse rather than silently
        // sending audio to Apple's servers (local-first constitution).
        die("on-device speech recognition is unavailable for \(recognizer.locale.identifier)", 6)
    }

    let input = engine.inputNode
    let fmt = input.outputFormat(forBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: fmt) { buffer, _ in
        request.append(buffer)
        // Throttle level events to ~20 Hz; normalise RMS into a lively 0..1.
        let now = Date()
        if now.timeIntervalSince(lastLevelEmit) >= 0.05 {
            lastLevelEmit = now
            let level = min(1.0, Double(rms(buffer)) * 12.0)
            emit(["level": level])
        }
    }
    engine.prepare()
    do { try engine.start() } catch { die("audio engine failed to start: \(error.localizedDescription)", 4) }
    emit(["info": "listening"])

    _ = recognizer.recognitionTask(with: request) { result, error in
        if let result = result {
            let text = result.bestTranscription.formattedString
            emit(["partial": text, "final": result.isFinal])
            if result.isFinal {
                finished = true
                finish(0)
            }
        }
        if error != nil && !finished {
            // After endAudio(), some OS versions surface a benign cancellation
            // here; only treat as fatal if we never delivered a final result.
            finished = true
            emit(["partial": "", "final": true])
            finish(0)
        }
    }
}

// Stop on ANY stdin byte / EOF → finalize. The Rust caller's `dictate_stop`
// writes a single `q` (no newline) to stdin, so we read raw bytes rather than a
// full line. `availableData` returns the bytes, or empty on EOF — either ends it.
DispatchQueue.global().async {
    _ = FileHandle.standardInput.availableData
    if engine.isRunning { engine.stop() }
    engine.inputNode.removeTap(onBus: 0)
    request.endAudio()
}
// Safety cap mirrors the old 5-minute ceiling.
DispatchQueue.global().asyncAfter(deadline: .now() + 300) {
    if !finished { request.endAudio() }
}

SFSpeechRecognizer.requestAuthorization { status in
    switch status {
    case .authorized:    startRecognizing()
    case .denied:        die("speech recognition permission was denied — enable it in System Settings › Privacy & Security › Speech Recognition", 5)
    case .restricted:    die("speech recognition is restricted on this Mac", 5)
    case .notDetermined: die("speech recognition permission was not granted", 5)
    @unknown default:    die("speech recognition permission is unavailable", 5)
    }
}

RunLoop.main.run()
