import CoreGraphics
import ColorSync
import Foundation

/// Passive geometry only. Match OBS discovery's display-mode backing pixels,
/// not CGDisplayPixelsWide/High, which return logical dimensions on scaled
/// Retina displays. Exact identity and post-capture comparison stay intact.
func captureDisplayIdentity(_ id: CGDirectDisplayID) -> CaptureDisplayIdentity? {
    guard id != 0, CGDisplayIsActive(id) != 0,
          let uuid = CGDisplayCreateUUIDFromDisplayID(id)?.takeRetainedValue(),
          let mode = CGDisplayCopyDisplayMode(id),
          let pixelWidth = UInt32(exactly: mode.pixelWidth),
          let pixelHeight = UInt32(exactly: mode.pixelHeight) else { return nil }
    let frame = CGDisplayBounds(id)
    let geometry = CaptureDisplayGeometry(x: frame.minX, y: frame.minY, width: frame.width, height: frame.height,
                                          pixelWidth: pixelWidth, pixelHeight: pixelHeight)
    let identity = CaptureDisplayIdentity(displayUuid: CFUUIDCreateString(nil, uuid) as String,
                                          displayId: id, geometry: geometry)
    guard (try? identity.validate()) != nil else { return nil }
    return identity
}
