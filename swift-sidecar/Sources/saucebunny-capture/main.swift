// saucebunny-capture — ScreenCaptureKit capture engine for review-session
// screen sharing and explicit window previews. Modes:
//
//   list [--thumbs]
//     One JSON object on stdout:
//       { "displays": [ { "id", "width", "height", "label", "thumb"? } ],
//         "windows":  [ { "id", "title", "app", "width", "height", "thumb"? } ] }
//     `thumb` is a base64 JPEG (~320px wide) via SCScreenshotManager.
//   thumbnail --application <bundle id> --process <pid> --window <id>
//     One exact-window, bounded base64 JPEG in JSON. No disk writes or stream.
//   display-thumbnail --identity <JSON UUID, display ID and observed geometry>
//     One exact-display bounded JPEG; revalidates the display after capture.
//
//   stream --kind display|window --id N [--crop x,y,w,h] [--fps 30]
//          [--max-width 1600] [--audio-fifo <path>] [--duration-ms 1..12000]
//     Raw tight-packed BGRA frames on stdout. Before the first frame, ONE
//     meta line on stderr: `meta:{"width":W,"height":H}` — the spawner reads
//     it to build the ffmpeg rawvideo args. With --audio-fifo, 48kHz stereo
//     f32le system audio (this process's own audio excluded) is written to
//     the FIFO. Runs until killed (the Rust proxy owns the lifetime) or the
//     stdout pipe closes.
//     Optional --duration-ms bounds the entire helper lifetime and exits if
//     its spawning parent disappears, including during blocked startup/writes.
//     Bounded window references may add --require-parent-window to reject any
//     window not owned by the immutable, actual spawning process.
//
// `--version` / `--help` exit BEFORE touching ScreenCaptureKit — no TCC
// prompt from the build smoke test or CI. TCC: spawned by the app, capture
// rides the app's Screen Recording grant (responsible-process attribution).

import AVFoundation
import CoreGraphics
import CoreImage
import Foundation
import ScreenCaptureKit

let argv = Array(CommandLine.arguments.dropFirst())

if argv.isEmpty || argv[0] == "--version" || argv[0] == "--help" {
    print("saucebunny-capture (ScreenCaptureKit; list | thumbnail | display-thumbnail | stream)")
    if argv.first == "--help" {
        print("stream: optional --duration-ms 1..12000 bounds capture and stops on parent loss")
        print("bounded window stream: --require-parent-window verifies the spawning process owns the window")
    }
    exit(argv.isEmpty ? 2 : 0)
}

// Install the opt-in bound before discovery, capture startup or a FIFO open.
// Keep this global owner alive for the process lifetime. No flag means no timer.
let streamLifetimeWatchdog: CaptureStreamWatchdog?
let streamRequiredWindowParent: Int32?
do {
    if let limit = try CaptureStreamLimit.parse(arguments: argv) {
        let watchdog = try CaptureStreamWatchdog(limit: limit)
        streamLifetimeWatchdog = watchdog
        streamRequiredWindowParent = watchdog.requiredWindowParent
    } else { streamLifetimeWatchdog = nil; streamRequiredWindowParent = nil }
} catch { fail(error.localizedDescription, code: 2) }

// Keep help/version non-GUI. Real modes need the WindowServer connection
// before their first suspension; no permission request happens here.
guard initializeCaptureApplication() else {
    fail("Capture helper could not initialize the active macOS desktop session.", code: 3)
}

func fail(_ msg: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(("error: " + msg + "\n").data(using: .utf8)!)
    exit(code)
}

func flag(_ name: String) -> Bool { argv.contains(name) }
func opt(_ name: String) -> String? {
    guard let i = argv.firstIndex(of: name), i + 1 < argv.count else { return nil }
    return argv[i + 1]
}

func jsonLine(_ obj: [String: Any]) -> String? {
    guard let d = try? JSONSerialization.data(withJSONObject: obj) else { return nil }
    return String(data: d, encoding: .utf8)
}

/// Small JPEG for picker cards. Nil on any failure — the picker shows a
/// glyph placeholder instead.
func thumbnailJPEG(filter: SCContentFilter, width: Int, height: Int) async throws -> Data {
    let cfg = SCStreamConfiguration()
    let size = try thumbnailDimensions(width: width, height: height)
    cfg.width = size.width
    cfg.height = size.height
    cfg.showsCursor = false
    let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
    guard img.width <= captureThumbnailMaxDimension, img.height <= captureThumbnailMaxDimension else {
        throw CapturePolicyError.invalidDimensions
    }
    let ci = CIImage(cgImage: img)
    let ctx = CIContext()
    guard let jpeg = ctx.jpegRepresentation(of: ci, colorSpace: CGColorSpaceCreateDeviceRGB(),
                                            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.6])
    else { throw CapturePolicyError.invalidJPEG }
    guard jpeg.count <= captureThumbnailMaxJPEGBytes else { throw CapturePolicyError.invalidJPEG }
    return jpeg
}

func thumbnail(filter: SCContentFilter, width: Int, height: Int) async -> String? {
    try? await thumbnailJPEG(filter: filter, width: width, height: height).base64EncodedString()
}

func requireCapturePermission() {
    guard CGPreflightScreenCaptureAccess() else {
        fail("Screen Recording access is not granted. Enable it in System Settings to preview this window.", code: 4)
    }
}

func runThumbnail() async -> Never {
    guard let application = opt("--application"), let process = opt("--process").flatMap(Int32.init),
          let window = opt("--window").flatMap(UInt32.init), process != getppid() else {
        fail(CapturePolicyError.invalidIdentity.localizedDescription, code: 2)
    }
    let requested = CaptureWindowIdentity(application: application, process: process, window: window)
    do { try requested.validate() } catch { fail(error.localizedDescription, code: 2) }
    requireCapturePermission()
    do {
        let jpeg = try await captureExactWindowThumbnail(requested: requested, resolve: {
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            return content.windows.first { $0.windowID == requested.window && $0.isOnScreen && $0.windowLayer == 0 }
        }, identity: { window in
            guard let owner = window.owningApplication else { return nil }
            return CaptureWindowIdentity(application: owner.bundleIdentifier, process: owner.processID, window: window.windowID)
        }, capture: { window in
            try await thumbnailJPEG(filter: SCContentFilter(desktopIndependentWindow: window),
                                    width: Int(window.frame.width), height: Int(window.frame.height))
        })
        guard let out = jsonLine(["application": application, "process": process, "window": window,
                                 "thumb": jpeg.base64EncodedString()]) else { fail("thumbnail JSON encode failed") }
        print(out)
        exit(0)
    } catch { fail("Window thumbnail unavailable: \(error.localizedDescription)", code: 3) }
}

func runDisplayThumbnail() async -> Never {
    guard let raw = opt("--identity"), raw.utf8.count <= 2048,
          let requested = try? JSONDecoder().decode(CaptureDisplayIdentity.self, from: Data(raw.utf8)) else {
        fail(CapturePolicyError.invalidDisplayIdentity.localizedDescription, code: 2)
    }
    do { try requested.validate() } catch { fail(error.localizedDescription, code: 2) }
    requireCapturePermission()
    do {
        let jpeg = try await captureExactDisplayThumbnail(requested: requested, resolve: {
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            return content.displays.first { $0.displayID == requested.displayId }
        }, identity: { captureDisplayIdentity($0.displayID) }, capture: { display in
            try await thumbnailJPEG(filter: SCContentFilter(display: display, excludingWindows: []),
                                    width: Int(requested.geometry.pixelWidth), height: Int(requested.geometry.pixelHeight))
        })
        guard let identity = try JSONSerialization.jsonObject(with: JSONEncoder().encode(requested)) as? [String: Any],
              let out = jsonLine(identity.merging(["thumb": jpeg.base64EncodedString()]) { _, new in new }) else {
            fail("thumbnail JSON encode failed")
        }
        print(out); exit(0)
    } catch { fail("Display thumbnail unavailable: \(error.localizedDescription)", code: 3) }
}

// ── list ────────────────────────────────────────────────────────────────
func runList() async -> Never {
    requireCapturePermission()
    let content: SCShareableContent
    do {
        content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    } catch {
        fail("shareable content unavailable (screen recording permission?): \(error.localizedDescription)", code: 4)
    }
    let wantThumbs = flag("--thumbs")

    var displays: [[String: Any]] = []
    for (i, d) in content.displays.enumerated() {
        var entry: [String: Any] = [
            "id": d.displayID, "width": d.width, "height": d.height,
            "label": i == 0 ? "Display \(i + 1) (Main)" : "Display \(i + 1)",
        ]
        if wantThumbs,
           let t = await thumbnail(filter: SCContentFilter(display: d, excludingWindows: []),
                                   width: d.width, height: d.height) {
            entry["thumb"] = t
        }
        displays.append(entry)
    }

    // Real windows only: on the normal layer, big enough to mean something,
    // not the APP's own windows, and belonging to a nameable app.
    //
    // `ProcessInfo.processInfo.processIdentifier` is THIS SIDECAR's pid, not
    // the app's, so the comparison it used to make never excluded anything -
    // which is why the share picker offered Sauce Bunny's own window and
    // sharing it produced a mirror tunnel. The app passes its pid in.
    // Absent (0), nothing is excluded, which is the old behaviour.
    let excludePid = Int32(opt("--exclude-pid") ?? "0") ?? 0
    let windows = content.windows.filter { w in
        w.isOnScreen && w.windowLayer == 0
            && Int(w.frame.width) >= 120 && Int(w.frame.height) >= 90
            && w.owningApplication != nil
            && (excludePid == 0 || w.owningApplication?.processID != excludePid)
    }
    var windowEntries: [[String: Any]] = []
    for w in windows.prefix(24) {
        var entry: [String: Any] = [
            "id": w.windowID,
            "title": w.title ?? "",
            "app": w.owningApplication?.applicationName ?? "",
            "width": Int(w.frame.width), "height": Int(w.frame.height),
            // The owning process, so the app can find its OWN window to
            // record. Everything else here describes a window to a human
            // picking one; this is the one field a program needs.
            "pid": Int(w.owningApplication?.processID ?? 0),
        ]
        if wantThumbs,
           let t = await thumbnail(filter: SCContentFilter(desktopIndependentWindow: w),
                                   width: Int(w.frame.width), height: Int(w.frame.height)) {
            entry["thumb"] = t
        }
        windowEntries.append(entry)
    }

    guard let out = jsonLine(["displays": displays, "windows": windowEntries]) else {
        fail("json encode failed")
    }
    print(out)
    exit(0)
}

// ── stream ──────────────────────────────────────────────────────────────
final class StreamOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    let audioFifo: FileHandle?
    private var packed: Data
    private let outWidth: Int
    private let outHeight: Int

    init(width: Int, height: Int, audioFifoPath: String?) {
        self.outWidth = width
        self.outHeight = height
        self.packed = Data(count: width * height * 4)
        if let p = audioFifoPath {
            // The reader (ffmpeg) opens the FIFO as an input at spawn; this
            // blocking open resolves as soon as it does.
            self.audioFifo = FileHandle(forWritingAtPath: p)
        } else {
            self.audioFifo = nil
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        switch type {
        case .screen: writeVideo(sample)
        case .audio: writeAudio(sample)
        default: break
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fail("stream stopped: \(error.localizedDescription)", code: 5)
    }

    private func writeVideo(_ sample: CMSampleBuffer) {
        // Only complete frames carry pixels.
        guard let infos = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
                as? [[SCStreamFrameInfo: Any]],
              let statusRaw = infos.first?[.status] as? Int,
              statusRaw == SCFrameStatus.complete.rawValue,
              let buf = CMSampleBufferGetImageBuffer(sample)
        else { return }
        CVPixelBufferLockBaseAddress(buf, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buf, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buf) else { return }
        let stride = CVPixelBufferGetBytesPerRow(buf)
        let w = min(CVPixelBufferGetWidth(buf), outWidth)
        let h = min(CVPixelBufferGetHeight(buf), outHeight)
        let rowBytes = outWidth * 4
        // Tight-pack: CVPixelBuffer rows are stride-padded; ffmpeg's rawvideo
        // reader expects exactly width*4 per row.
        packed.withUnsafeMutableBytes { dst in
            guard let d = dst.baseAddress else { return }
            for row in 0..<h {
                memcpy(d + row * rowBytes, base + row * stride, min(rowBytes, w * 4))
            }
        }
        do {
            try FileHandle.standardOutput.write(contentsOf: packed)
        } catch {
            exit(0) // reader gone (share stopped) - clean exit
        }
    }

    private func writeAudio(_ sample: CMSampleBuffer) {
        guard let fifo = audioFifo, let pcm = captureAudioPCM(sample) else { return }
        fifo.write(pcm)
    }
}

func runStream() async -> Never {
    guard let kind = opt("--kind"), ["display", "window"].contains(kind),
          let idStr = opt("--id"), let id = UInt32(idStr) else {
        fail("stream needs --kind display|window and --id N", code: 2)
    }
    let fps = Int(opt("--fps") ?? "30") ?? 30
    // 1600 is the SHARE's cap - it exists because a share is uploaded once per
    // peer. A recording is an archive, so it opts out and keeps source size.
    let maxWidth = flag("--full-res") ? Int.max : (Int(opt("--max-width") ?? "1600") ?? 1600)
    let audioFifoPath = opt("--audio-fifo")
    guard fps > 0, maxWidth > 0 else { fail("invalid stream dimensions or frame rate", code: 2) }
    requireCapturePermission()

    let content: SCShareableContent
    do {
        content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    } catch {
        fail("shareable content unavailable (screen recording permission?): \(error.localizedDescription)", code: 4)
    }

    let filter: SCContentFilter
    var srcW: Int
    var srcH: Int
    var cropBounds: CGSize?
    var selectedWindowOwner: Int32?
    if kind == "window" {
        guard let w = content.windows.first(where: { $0.windowID == id }) else {
            fail("window \(id) not found (closed?)", code: 3)
        }
        selectedWindowOwner = w.owningApplication?.processID
        guard captureStreamWindowPermitted(requiredParentPID: streamRequiredWindowParent,
                                          ownerPID: selectedWindowOwner, observedParentPID: getppid()) else {
            fail("Reference window is not owned by the original spawning process.", code: 3)
        }
        filter = SCContentFilter(desktopIndependentWindow: w)
        srcW = Int(w.frame.width)
        srcH = Int(w.frame.height)
    } else {
        guard let d = content.displays.first(where: { $0.displayID == id }) else {
            fail("display \(id) not found", code: 3)
        }
        filter = SCContentFilter(display: d, excludingWindows: [])
        srcW = d.width
        srcH = d.height
        cropBounds = d.frame.size
    }
    guard srcW > 0, srcH > 0 else { fail(CapturePolicyError.invalidDimensions.localizedDescription, code: 3) }

    let cfg = SCStreamConfiguration()
    // Portion of a display: SCK crops at the source, cursor included.
    if let crop = opt("--crop") {
        guard let bounds = cropBounds else { fail("Portion capture requires the selected display.", code: 2) }
        do {
            let rect = try captureCrop(crop, width: bounds.width, height: bounds.height)
            cfg.sourceRect = rect
            srcW = Int(rect.width)
            srcH = Int(rect.height)
        } catch { fail(error.localizedDescription, code: 2) }
    }
    let scale = min(1.0, Double(maxWidth) / Double(max(srcW, 1)))
    // Even dimensions - yuv420p downstream requires them.
    let outW = max(32, Int(Double(srcW) * scale)) & ~1
    let outH = max(18, Int(Double(srcH) * scale)) & ~1
    cfg.width = outW
    cfg.height = outH
    cfg.pixelFormat = kCVPixelFormatType_32BGRA
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
    cfg.showsCursor = true
    cfg.queueDepth = 5
    if audioFifoPath != nil {
        cfg.capturesAudio = true
        cfg.sampleRate = 48000
        cfg.channelCount = 2
        // SHARING must exclude our own audio or the room hears itself.
        // RECORDING must include it: when the app is capturing its own window,
        // our process's audio IS the programme audio - the film under review
        // plus the remote participants' voices as the app renders them.
        // Excluded, a recording of a review session has no review in it.
        cfg.excludesCurrentProcessAudio = !flag("--include-own-audio")
    }

    // The spawner reads this ONE stderr line to build the ffmpeg args.
    if let meta = jsonLine(["width": outW, "height": outH]) {
        FileHandle.standardError.write(("meta:" + meta + "\n").data(using: .utf8)!)
    }

    let output = StreamOutput(width: outW, height: outH, audioFifoPath: audioFifoPath)
    let stream = SCStream(filter: filter, configuration: cfg, delegate: output)
    guard captureStreamWindowPermitted(requiredParentPID: streamRequiredWindowParent,
                                      ownerPID: selectedWindowOwner, observedParentPID: getppid()) else {
        fail("Reference window owner changed before capture started.", code: 3)
    }
    do {
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "capture.video"))
        if audioFifoPath != nil {
            try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: DispatchQueue(label: "capture.audio"))
        }
        try await stream.startCapture()
    } catch {
        fail("start capture: \(error.localizedDescription)", code: 5)
    }

    // Park the process until the proxy kills us or the stdout reader goes.
    //
    // This MUST NOT be RunLoop.main.run(): that returns IMMEDIATELY when the
    // run loop has no attached input sources or timers, and SCStream delivers
    // every sample on its own DispatchQueue (see addStreamOutput above), so
    // RunLoop.main has nothing attached. It returned instantly, fell through
    // to exit(0), and killed capture ~0.17s in - after the meta line was
    // written but before a single frame. Every downstream stage then behaved
    // "correctly" on an empty stream, so screen share failed with an HTTP 200,
    // a 780-byte header-only fMP4, and no error anywhere.
    //
    // Keep the top-level task suspended AND retain its capture resources.
    // The parent still owns Stop and the optional reference watchdog still
    // enforces its bound. Do not discard a checked continuation: Swift emits
    // a misuse warning, which killed the helper when the proxy closed stderr.
    await parkCaptureStream(retaining: (stream, output))
}

switch argv[0] {
case "list":
    await runList()
case "stream":
    await runStream()
case "thumbnail":
    await runThumbnail()
case "display-thumbnail":
    await runDisplayThumbnail()
default:
    fail("unknown mode '\(argv[0])' (list | stream)", code: 2)
}
