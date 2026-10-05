import XCTest
@testable import ProgramCaptureCore

final class WireTests: XCTestCase {
    func testHeaderIsKindSlotGenerationLengthBigEndian() {
        let record = Wire.records(.status, slot: 1, generation: 258, payload: Data("{}".utf8))
        XCTAssertEqual(record.count, 1)
        XCTAssertEqual([UInt8](record[0]), [2, 1, 0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 0, 2, 0x7b, 0x7d])
    }

    func testMediaLongerThanAChunkIsSplitNotTruncated() {
        let payload = Data((0..<(Wire.maxChunk * 2 + 5)).map { UInt8($0 % 251) })
        let records = Wire.records(.media, slot: 0, generation: 7, payload: payload)
        XCTAssertEqual(records.map { $0.count - 14 }, [Wire.maxChunk, Wire.maxChunk, 5])
        XCTAssertEqual(Data(records.map { $0.dropFirst(14) }.joined()), payload)
    }

    func testOnlyAnEndRecordIsEmpty() {
        XCTAssertEqual([UInt8](Wire.records(.end, slot: 0, generation: 1, payload: Data())[0]), [3, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0])
    }
}

final class RasterTests: XCTestCase {
    func testFitsInsideTenEightyNeverUpscalesAndIsEven() {
        XCTAssertEqual(Raster(sourceWidth: 3024, sourceHeight: 1964).map { [$0.width, $0.height] }, [1662, 1080])
        XCTAssertEqual(Raster(sourceWidth: 1280, sourceHeight: 721).map { [$0.width, $0.height] }, [1280, 720])
        XCTAssertEqual(Raster(sourceWidth: 5120, sourceHeight: 1440).map { [$0.width, $0.height] }, [1920, 540])
        XCTAssertNil(Raster(sourceWidth: 1, sourceHeight: 900))
        XCTAssertNil(Raster(sourceWidth: .nan, sourceHeight: 900))
    }
}
