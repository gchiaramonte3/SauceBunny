import Foundation
import CoreMedia

public enum AudioEvidenceError: Error, LocalizedError {
    case invalidRequest, invalidTimestamp, overlappingAudio, nonFiniteAudio
    public var errorDescription: String? {
        switch self {
        case .invalidRequest: return "Invalid source audio range"
        case .invalidTimestamp: return "Decoded audio has no usable presentation timestamp"
        case .overlappingAudio: return "Decoded audio timestamps overlap; audio evidence was not adopted"
        case .nonFiniteAudio: return "Decoded audio contains non-finite samples"
        }
    }
}

public struct AudioEvidenceWindow {
    public let startUs: Int64
    public let endUs: Int64
    public let samples: [Float]
    public var rms: Double {
        sqrt(samples.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(samples.count))
    }
    public var peak: Float { samples.reduce(0) { max($0, abs($1)) } }
}

/// Fixed classifier context, not a downsampled timeline or a full-file PCM cache.
/// Uses decoded PTS and sample duration. Never joins across a timestamp gap.
public struct AudioWindowAssembler {
    public static let sampleRate: Int32 = 48_000
    public static let windowFrames = Int(sampleRate) * 3
    public static let preprocessingVersion = "pcm48k-mono-3s-nonoverlap-v1"
    private let origin: CMTime
    private let end: CMTime
    private var nextPts: CMTime?
    private var pendingStart: CMTime?
    private var pending: [Float] = []
    public private(set) var maximumRetainedFrames = 0

    public init(sourceOriginUs: Int64, durationUs: Int64) throws {
        guard durationUs > 0, durationUs <= 24 * 3600 * 1_000_000,
              sourceOriginUs.addingReportingOverflow(durationUs).overflow == false else {
            throw AudioEvidenceError.invalidRequest
        }
        origin = CMTime(value: sourceOriginUs, timescale: 1_000_000)
        end = CMTimeAdd(origin, CMTime(value: durationUs, timescale: 1_000_000))
        pending.reserveCapacity(Self.windowFrames)
    }

    private func position(_ value: CMTime) throws -> Int64 {
        guard value.isNumeric else { throw AudioEvidenceError.invalidTimestamp }
        let micros = CMTimeConvertScale(CMTimeSubtract(value, origin), timescale: 1_000_000, method: .roundHalfAwayFromZero)
        guard micros.isNumeric else { throw AudioEvidenceError.invalidTimestamp }
        return micros.value
    }

    private mutating func flush(_ consume: (AudioEvidenceWindow) throws -> Void) throws {
        guard let start = pendingStart, !pending.isEmpty else { return }
        let finish = CMTimeAdd(start, CMTime(value: Int64(pending.count), timescale: Self.sampleRate))
        try consume(AudioEvidenceWindow(startUs: position(start), endUs: position(finish), samples: pending))
        pending.removeAll(keepingCapacity: true)
        pendingStart = nil
    }

    public mutating func append(pts: CMTime, samples: UnsafeBufferPointer<Float>,
                               consume: (AudioEvidenceWindow) throws -> Void) throws {
        guard pts.isNumeric else { throw AudioEvidenceError.invalidTimestamp }
        guard !samples.isEmpty else { return }
        // Time-base quantization can round adjacent packet timestamps by one
        // output sample. Anything larger is a real discontinuity, never padding.
        let tolerance = CMTime(value: 1, timescale: Self.sampleRate)
        var start = pts
        if let expected = nextPts {
            let delta = CMTimeSubtract(pts, expected)
            if CMTimeCompare(delta, CMTimeMultiply(tolerance, multiplier: -1)) < 0 {
                throw AudioEvidenceError.overlappingAudio
            }
            if CMTimeCompare(delta, tolerance) > 0 {
                try flush(consume)
            } else {
                start = expected
            }
        }
        nextPts = CMTimeAdd(start, CMTime(value: Int64(samples.count), timescale: Self.sampleRate))
        // Discard pre-roll and samples beyond the inspected video range. Keep
        // only whole source samples, without synthesizing silence at either end.
        let first = max(0, CMTimeConvertScale(CMTimeSubtract(origin, start), timescale: Self.sampleRate,
                                            method: .roundTowardPositiveInfinity).value)
        let last = min(Int64(samples.count), CMTimeConvertScale(CMTimeSubtract(end, start), timescale: Self.sampleRate,
                                                               method: .roundTowardNegativeInfinity).value)
        guard first < last else { return }
        var offset = Int(first)
        while offset < Int(last) {
            if pending.isEmpty {
                pendingStart = CMTimeAdd(start, CMTime(value: Int64(offset), timescale: Self.sampleRate))
            }
            let count = min(Self.windowFrames - pending.count, Int(last) - offset)
            let part = samples[offset..<(offset + count)]
            guard part.allSatisfy({ $0.isFinite }) else { throw AudioEvidenceError.nonFiniteAudio }
            pending.append(contentsOf: part)
            maximumRetainedFrames = max(maximumRetainedFrames, pending.count)
            offset += count
            if pending.count == Self.windowFrames { try flush(consume) }
        }
    }

    public mutating func finish(consume: (AudioEvidenceWindow) throws -> Void) throws {
        try flush(consume)
    }
}
