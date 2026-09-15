import AppKit

/// A CLI does not get NSApplicationMain's WindowServer bootstrap. Without it,
/// SCContentFilter's window initializer can abort in CGS_REQUIRE_INIT after an
/// async discovery continuation reaches a cooperative worker. Initialize once
/// on the main thread before any capture-mode await; this neither captures nor
/// requests permission. The helper never activates or creates a window.
@MainActor
func initializeCaptureApplication() -> Bool {
    precondition(Thread.isMainThread)
    let application = NSApplication.shared
    application.setActivationPolicy(.prohibited)
    // The setter may return false when a command-line process is already
    // prohibited. Verify the resulting policy rather than that transition.
    return application.activationPolicy() == .prohibited
}
