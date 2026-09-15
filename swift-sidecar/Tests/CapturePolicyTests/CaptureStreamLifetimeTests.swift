import Foundation

// Pure argument and clock/parent observations. No AppKit, SCK, capture, timer
// startup or process termination is used by these tests.
@main struct CaptureStreamLifetimeTests {
    static func rejects(_ arguments: [String]) {
        do { _ = try CaptureStreamLimit.parse(arguments: arguments); fatalError("expected rejection") } catch {}
    }

    static func main() throws {
        let ordinaryStream = try CaptureStreamLimit.parse(arguments: ["stream", "--kind", "window", "--id", "42"])
        let ordinaryList = try CaptureStreamLimit.parse(arguments: ["list"])
        precondition(ordinaryStream == nil && ordinaryList == nil)
        for raw in ["1", "12", "1000", "12000", "00001"] {
            let limit = try CaptureStreamLimit.parse(arguments: ["stream", "--duration-ms", raw])!
            precondition(limit.durationMilliseconds == UInt64(raw))
        }
        for raw in ["", "0", "12001", "-1", "+1", "1.5", "1e3", " 1", "1 ", "nan", "--fps", "18446744073709551616"] {
            rejects(["stream", "--duration-ms", raw])
        }
        rejects(["stream", "--duration-ms"])
        rejects(["stream", "--duration-ms=100"])
        rejects(["stream", "--duration-ms", "1", "--duration-ms", "2"])
        rejects(["stream", "--duration-ms", "1", "--duration-ms=2"])
        for mode in ["list", "thumbnail", "display-thumbnail", "unknown"] {
            rejects([mode, "--duration-ms", "100"])
        }
        let limit = try CaptureStreamLimit.parse(arguments: ["stream", "--duration-ms", "12000"])!
        precondition(!limit.shouldStop(elapsedNanoseconds: 0, parentPID: 42, observedParentPID: 42))
        precondition(!limit.shouldStop(elapsedNanoseconds: 11_999_999_999, parentPID: 42, observedParentPID: 42))
        precondition(limit.shouldStop(elapsedNanoseconds: 12_000_000_000, parentPID: 42, observedParentPID: 42))
        precondition(limit.shouldStop(elapsedNanoseconds: .max, parentPID: 42, observedParentPID: 42))
        for actual in [Int32(1), 43, 0, -1] {
            precondition(limit.shouldStop(elapsedNanoseconds: 0, parentPID: 42, observedParentPID: actual))
        }
        for original in [Int32(0), 1, -1] {
            precondition(limit.shouldStop(elapsedNanoseconds: 0, parentPID: original, observedParentPID: original))
        }
        let shortest = try CaptureStreamLimit.parse(arguments: ["stream", "--duration-ms", "1"])!
        precondition(!shortest.shouldStop(elapsedNanoseconds: 999_999, parentPID: 42, observedParentPID: 42))
        precondition(shortest.shouldStop(elapsedNanoseconds: 1_000_000, parentPID: 42, observedParentPID: 42))
        precondition(!shortest.requiresParentWindow)
        precondition(shortest.permitsWindow(ownerPID: nil, parentPID: 42, observedParentPID: 43))
        let parentArgs = ["stream", "--kind", "window", "--duration-ms", "12000", "--require-parent-window"]
        let parentWindow = try CaptureStreamLimit.parse(arguments: parentArgs)!
        precondition(parentWindow.requiresParentWindow)
        precondition(parentWindow.permitsWindow(ownerPID: 42, parentPID: 42, observedParentPID: 42))
        for owner in [nil, Int32(43), Int32(1)] {
            precondition(!parentWindow.permitsWindow(ownerPID: owner, parentPID: 42, observedParentPID: 42))
        }
        precondition(!parentWindow.permitsWindow(ownerPID: 42, parentPID: 42, observedParentPID: 1))
        precondition(!parentWindow.permitsWindow(ownerPID: 1, parentPID: 1, observedParentPID: 1))
        rejects(["stream", "--kind", "window", "--require-parent-window"])
        rejects(["stream", "--kind", "display", "--duration-ms", "100", "--require-parent-window"])
        rejects(["stream", "--duration-ms", "100", "--require-parent-window"])
        rejects(parentArgs + ["--require-parent-window"])
        rejects(["stream", "--kind", "window", "--duration-ms", "100", "--require-parent-window=true"])
        rejects(parentArgs + ["--kind", "display"])
        print("Bounded stream argument, monotonic deadline and parent-loss policies passed; no capture APIs called.")
    }
}
