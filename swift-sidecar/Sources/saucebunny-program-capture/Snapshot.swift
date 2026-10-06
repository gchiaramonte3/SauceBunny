import CoreMedia
import Foundation
import ImageIO
import ProgramCaptureCore
import ScreenCaptureKit
import UniformTypeIdentifiers
import VideoToolbox

/// One still of a pick, so the person can draw a region on what they chose.
/// It comes from a short stream on the picker's own filter: asking the system
/// for a screenshot instead would need Screen Recording permission and bring
/// back the monthly alert (program-capture-picker-contract).
final class Snapshot: NSObject, SCStreamOutput {
    private let stream: SCStream
    private let queue = DispatchQueue(label: "sauce.capture.snapshot")
    private let watcher = StreamWatcher()
    private var done: ((Data?) -> Void)?
    private let lock = NSLock()

    /// Small enough that a JPEG of it is a few dozen KB, large enough to place a region to the pixel.
    static let box = (width: 960, height: 540)

    init?(filter: SCContentFilter) {
        guard let raster = Raster(sourceWidth: Double(filter.contentRect.width) * Double(filter.pointPixelScale),
                                  sourceHeight: Double(filter.contentRect.height) * Double(filter.pointPixelScale), fitting: Snapshot.box) else { return nil }
        let configuration = SCStreamConfiguration()
        configuration.width = raster.width
        configuration.height = raster.height
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 10)
        configuration.queueDepth = 3
        configuration.showsCursor = false
        configuration.capturesAudio = false
        stream = SCStream(filter: filter, configuration: configuration, delegate: watcher)
        super.init()
        watcher.stopped = { [weak self] in self?.settle(nil) }
        do { try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue) } catch { return nil }
    }

    /// The first complete frame as JPEG, or nil within three seconds.
    func take(_ done: @escaping (Data?) -> Void) {
        self.done = done
        stream.startCapture { [weak self] error in if error != nil { self?.settle(nil) } }
        queue.asyncAfter(deadline: .now() + 3) { [weak self] in self?.settle(nil) }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sample.isValid, let buffer = sample.imageBuffer,
              let info = (CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first,
              let raw = info[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete else { return }
        settle(Snapshot.jpeg(buffer))
    }

    private func settle(_ data: Data?) {
        lock.lock(); let finish = done; done = nil; lock.unlock()
        guard let finish else { return }
        stream.stopCapture { _ in }
        DispatchQueue.main.async { finish(data) }
    }

    static func jpeg(_ buffer: CVPixelBuffer) -> Data? {
        var image: CGImage?
        guard VTCreateCGImageFromCVPixelBuffer(buffer, options: nil, imageOut: &image) == noErr, let image else { return nil }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.7] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? data as Data : nil
    }
}
