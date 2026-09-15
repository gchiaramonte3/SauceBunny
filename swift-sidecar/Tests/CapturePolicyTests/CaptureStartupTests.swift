import AppKit
import CoreGraphics

// Build separately with production CaptureStartup.swift. No screenshot,
// shareable-window enumeration, stream, permission API or window is created.
@main struct CaptureStartupTests {
    @MainActor static func main() {
        precondition(Thread.isMainThread)
        precondition(NSApp == nil)
        precondition(initializeCaptureApplication())
        let application = NSApp
        precondition(application != nil && application?.activationPolicy() == .prohibited)
        precondition(application?.windows.isEmpty == true)
        precondition(initializeCaptureApplication())
        precondition(NSApp === application)
        // The production failure enters this WindowServer query from
        // SCContentFilter. Exercise its public equivalent without an image.
        var displays = [CGDirectDisplayID](repeating: 0, count: 16)
        var count: UInt32 = 0
        let result = CGGetDisplaysWithRect(CGRect(x: 0, y: 0, width: 1, height: 1),
            UInt32(displays.count), &displays, &count)
        precondition(result == .success && count <= UInt32(displays.count))
        precondition(captureDisplayIdentity(0) == nil)
        for id in displays.prefix(Int(count)) {
            guard let mode = CGDisplayCopyDisplayMode(id), let observed = captureDisplayIdentity(id) else {
                preconditionFailure("Active display metadata unavailable")
            }
            let bounds = CGDisplayBounds(id)
            precondition(observed.displayId == id && observed.geometry.x == bounds.minX && observed.geometry.y == bounds.minY)
            precondition(observed.geometry.width == bounds.width && observed.geometry.height == bounds.height)
            precondition(observed.geometry.pixelWidth == UInt32(mode.pixelWidth))
            precondition(observed.geometry.pixelHeight == UInt32(mode.pixelHeight))
        }
        print("Capture AppKit bootstrap is main-thread, nonactivating and idempotent; WindowServer query passed without capture.")
        print("Capture display identities match OBS display-mode backing pixels; no pixels captured.")
    }
}
