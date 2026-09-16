import XCTest
import CoreMedia
@testable import AudioEvidenceCore

final class AudioWindowsTests: XCTestCase {
    private func append(_ assembler: inout AudioWindowAssembler, _ pts: CMTime, _ samples: [Float], _ rows: inout [AudioEvidenceWindow]) throws {
        try samples.withUnsafeBufferPointer { data in try assembler.append(pts: pts, samples: data) { rows.append($0) } }
    }
    func testNonzeroOriginAndPartialTailUseActualSampleTimes() throws {
        var assembler = try AudioWindowAssembler(sourceOriginUs: 3_000_000, durationUs: 10_000_000)
        var rows: [AudioEvidenceWindow] = []
        try append(&assembler, CMTime(value: 4, timescale: 1), Array(repeating: 0.25, count: 48_000 * 4), &rows)
        try assembler.finish { rows.append($0) }
        XCTAssertEqual(rows.map(\.startUs), [1_000_000, 4_000_000])
        XCTAssertEqual(rows.map(\.endUs), [4_000_000, 5_000_000])
        XCTAssertEqual(rows.map(\.rms), [0.25, 0.25])
        XCTAssertEqual(assembler.maximumRetainedFrames, AudioWindowAssembler.windowFrames)
    }
    func testGapNeverCombinesShortRegionsIntoOneClassifiableWindow() throws {
        var assembler = try AudioWindowAssembler(sourceOriginUs: 0, durationUs: 10_000_000)
        var rows: [AudioEvidenceWindow] = []
        try append(&assembler, .zero, Array(repeating: 0.5, count: 48_000 * 2), &rows)
        try append(&assembler, CMTime(value: 4, timescale: 1), Array(repeating: 0.5, count: 48_000 * 2), &rows)
        try assembler.finish { rows.append($0) }
        XCTAssertEqual(rows.map(\.startUs), [0, 4_000_000])
        XCTAssertEqual(rows.map(\.endUs), [2_000_000, 6_000_000])
        XCTAssertTrue(rows.allSatisfy { $0.samples.count < AudioWindowAssembler.windowFrames })
    }
    func testPrerollAndVideoEndAreClippedWithoutManufacturedSilence() throws {
        var assembler = try AudioWindowAssembler(sourceOriginUs: 1_000_000, durationUs: 500_000)
        var rows: [AudioEvidenceWindow] = []
        try append(&assembler, .zero, Array(repeating: 0.5, count: 48_000 * 2), &rows)
        try assembler.finish { rows.append($0) }
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].startUs, 0); XCTAssertEqual(rows[0].endUs, 500_000)
        XCTAssertEqual(rows[0].samples.count, 24_000)
    }
    func testFractionalPacketClockDoesNotAccumulateMicrosecondRounding() throws {
        var assembler = try AudioWindowAssembler(sourceOriginUs: 0, durationUs: 10_000_000)
        var rows: [AudioEvidenceWindow] = []
        for index in 0..<300 {
            let pts = CMTimeConvertScale(CMTime(value: Int64(index * 1024), timescale: 48_000), timescale: 1_000_000, method: .roundHalfAwayFromZero)
            try append(&assembler, pts, Array(repeating: 0.1, count: 1024), &rows)
        }
        try assembler.finish { rows.append($0) }
        XCTAssertEqual(rows.map(\.startUs), [0, 3_000_000, 6_000_000])
        XCTAssertEqual(rows.last?.endUs, 6_400_000)
    }
    func testInvalidTimestampsOverlapsAndNonFiniteSamplesFailLoudly() throws {
        var assembler = try AudioWindowAssembler(sourceOriginUs: 0, durationUs: 10_000_000)
        var rows: [AudioEvidenceWindow] = []
        XCTAssertThrowsError(try append(&assembler, .invalid, [0], &rows))
        try append(&assembler, .zero, Array(repeating: 0, count: 48_000), &rows)
        XCTAssertThrowsError(try append(&assembler, .zero, [0], &rows))
        XCTAssertThrowsError(try append(&assembler, CMTime(value: 1, timescale: 1), [.nan], &rows))
        XCTAssertTrue(rows.isEmpty)
    }
    func testZeroSignalRemainsExactlyZeroAndLongInputDoesNotGrowWindowStorage() throws {
        var assembler = try AudioWindowAssembler(sourceOriginUs: 0, durationUs: 3_600_000_000)
        var windows = 0
        let silence = Array(repeating: Float(0), count: 48_000)
        for second in 0..<60 {
            try silence.withUnsafeBufferPointer { buffer in
                try assembler.append(pts: CMTime(value: Int64(second), timescale: 1), samples: buffer) { window in
                    XCTAssertEqual(window.rms, 0); XCTAssertEqual(window.peak, 0)
                    windows += 1
                }
            }
        }
        try assembler.finish { _ in XCTFail("Unexpected partial tail") }
        XCTAssertEqual(windows, 20)
        XCTAssertEqual(assembler.maximumRetainedFrames, 144_000)
    }
}
