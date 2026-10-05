import Foundation
import ProgramCaptureCore
import ScreenCaptureKit

/// macOS's own sharing picker. What the person picks arrives as a filter
/// that is valid only inside this process, and choosing through it needs no
/// Screen Recording permission and raises no "bypass the private window
/// picker" alert, which is the reason this helper exists.
final class Picker: NSObject, SCContentSharingPickerObserver {
    enum Kind: String { case screen, window, region }
    enum Outcome { case chosen(SCContentFilter), cancelled, failed(String) }

    private var pending: ((Outcome) -> Void)?

    /// Shows the picker for one kind of content. Sauce Bunny itself is never offered.
    func choose(_ kind: Kind, excludedWindowIDs: [Int] = [], _ done: @escaping (Outcome) -> Void) {
        let picker = SCContentSharingPicker.shared
        var configuration = SCContentSharingPickerConfiguration()
        configuration.allowedPickerModes = kind == .window ? .singleWindow : .singleDisplay
        configuration.excludedBundleIDs = ["com.saucebunny.desktop", "com.saucebunny.desktop.capture"]
        configuration.excludedWindowIDs = excludedWindowIDs
        configuration.allowsChangingSelectedContent = false
        picker.defaultConfiguration = configuration
        picker.maximumStreamCount = 2
        pending = done
        picker.add(self)
        picker.isActive = true
        picker.present(using: kind == .window ? .window : .display)
    }

    private func settle(_ outcome: Outcome) {
        let done = pending
        pending = nil
        let picker = SCContentSharingPicker.shared
        picker.remove(self)
        DispatchQueue.main.async { done?(outcome) }
    }

    func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
        settle(.chosen(filter))
    }

    func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
        settle(.cancelled)
    }

    func contentSharingPickerStartDidFailWithError(_ error: Error) {
        settle(.failed((error as NSError).localizedDescription))
    }
}

extension SCContentFilter {
    /// The chosen content's size in backing pixels, from what a picker filter
    /// exposes without any permission (macOS 14).
    var raster: Raster? {
        Raster(sourceWidth: Double(contentRect.width) * Double(pointPixelScale),
               sourceHeight: Double(contentRect.height) * Double(pointPixelScale))
    }
}
