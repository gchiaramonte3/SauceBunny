import Foundation

/// One line on the helper's stdin, from the app's supervisor
/// (src-tauri/src/commands/obs/service.rs). Anything that does not parse
/// exactly is ignored: the app is the only writer, and a malformed line is a
/// bug to surface in tests, never something to act on half-understood.
public enum Command: Equatable {
    case heartbeat
    case quit
    /// Show the picker; the result comes back as a kind-4 record for `request`.
    case choose(request: UInt64, choice: String, kind: CaptureKind)
    case cancel(request: UInt64)
    case start(slot: Int, generation: UInt64, choice: String, audio: Bool, region: NormalizedRect?)
    case stop(slot: Int, generation: UInt64)

    public static let maxLine = 4_096

    public static func parse(_ line: String) -> Command? {
        if line == "P" { return .heartbeat }
        if line == "Q" { return .quit }
        guard line.utf8.count <= maxLine, let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let op = object["op"] as? String else { return nil }
        switch op {
        case "choose":
            guard let request = generation(object["request"]), let choice = token(object["choice"]),
                  let kind = (object["kind"] as? String).flatMap(CaptureKind.init(rawValue:)) else { return nil }
            return .choose(request: request, choice: choice, kind: kind)
        case "cancel":
            return generation(object["request"]).map { .cancel(request: $0) }
        case "start":
            guard let slot = slot(object["slot"]), let generation = generation(object["generation"]),
                  let choice = token(object["choice"]), let audio = object["audio"] as? Bool else { return nil }
            var region: NormalizedRect?
            if let value = object["region"], !(value is NSNull) {
                guard let parsed = NormalizedRect(value) else { return nil }
                region = parsed
            }
            return .start(slot: slot, generation: generation, choice: choice, audio: audio, region: region)
        case "stop":
            guard let slot = slot(object["slot"]), let generation = generation(object["generation"]) else { return nil }
            return .stop(slot: slot, generation: generation)
        default:
            return nil
        }
    }

    private static func generation(_ value: Any?) -> UInt64? {
        guard let number = value as? NSNumber, CFNumberIsFloatType(number) == false else { return nil }
        let value = number.int64Value
        return value >= 1 && UInt64(value) <= Wire.maxGeneration ? UInt64(value) : nil
    }

    private static func slot(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFNumberIsFloatType(number) == false, (0...1).contains(number.intValue) else { return nil }
        return number.intValue
    }

    /// A choice token is minted by the app: 32 lowercase hex characters.
    private static func token(_ value: Any?) -> String? {
        guard let text = value as? String, text.count == 32, text.allSatisfy({ "0123456789abcdef".contains($0) }) else { return nil }
        return text
    }
}

public enum CaptureKind: String { case screen, window, region }

/// A part of the chosen display, each edge as a fraction of its width or height.
public struct NormalizedRect: Equatable {
    public let x, y, width, height: Double

    public init?(x: Double, y: Double, width: Double, height: Double) {
        guard [x, y, width, height].allSatisfy(\.isFinite), x >= 0, y >= 0, width > 0, height > 0,
              x + width <= 1.000_001, y + height <= 1.000_001 else { return nil }
        self.x = x; self.y = y; self.width = width; self.height = height
    }

    init?(_ value: Any) {
        guard let parts = value as? [NSNumber], parts.count == 4 else { return nil }
        self.init(x: parts[0].doubleValue, y: parts[1].doubleValue, width: parts[2].doubleValue, height: parts[3].doubleValue)
    }
}
