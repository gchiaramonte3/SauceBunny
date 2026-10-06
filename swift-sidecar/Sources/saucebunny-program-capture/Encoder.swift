import AVFoundation
import CoreMedia
import Foundation
import VideoToolbox

/// Hardware H.264 + AAC into fragmented MP4, the recipe the NDI input already
/// ships (src-tauri/native/ndi_bridge.mm): 100 ms segments with a keyframe
/// every 3 frames, no frame reordering, Main profile, 6 Mbps, 48 kHz stereo
/// AAC. Every fragment is independently decodable, so the Preview monitor's
/// 8-fragment ring can start a viewer at any of them.
final class Encoder: NSObject, AVAssetWriterDelegate {
    let width: Int, height: Int
    private let writer: AVAssetWriter
    private let video: AVAssetWriterInput
    private let audio: AVAssetWriterInput
    private let pixels: AVAssetWriterInputPixelBufferAdaptor
    private let audioFormat: CMAudioFormatDescription
    private let emit: (_ initialization: Bool, _ data: Data) -> Void
    private let lock = NSLock()
    private var open = true
    private(set) var appendedFrames: UInt64 = 0
    private(set) var droppedFrames: UInt64 = 0

    static let samplesPerTick = 1_600 // 48 kHz / 30 fps

    init(width: Int, height: Int, emit: @escaping (_ initialization: Bool, _ data: Data) -> Void) throws {
        self.width = width; self.height = height; self.emit = emit
        writer = AVAssetWriter(contentType: .mpeg4Movie)
        writer.outputFileTypeProfile = .mpeg4AppleHLS
        writer.preferredOutputSegmentInterval = CMTime(value: 1, timescale: 10)
        writer.initialSegmentStartTime = .zero
        video = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
            AVVideoEncoderSpecificationKey: [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true],
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 6_000_000, AVVideoExpectedSourceFrameRateKey: 30,
                AVVideoMaxKeyFrameIntervalKey: 3, AVVideoMaxKeyFrameIntervalDurationKey: 0.1,
                AVVideoAllowFrameReorderingKey: false, AVVideoProfileLevelKey: AVVideoProfileLevelH264MainAutoLevel,
            ],
        ])
        video.expectsMediaDataInRealTime = true
        pixels = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
        ])
        audio = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 192_000,
        ])
        audio.expectsMediaDataInRealTime = true
        var asbd = AudioStreamBasicDescription(mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagsNativeFloatPacked, mBytesPerPacket: 8, mFramesPerPacket: 1,
            mBytesPerFrame: 8, mChannelsPerFrame: 2, mBitsPerChannel: 32, mReserved: 0)
        var format: CMAudioFormatDescription?
        guard CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil,
              magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &format) == noErr, let format else {
            throw CaptureError.code("start_output_preparation_failed")
        }
        audioFormat = format
        super.init()
        writer.delegate = self
        guard writer.canAdd(video), writer.canAdd(audio) else { throw CaptureError.code("start_output_preparation_failed") }
        writer.add(video); writer.add(audio)
        guard writer.startWriting() else { throw CaptureError.code("start_output_failed") }
        writer.startSession(atSourceTime: .zero)
    }

    func assetWriter(_ writer: AVAssetWriter, didOutputSegmentData segmentData: Data, segmentType: AVAssetSegmentType) {
        lock.lock(); let live = open; lock.unlock()
        if live { emit(segmentType == .initialization, segmentData) }
    }

    /// One 30 Hz tick: the newest picture (repeated when the screen did not
    /// change) and exactly 1,600 stereo samples, both stamped tick/30 s.
    func append(tick: Int64, picture: CVPixelBuffer, interleaved: [Float]) -> Bool {
        let time = CMTime(value: tick, timescale: 30)
        if video.isReadyForMoreMediaData, pixels.append(picture, withPresentationTime: time) { appendedFrames += 1 } else { droppedFrames += 1 }
        if audio.isReadyForMoreMediaData, let buffer = audioBuffer(interleaved, at: time) { audio.append(buffer) }
        return writer.status != .failed
    }

    private func audioBuffer(_ samples: [Float], at time: CMTime) -> CMSampleBuffer? {
        let bytes = Encoder.samplesPerTick * 2 * MemoryLayout<Float>.size
        var block: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: bytes,
              blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0, dataLength: bytes, flags: 0,
              blockBufferOut: &block) == noErr, let block else { return nil }
        let copied = samples.count == Encoder.samplesPerTick * 2 ? samples : [Float](repeating: 0, count: Encoder.samplesPerTick * 2)
        _ = copied.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: bytes) }
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48_000), presentationTimeStamp: time, decodeTimeStamp: .invalid)
        var size = 8
        var buffer: CMSampleBuffer?
        guard CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: audioFormat,
              sampleCount: Encoder.samplesPerTick, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
              sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &buffer) == noErr else { return nil }
        return buffer
    }

    /// Stops emitting at once; late segment callbacks are dropped.
    func close() {
        lock.lock(); open = false; lock.unlock()
        writer.cancelWriting()
    }
}

enum CaptureError: Error { case code(String) }
