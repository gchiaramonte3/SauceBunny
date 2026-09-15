import Darwin
import Dispatch
import Foundation

enum CaptureStreamLifetimeError: LocalizedError {
    case invalidDuration
    case invalidMode
    case unavailableParent
    case invalidParentWindow

    var errorDescription: String? {
        switch self {
        case .invalidDuration: return "--duration-ms requires one integer from 1 through 12000."
        case .invalidMode: return "--duration-ms is only available in stream mode."
        case .unavailableParent: return "Bounded capture requires its original spawning process."
        case .invalidParentWindow: return "--require-parent-window requires bounded stream capture of a window."
        }
    }
}

/// Optional reference-capture bound. Ordinary production streams do not opt in.
struct CaptureStreamLimit: Equatable {
    let durationMilliseconds: UInt64
    let requiresParentWindow: Bool

    static func parse(arguments: [String]) throws -> CaptureStreamLimit? {
        let flag = "--duration-ms"
        let parentFlag = "--require-parent-window"
        let matches = arguments.indices.filter { arguments[$0] == flag || arguments[$0].hasPrefix(flag + "=") }
        let parentMatches = arguments.indices.filter { arguments[$0] == parentFlag || arguments[$0].hasPrefix(parentFlag + "=") }
        guard !matches.isEmpty else {
            guard parentMatches.isEmpty else { throw CaptureStreamLifetimeError.invalidParentWindow }
            return nil
        }
        guard arguments.first == "stream" else { throw CaptureStreamLifetimeError.invalidMode }
        guard matches.count == 1, let index = matches.first, arguments[index] == flag,
              index + 1 < arguments.count else { throw CaptureStreamLifetimeError.invalidDuration }
        let raw = arguments[index + 1]
        guard !raw.isEmpty, raw.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
              let milliseconds = UInt64(raw), (1...12000).contains(milliseconds) else {
            throw CaptureStreamLifetimeError.invalidDuration
        }
        if !parentMatches.isEmpty {
            let kinds = arguments.indices.filter { arguments[$0] == "--kind" }
            guard parentMatches.count == 1, arguments[parentMatches[0]] == parentFlag,
                  kinds.count == 1, let kindIndex = kinds.first, kindIndex + 1 < arguments.count,
                  arguments[kindIndex + 1] == "window" else { throw CaptureStreamLifetimeError.invalidParentWindow }
        }
        return CaptureStreamLimit(durationMilliseconds: milliseconds, requiresParentWindow: !parentMatches.isEmpty)
    }

    func shouldStop(elapsedNanoseconds: UInt64, parentPID: Int32, observedParentPID: Int32) -> Bool {
        parentPID <= 1 || observedParentPID != parentPID || elapsedNanoseconds >= durationMilliseconds * 1_000_000
    }

    func permitsWindow(ownerPID: Int32?, parentPID: Int32, observedParentPID: Int32) -> Bool {
        captureStreamWindowPermitted(requiredParentPID: requiresParentWindow ? parentPID : nil,
                                     ownerPID: ownerPID, observedParentPID: observedParentPID)
    }
}

func captureStreamWindowPermitted(requiredParentPID: Int32?, ownerPID: Int32?, observedParentPID: Int32) -> Bool {
    guard let parentPID = requiredParentPID else { return true }
    return parentPID > 1 && observedParentPID == parentPID && ownerPID == parentPID
}

/// Runs independently of SCK startup and potentially blocked FIFO/stdout writes.
/// Exiting this helper closes its streams even if stopCapture cannot complete.
/// No PID or exclusion identity is accepted from the caller.
final class CaptureStreamWatchdog {
    private let timer: DispatchSourceTimer
    private let limit: CaptureStreamLimit
    private let parentPID: Int32

    init(limit: CaptureStreamLimit) throws {
        let parentPID = getppid()
        guard parentPID > 1, parentPID != getpid() else { throw CaptureStreamLifetimeError.unavailableParent }
        self.parentPID = parentPID
        self.limit = limit
        let started = DispatchTime.now().uptimeNanoseconds
        timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "capture.bounded-lifetime"))
        timer.schedule(deadline: .now() + .milliseconds(Int(min(limit.durationMilliseconds, 25))),
                       repeating: .milliseconds(25), leeway: .milliseconds(1))
        timer.setEventHandler {
            if limit.shouldStop(elapsedNanoseconds: DispatchTime.now().uptimeNanoseconds &- started,
                                parentPID: parentPID, observedParentPID: getppid()) {
                _exit(0)
            }
        }
        timer.resume()
    }

    var requiredWindowParent: Int32? { limit.requiresParentWindow ? parentPID : nil }

    deinit { timer.cancel() }
}

/// A live helper is owned by its parent process and ends when that parent
/// closes/kills it. Keep both SCStream and its output alive across suspension.
/// Discarding a checked continuation emits a runtime misuse diagnostic; a
/// caller that has closed stderr after metadata turns that write into SIGPIPE.
/// Task.sleep has an owned suspension and needs no leaked continuation. The
/// explicit use after each suspension also prevents optimized ARC from
/// releasing capture resources at their previous last use (startCapture).
func parkCaptureStream<Resources>(retaining resources: Resources) async -> Never {
    while true {
        do { try await Task.sleep(nanoseconds: 60_000_000_000) }
        catch {
            withExtendedLifetime(resources) {}
            _exit(0)
        }
        withExtendedLifetime(resources) {}
    }
}
