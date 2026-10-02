import Foundation
import AVFoundation
import SoundAnalysis
import CryptoKit
import AudioEvidenceCore

struct Request: Decodable {
    let path: String
    let source_sha256: String
    let analysis_id: String
    let origin_us: Int64
    let duration_us: Int64
    let audio_track_index: Int
}

struct EvidenceFailure: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

func emit(_ packet: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: packet, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

func digest(_ url: URL) throws -> String {
    let file = try FileHandle(forReadingFrom: url)
    defer { try? file.close() }
    var hash = SHA256()
    while let bytes = try file.read(upToCount: 1024 * 1024), !bytes.isEmpty { hash.update(data: bytes) }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
}

/// SoundAnalysis may deliver callbacks off-thread. Completion is the only
/// readiness signal; there is no guessed inference delay or polling loop.
final class ClassificationObserver: NSObject, SNResultsObserving {
    let done = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var windows: [SNClassificationResult] = []
    private var failure: Error?
    func request(_ request: SNRequest, didProduce result: SNResult) {
        lock.lock(); defer { lock.unlock() }
        if let result = result as? SNClassificationResult { windows.append(result) }
        else { failure = EvidenceFailure(message: "Unexpected sound classifier response") }
    }
    func request(_ request: SNRequest, didFailWithError error: Error) {
        lock.lock(); failure = error; lock.unlock(); done.signal()
    }
    func requestDidComplete(_ request: SNRequest) { done.signal() }
    func result() throws -> SNClassificationResult {
        lock.lock(); defer { lock.unlock() }
        if let failure { throw failure }
        guard windows.count == 1 else { throw EvidenceFailure(message: "Sound classifier did not cover the complete audio window") }
        return windows[0]
    }
}

func classify(_ window: AudioEvidenceWindow, format: AVAudioFormat) throws -> [String: Any] {
    var packet: [String: Any] = ["type": "window", "start_us": window.startUs, "end_us": window.endUs,
        "rms": window.rms, "peak": window.peak, "classifications": []]
    // Digital silence is an observable signal fact. Do not mistake the native
    // model's highest scoring class on all-zero input for detected music.
    if window.peak == 0 { packet["status"] = "digital-silence"; return packet }
    guard window.samples.count == AudioWindowAssembler.windowFrames else {
        packet["status"] = "insufficient-context"; return packet
    }
    let request = try SNClassifySoundRequest(classifierIdentifier: .version1)
    request.windowDuration = CMTime(value: 3, timescale: 1)
    request.overlapFactor = 0
    let analyzer = SNAudioStreamAnalyzer(format: format)
    defer { analyzer.removeAllRequests() }
    let observer = ClassificationObserver()
    try analyzer.add(request, withObserver: observer)
    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(window.samples.count)),
          let pointer = buffer.floatChannelData?[0] else { throw EvidenceFailure(message: "Cannot allocate the analysis audio window") }
    buffer.frameLength = buffer.frameCapacity
    window.samples.withUnsafeBufferPointer { pointer.update(from: $0.baseAddress!, count: $0.count) }
    analyzer.analyze(buffer, atAudioFramePosition: 0)
    analyzer.completeAnalysis()
    observer.done.wait()
    let result = try observer.result()
    guard CMTimeCompare(result.timeRange.start, .zero) == 0,
          CMTimeCompare(result.timeRange.duration, request.windowDuration) == 0 else {
        throw EvidenceFailure(message: "Sound classifier returned a different audio coverage range")
    }
    packet["status"] = "classified"
    packet["classifications"] = result.classifications.map { ["identifier": $0.identifier, "score": $0.confidence] as [String: Any] }
    return packet
}

func analyze(_ request: Request) async throws {
    let isHash: (String) -> Bool = { $0.count == 64 && $0.allSatisfy { "0123456789abcdef".contains($0) } }
    guard request.path.hasPrefix("/"), isHash(request.source_sha256), isHash(request.analysis_id), request.audio_track_index >= 0 else {
        throw EvidenceFailure(message: "Invalid audio analysis request")
    }
    var assembler = try AudioWindowAssembler(sourceOriginUs: request.origin_us, durationUs: request.duration_us)
    let url = URL(fileURLWithPath: request.path)
    guard try digest(url) == request.source_sha256 else { throw EvidenceFailure(message: "Source changed before audio analysis") }
    // The worker reads this exact local file only. MOV reference files must not
    // pull remote media or another local file across the source-identity boundary.
    let asset = AVURLAsset(url: url, options: [AVURLAssetReferenceRestrictionsKey: AVAssetReferenceRestrictions.forbidAll.rawValue])
    let tracks = try await asset.loadTracks(withMediaType: .audio)
    if let video = try await asset.loadTracks(withMediaType: .video).first {
        // Track timeRange may include an empty leading edit. Inspect a real
        // sample PTS, not that range's zero or an assumed frame-rate clock.
        let probe = try AVAssetReader(asset: asset)
        defer { probe.cancelReading() }
        let output = AVAssetReaderTrackOutput(track: video, outputSettings: nil)
        guard probe.canAdd(output) else { throw EvidenceFailure(message: "Cannot verify native video timing") }
        probe.add(output)
        guard probe.startReading() else {
            throw probe.error ?? EvidenceFailure(message: "Cannot read the source video origin")
        }
        var firstPts: CMTime?
        while let sample = output.copyNextSampleBuffer() {
            // Empty edit/decoder-boundary events have no presentation frame.
            if sample.numSamples > 0 { firstPts = sample.outputPresentationTimeStamp; break }
        }
        guard let firstPts else { throw EvidenceFailure(message: "Source video has no presentation sample") }
        let start = CMTimeConvertScale(firstPts, timescale: 1_000_000, method: .roundHalfAwayFromZero)
        guard start.isNumeric, start.value == request.origin_us else {
            throw EvidenceFailure(message: "Native video origin differs from the inspected source; audio timestamps were not adopted")
        }
    }
    var terminal: [String: Any] = ["type": "complete", "analysis_id": request.analysis_id,
        "source_sha256": request.source_sha256, "origin_us": request.origin_us, "duration_us": request.duration_us,
        "audio_track_index": request.audio_track_index, "classifier": "apple-soundanalysis-version1",
        "os": ProcessInfo.processInfo.operatingSystemVersionString,
        "preprocessing_version": AudioWindowAssembler.preprocessingVersion]
    if tracks.isEmpty {
        guard request.audio_track_index == 0 else { throw EvidenceFailure(message: "Selected audio track is unavailable") }
        guard try digest(url) == request.source_sha256 else { throw EvidenceFailure(message: "Source changed during audio inspection") }
        terminal["status"] = "no-audio"; terminal["windows"] = 0
        try emit(terminal); return
    }
    guard tracks.indices.contains(request.audio_track_index) else { throw EvidenceFailure(message: "Selected audio track is unavailable") }
    let audioRange = try await tracks[request.audio_track_index].load(.timeRange)
    guard audioRange.isValid, audioRange.start.isNumeric, audioRange.duration.isNumeric else {
        throw EvidenceFailure(message: "Audio track has no reliable source time range")
    }
    let reader = try AVAssetReader(asset: asset)
    defer { reader.cancelReading() }
    let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: Double(AudioWindowAssembler.sampleRate),
        AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false]
    let output = AVAssetReaderTrackOutput(track: tracks[request.audio_track_index], outputSettings: settings)
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else { throw EvidenceFailure(message: "This audio track cannot be decoded by the local audio analyzer") }
    reader.add(output)
    guard reader.startReading() else { throw reader.error ?? EvidenceFailure(message: "Cannot start audio decoding") }
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(AudioWindowAssembler.sampleRate), channels: 1, interleaved: false)!
    var count = 0
    var coveredStart: Int64?, coveredEnd: Int64?
    let consume: (AudioEvidenceWindow) throws -> Void = { window in
        try autoreleasepool { try emit(classify(window, format: format)) }
        if coveredStart == nil { coveredStart = window.startUs }
        coveredEnd = window.endUs
        count += 1
    }
    while let sample = output.copyNextSampleBuffer() {
        try autoreleasepool {
            guard let description = sample.formatDescription,
                  let stream = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee,
                  stream.mSampleRate == Double(AudioWindowAssembler.sampleRate), stream.mChannelsPerFrame == 1,
                  stream.mBitsPerChannel == 32, stream.mFormatFlags & kAudioFormatFlagIsFloat != 0 else {
                throw EvidenceFailure(message: "Decoder returned an unexpected PCM format")
            }
            let frames = sample.numSamples
            guard frames > 0, frames <= Int(Int32.max), let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else {
                throw EvidenceFailure(message: "Decoder returned empty audio")
            }
            buffer.frameLength = AVAudioFrameCount(frames)
            let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: 0, frameCount: Int32(frames), into: buffer.mutableAudioBufferList)
            guard status == noErr, let pointer = buffer.floatChannelData?[0] else { throw EvidenceFailure(message: "Cannot copy decoded PCM samples") }
            // Output PTS includes the container's edit mapping; raw packet PTS
            // can be zero-based even when the source starts several seconds in.
            try assembler.append(pts: sample.outputPresentationTimeStamp, samples: UnsafeBufferPointer(start: pointer, count: frames), consume: consume)
        }
    }
    guard reader.status == .completed else { throw reader.error ?? EvidenceFailure(message: "Audio decoding stopped before EOF") }
    try assembler.finish(consume: consume)
    let origin = CMTime(value: request.origin_us, timescale: 1_000_000)
    let expectedStart = max(0, CMTimeConvertScale(CMTimeSubtract(audioRange.start, origin), timescale: 1_000_000, method: .roundHalfAwayFromZero).value)
    let expectedEnd = min(request.duration_us, CMTimeConvertScale(CMTimeSubtract(audioRange.end, origin), timescale: 1_000_000, method: .roundHalfAwayFromZero).value)
    // AVAssetReader can flatten packet timestamp gaps while decoding AAC.
    // A source-range disagreement invalidates the entire streamed result. The
    // allowance follows the source container's endpoint precision (MOV edit
    // lists may use milliseconds) or one resampled output sample, whichever is
    // coarser. Coverage still reports only the samples actually decoded.
    let sampleUs: Int64 = (1_000_000 + Int64(AudioWindowAssembler.sampleRate) - 1) / Int64(AudioWindowAssembler.sampleRate)
    let editTickUs = (1_000_000 + Int64(audioRange.duration.timescale) - 1) / Int64(audioRange.duration.timescale)
    let endpointPrecisionUs = max(sampleUs, editTickUs)
    if expectedStart < expectedEnd {
        guard let start = coveredStart, let end = coveredEnd,
              abs(start - expectedStart) <= endpointPrecisionUs, abs(end - expectedEnd) <= endpointPrecisionUs else {
            throw EvidenceFailure(message: "Native audio decoding changed source timing; audio evidence was not adopted")
        }
    }
    guard try digest(url) == request.source_sha256 else { throw EvidenceFailure(message: "Source changed during audio analysis") }
    terminal["status"] = "decoded"; terminal["windows"] = count
    terminal["maximum_retained_frames"] = assembler.maximumRetainedFrames
    try emit(terminal)
}

@main struct AudioAnalysisMain {
    static func main() async {
        do {
            guard let line = readLine() else { throw EvidenceFailure(message: "Missing audio analysis request") }
            let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
            try await analyze(request)
        } catch {
            try? emit(["type": "error", "message": error.localizedDescription])
            exit(1)
        }
    }
}
