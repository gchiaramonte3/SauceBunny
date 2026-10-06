import Foundation

/// The capture service's stdout records, byte for byte what the app's
/// supervisor reads (src-tauri/src/commands/obs/service_wire.rs): a 14-byte
/// header (kind u8, slot u8, generation u64 big-endian, length u32
/// big-endian) and at most 16 KiB of payload. Kind 1 is fMP4 bytes, 2 a
/// status object, 3 the end of a capture (and only it is empty), 4 the answer
/// to a `choose` or `snapshot` request, 5 a still picture's JPEG bytes, sent
/// before the answer to the `snapshot` that asked for it.
public enum Wire {
    public static let maxChunk = 16_384
    public static let maxGeneration: UInt64 = 9_007_199_254_740_991

    public enum Kind: UInt8 { case media = 1, status = 2, end = 3, choice = 4, picture = 5 }

    /// One record per chunk: media longer than a chunk is split, never truncated.
    public static func records(_ kind: Kind, slot: UInt8, generation: UInt64, payload: Data) -> [Data] {
        precondition(slot <= 1 && (1...maxGeneration).contains(generation), "invalid record address")
        if kind == .end { return [header(kind, slot, generation, 0)] }
        precondition(!payload.isEmpty, "only an end record is empty")
        var out: [Data] = []
        var start = payload.startIndex
        while start < payload.endIndex {
            let end = payload.index(start, offsetBy: maxChunk, limitedBy: payload.endIndex) ?? payload.endIndex
            var record = header(kind, slot, generation, UInt32(end - start))
            record.append(payload[start..<end])
            out.append(record)
            start = end
        }
        return out
    }

    static func header(_ kind: Kind, _ slot: UInt8, _ generation: UInt64, _ length: UInt32) -> Data {
        var bytes = Data([kind.rawValue, slot])
        withUnsafeBytes(of: generation.bigEndian) { bytes.append(contentsOf: $0) }
        withUnsafeBytes(of: length.bigEndian) { bytes.append(contentsOf: $0) }
        return bytes
    }
}
