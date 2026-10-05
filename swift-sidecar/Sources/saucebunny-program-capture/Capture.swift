import CoreMedia
import Foundation
import ProgramCaptureCore
import ScreenCaptureKit

/// One running capture: the stream on a filter the system picker handed us,
/// a 30 Hz pacer that feeds the encoder, and the counts its status reports.
/// The picture is requested at the encoded size in 4:2:0 ('420v'), so frames
/// go to the hardware encoder with no conversion.
final class Capture: NSObject, SCStreamOutput {
    let raster: Raster
    private let stream: SCStream
    private let encoder: Encoder
    private let queue = DispatchQueue(label: "sauce.capture.frames")
    private let pace = DispatchQueue(label: "sauce.capture.pacer")
    private var timer: DispatchSourceTimer?
    private let lock = NSLock()
    private var latest: CVPixelBuffer?
    private var started: UInt64 = 0
    private var lastTick: Int64 = -1
    private(set) var receivedFrames: UInt64 = 0
    private let audio: () -> [Float]
    private let stopped: (_ code: String?) -> Void
    private let watcher = StreamWatcher()

    /// `sourceRect` is a region of a display, in points from the display's top-left.
    init(filter: SCContentFilter, raster: Raster, sourceRect: CGRect? = nil, audio: @escaping () -> [Float],
         emit: @escaping (_ initialization: Bool, _ data: Data) -> Void, stopped: @escaping (_ code: String?) -> Void) throws {
        self.raster = raster; self.audio = audio; self.stopped = stopped
        let configuration = SCStreamConfiguration()
        configuration.width = raster.width
        configuration.height = raster.height
        configuration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        configuration.colorMatrix = kCVImageBufferYCbCrMatrix_ITU_R_709_2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        configuration.queueDepth = 5
        configuration.showsCursor = false
        configuration.scalesToFit = true
        configuration.preservesAspectRatio = true
        if let sourceRect { configuration.sourceRect = sourceRect }
        // Audio comes from a Core Audio tap: without a Screen Recording grant,
        // a picker stream's own audio is silence.
        configuration.capturesAudio = false
        encoder = try Encoder(width: raster.width, height: raster.height, emit: emit)
        stream = SCStream(filter: filter, configuration: configuration, delegate: watcher)
        super.init()
        // The menu bar's Stop sharing, a closed window or an unplugged display all end the stream here.
        watcher.stopped = { [weak self] in self?.finish(code: "source_stopped") }
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
    }

    func start(_ done: @escaping (Error?) -> Void) {
        stream.startCapture { [weak self] error in
            guard let self, error == nil else { done(error); return }
            self.started = DispatchTime.now().uptimeNanoseconds
            let timer = DispatchSource.makeTimerSource(flags: .strict, queue: self.pace)
            timer.schedule(deadline: .now(), repeating: .nanoseconds(1_000_000_000 / 30), leeway: .milliseconds(2))
            timer.setEventHandler { [weak self] in self?.tick() }
            self.timer = timer
            timer.resume()
            done(nil)
        }
    }

    /// The newest tick only: a late wake never encodes a backlog.
    private func tick() {
        let tick = Int64(Double(DispatchTime.now().uptimeNanoseconds - started) / 1e9 * 30)
        guard tick > lastTick else { return }
        lastTick = tick
        lock.lock(); let picture = latest; lock.unlock()
        guard let picture else { return }
        if !encoder.append(tick: tick, picture: picture, interleaved: audio()) { finish(code: "start_output_failed") }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sample.isValid, let buffer = sample.imageBuffer,
              let info = (CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first,
              let raw = info[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete else { return }
        lock.lock(); latest = buffer; receivedFrames += 1; lock.unlock()
    }

    var encodedFrames: UInt64 { encoder.appendedFrames }

    func stop() { finish(code: nil) }

    private var finished = false
    private func finish(code: String?) {
        lock.lock(); let first = !finished; finished = true; lock.unlock()
        guard first else { return }
        timer?.cancel(); timer = nil
        stream.stopCapture { _ in }
        encoder.close()
        stopped(code)
    }
}

/// SCStream takes its delegate at creation, before the capture that owns it exists.
final class StreamWatcher: NSObject, SCStreamDelegate {
    var stopped: (() -> Void)?
    func stream(_ stream: SCStream, didStopWithError error: Error) { stopped?() }
}
