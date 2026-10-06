// saucebunny-program-capture: the Preview source capture helper (Screen,
// Window, Region), on ScreenCaptureKit and macOS's own sharing picker. It
// replaces the embedded OBS helper; see docs/PROGRAM-CAPTURE.md.
//
// Lives as Contents/Helpers/Sauce Bunny Capture.app (LSUIElement), because
// the picker is system UI shown for an application, and the filter it hands
// back is valid only inside the process that showed it: the process that
// chooses must be the process that streams.
//
// Modes:
//   --version
//   --service
//       What the app runs: commands on stdin (choose, cancel, start, stop, P
//       heartbeat, Q quit), records on stdout (see Service.swift).
//   --spike screen|window --seconds N --out file.mp4 [--audio] [--region x,y,w,h] [--again]
//       Development check, not used by the app: shows the picker, records N
//       seconds of the chosen content as the fragmented MP4 the Preview
//       monitor plays, and logs one JSON line per event on stderr. --audio
//       adds system audio through a process tap (this process excluded);
//       --region captures that normalized part of a picked display; --again
//       records a second file (out.again.mp4) from the SAME pick, to prove a
//       choice can be reused without asking again.

import AppKit
import Foundation
import ProgramCaptureCore
import ScreenCaptureKit

let argv = Array(CommandLine.arguments.dropFirst())

func log(_ fields: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]) {
        FileHandle.standardError.write(data + Data("\n".utf8))
    }
}

func value(_ flag: String) -> String? {
    guard let at = argv.firstIndex(of: flag), at + 1 < argv.count else { return nil }
    return argv[at + 1]
}

if argv.first == "--version" { print("saucebunny-program-capture 1"); exit(0) }

// The app's own mode: commands on stdin, records on stdout (Service.swift).
if argv.first == "--service" {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let service = Service()
    service.run()
    app.run()
    exit(0)
}

guard argv.first == "--spike", let kindName = value("--spike"), let kind = Picker.Kind(rawValue: kindName),
      let seconds = value("--seconds").flatMap(Double.init), seconds > 0, seconds <= 600, let out = value("--out") else {
    FileHandle.standardError.write(Data("usage: saucebunny-program-capture --spike screen|window --seconds N --out file.mp4\n".utf8))
    exit(2)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let picker = Picker()
var capture: Capture?
var segments = 0, bytes = 0
let wantsAudio = argv.contains("--audio"), again = argv.contains("--again")
let region: CGRect? = value("--region").flatMap { text in
    let parts = text.split(separator: ",").compactMap { Double($0) }
    return parts.count == 4 ? CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3]) : nil
}
var tap: AnyObject?
func audioSource() -> () -> [Float] {
    guard wantsAudio else { return { [] } }
    if #available(macOS 14.2, *) {
        do {
            let created = try AudioTap(.except(processes: [getpid()], bundles: []))
            tap = created
            log(["event": "audio-tap", "sourceRate": created.sourceRate])
            return { created.take() }
        } catch { log(["event": "audio-tap-failed", "message": "\(error)"]) }
    }
    return { [] }
}

/// One recording of `seconds` from `filter`, then `next`.
func record(_ filter: SCContentFilter, to path: String, audio: @escaping () -> [Float], next: @escaping () -> Void) {
    FileManager.default.createFile(atPath: path, contents: nil)
    guard let sink = FileHandle(forWritingAtPath: path) else { log(["event": "error", "message": "cannot open output"]); exit(2) }
    let points = filter.contentRect.size
    let rect = region.map { CGRect(x: $0.minX * points.width, y: $0.minY * points.height, width: $0.width * points.width, height: $0.height * points.height) }
    let pixels = (rect?.size ?? points)
    guard let raster = Raster(sourceWidth: Double(pixels.width) * Double(filter.pointPixelScale), sourceHeight: Double(pixels.height) * Double(filter.pointPixelScale)) else {
        log(["event": "error", "message": "no size"]); exit(4)
    }
    var written = 0, fragments = 0
    do {
        let running = try Capture(filter: filter, raster: raster, sourceRect: rect, audio: audio, emit: { initialization, data in
            sink.write(data); fragments += initialization ? 0 : 1; written += data.count
        }, stopped: { code in log(["event": "stopped", "code": code ?? "none", "file": path]) })
        capture = running
        running.start { error in
            if let error { log(["event": "start-failed", "message": (error as NSError).localizedDescription, "code": (error as NSError).code]); exit(5) }
            log(["event": "started", "file": path, "width": raster.width, "height": raster.height, "sourceRect": rect.map { [$0.minX, $0.minY, $0.width, $0.height] } ?? []])
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
                let received = running.receivedFrames, encoded = running.encodedFrames
                running.stop()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    log(["event": "done", "file": path, "received": received, "encoded": encoded, "segments": fragments, "bytes": written,
                         "peak": (tap as? AudioPeak)?.audioPeak ?? -1])
                    next()
                }
            }
        }
    } catch { log(["event": "error", "message": "\(error)"]); exit(5) }
}

DispatchQueue.main.async {
    log(["event": "picker-presented", "kind": kind.rawValue])
    picker.choose(kind) { outcome in
        switch outcome {
        case .cancelled: log(["event": "cancelled"]); exit(3)
        case .failed(let message): log(["event": "picker-failed", "message": message]); exit(4)
        case .chosen(let filter):
            log(["event": "chosen", "style": filter.style.rawValue, "rect": [filter.contentRect.minX, filter.contentRect.minY, filter.contentRect.width, filter.contentRect.height],
                 "scale": filter.pointPixelScale])
            let audio = audioSource()
            record(filter, to: out, audio: audio) {
                guard again else { exit(0) }
                // The same filter, a second stream, no second pick.
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                    record(filter, to: out.replacingOccurrences(of: ".mp4", with: ".again.mp4"), audio: audio) { exit(0) }
                }
            }
        }
    }
}
// Nobody chose anything in five minutes: give up rather than wait for ever.
DispatchQueue.main.asyncAfter(deadline: .now() + 300) { if capture == nil { log(["event": "timeout"]); exit(6) } }
app.run()

protocol AudioPeak: AnyObject { var audioPeak: Float { get } }
@available(macOS 14.2, *)
extension AudioTap: AudioPeak { var audioPeak: Float { peak } }
