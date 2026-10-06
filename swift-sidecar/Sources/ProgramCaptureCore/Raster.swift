import Foundation

/// The picture size a capture is encoded at: the source's backing pixels,
/// scaled down (never up) to fit 1920x1080, with even sides. The Preview
/// monitor, the room and NDI all expect at most 1080p, and H.264 4:2:0 needs
/// even dimensions.
public struct Raster: Equatable {
    public let width: Int
    public let height: Int

    public static let maxWidth = 1920
    public static let maxHeight = 1080

    /// `fitting` is the box to fit inside: 1080p for a capture, smaller for a still to draw a region on.
    public init?(sourceWidth: Double, sourceHeight: Double, fitting box: (width: Int, height: Int) = (Raster.maxWidth, Raster.maxHeight)) {
        guard sourceWidth.isFinite, sourceHeight.isFinite, sourceWidth >= 2, sourceHeight >= 2 else { return nil }
        let scale = min(1, Double(box.width) / sourceWidth, Double(box.height) / sourceHeight)
        let width = Int((sourceWidth * scale).rounded(.down)) & ~1
        let height = Int((sourceHeight * scale).rounded(.down)) & ~1
        guard width >= 2, height >= 2 else { return nil }
        self.width = width
        self.height = height
    }
}
