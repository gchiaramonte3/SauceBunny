import Foundation
import CoreGraphics

// A picker preview is a small, in-memory JPEG, never a recording or a cache.
let captureThumbnailMaxDimension = 320
let captureThumbnailMaxJPEGBytes = 128 * 1024

struct CaptureWindowIdentity: Equatable {
    let application: String
    let process: Int32
    let window: UInt32

    func validate() throws {
        guard application.utf8.count <= 256, application.contains("."),
              application.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil,
              process > 0, window > 0 else {
            throw CapturePolicyError.invalidIdentity
        }
    }
}

struct CaptureDisplayGeometry: Codable, Equatable {
    let x: Double, y: Double, width: Double, height: Double
    let pixelWidth: UInt32, pixelHeight: UInt32
    func validate() throws {
        let dimensions: [Double] = [width, height, Double(pixelWidth), Double(pixelHeight)]
        let validDimensions = dimensions.allSatisfy { size in
            size.isFinite && size >= 2 && size <= 16_384 && size.rounded() == size
        }
        guard x.isFinite, y.isFinite, abs(x) <= 1_000_000, abs(y) <= 1_000_000, validDimensions else {
            throw CapturePolicyError.invalidDimensions
        }
    }
}

struct CaptureDisplayIdentity: Codable, Equatable {
    let displayUuid: String
    let displayId: UInt32
    let geometry: CaptureDisplayGeometry
    func validate() throws {
        guard displayUuid.utf8.count == 36, UUID(uuidString: displayUuid) != nil, displayId > 0 else {
            throw CapturePolicyError.invalidDisplayIdentity
        }
        try geometry.validate()
    }
}

enum CapturePolicyError: String, Error, LocalizedError {
    case invalidIdentity = "Thumbnail needs an exact application, process and window."
    case windowUnavailable = "The selected window is no longer available. Refresh the window list."
    case invalidDisplayIdentity = "Thumbnail needs an exact display UUID, ID and geometry."
    case displayUnavailable = "The selected display changed. Refresh the display list."
    case invalidDimensions = "The selected source has invalid dimensions."
    case invalidCrop = "The selected portion is invalid or outside its display. Select it again."
    case invalidJPEG = "The selected window thumbnail could not be encoded within the preview limit."
    var errorDescription: String? { rawValue }
}

func thumbnailDimensions(width: Int, height: Int) throws -> (width: Int, height: Int) {
    guard width > 0, height > 0 else { throw CapturePolicyError.invalidDimensions }
    let scale = min(1, Double(captureThumbnailMaxDimension) / Double(max(width, height)))
    return (max(1, Int(Double(width) * scale)), max(1, Int(Double(height) * scale)))
}

func captureCrop(_ value: String, width: Double, height: Double) throws -> CGRect {
    let fields = value.split(separator: ",", omittingEmptySubsequences: false)
    let parts = fields.compactMap { Double($0) }
    guard fields.count == 4, parts.count == 4, parts.allSatisfy(\.isFinite), width.isFinite, height.isFinite,
          parts[0] >= 0, parts[1] >= 0, parts[2] > 16, parts[3] > 16,
          parts[0] + parts[2] <= width, parts[1] + parts[3] <= height else {
        throw CapturePolicyError.invalidCrop
    }
    return CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
}

/// Both lookups are necessary: a window may close or change ownership while
/// SCScreenshotManager is suspended. Never return that image to a stale tile.
func captureExactWindowThumbnail<Window>(requested: CaptureWindowIdentity,
    resolve: () async throws -> Window?, identity: (Window) -> CaptureWindowIdentity?,
    capture: (Window) async throws -> Data) async throws -> Data {
    try requested.validate()
    return try await captureExactThumbnail(requested: requested, resolve: resolve, identity: identity,
                                          capture: capture, unavailable: .windowUnavailable)
}

func captureExactDisplayThumbnail<Display>(requested: CaptureDisplayIdentity,
    resolve: () async throws -> Display?, identity: (Display) -> CaptureDisplayIdentity?,
    capture: (Display) async throws -> Data) async throws -> Data {
    try requested.validate()
    return try await captureExactThumbnail(requested: requested, resolve: resolve, identity: identity,
                                          capture: capture, unavailable: .displayUnavailable)
}

private func captureExactThumbnail<Identity: Equatable, Source>(requested: Identity,
    resolve: () async throws -> Source?, identity: (Source) -> Identity?,
    capture: (Source) async throws -> Data, unavailable: CapturePolicyError) async throws -> Data {
    guard let before = try await resolve(), identity(before) == requested else {
        throw unavailable
    }
    let jpeg = try await capture(before)
    guard let after = try await resolve(), identity(after) == requested else {
        throw unavailable
    }
    guard !jpeg.isEmpty, jpeg.count <= captureThumbnailMaxJPEGBytes else {
        throw CapturePolicyError.invalidJPEG
    }
    return jpeg
}
