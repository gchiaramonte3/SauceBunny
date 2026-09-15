import Foundation

// Compiled with the production CapturePolicy.swift, not ScreenCaptureKit.
// No permission API, screenshot API or running application is consulted.
@main struct CapturePolicyTests {
    static func rejects(_ operation: () throws -> Void) {
        do { try operation(); fatalError("expected rejection") } catch {}
    }
    static func main() async throws {
        let landscape = try thumbnailDimensions(width: 3840, height: 2160)
        precondition(landscape.width == 320 && landscape.height == 180)
        let portrait = try thumbnailDimensions(width: 1080, height: 3840)
        precondition(portrait.width <= 320 && portrait.height == 320)
        rejects { _ = try thumbnailDimensions(width: 0, height: 100) }
        for value in ["", "0,0,4,4", "0,0,100", "0,0,bad,100,100", "0,,0,100,100", "-1,0,100,100",
                      "0,0,NaN,100", "0,0,100,inf", "1001,0,100,100", "0,699,100,100"] {
            rejects { _ = try captureCrop(value, width: 1100, height: 700) }
        }
        let crop = try captureCrop("10,20,1090,680", width: 1100, height: 700)
        precondition(crop.maxX == 1100 && crop.maxY == 700)
        let selected = CaptureWindowIdentity(application: "com.example.Editor", process: 123, window: 456)
        let others = [CaptureWindowIdentity(application: "com.example.Other", process: 123, window: 456),
                      CaptureWindowIdentity(application: selected.application, process: 124, window: 456),
                      CaptureWindowIdentity(application: selected.application, process: 123, window: 457)]
        let jpeg = Data([0xff, 0xd8, 0xff, 0xd9])
        var captured = 0
        for other in others {
            do {
                _ = try await captureExactWindowThumbnail(requested: selected, resolve: { other }, identity: { $0 }, capture: { _ in captured += 1; return jpeg })
                fatalError("wrong identity captured")
            } catch { precondition(captured == 0) }
        }
        for after in others.map(Optional.some) + [nil] {
            var lookups = 0
            do {
                _ = try await captureExactWindowThumbnail(requested: selected, resolve: {
                    lookups += 1; return lookups == 1 ? selected : after
                }, identity: { $0 }, capture: { _ in jpeg })
                fatalError("stale identity returned")
            } catch { precondition(lookups == 2) }
        }
        for image in [Data(), Data(repeating: 0, count: captureThumbnailMaxJPEGBytes + 1)] {
            do {
                _ = try await captureExactWindowThumbnail(requested: selected, resolve: { selected }, identity: { $0 }, capture: { _ in image })
                fatalError("invalid image returned")
            } catch {}
        }
        let result = try await captureExactWindowThumbnail(requested: selected, resolve: { selected }, identity: { $0 }, capture: { _ in jpeg })
        precondition(result == jpeg)
        func display(_ uuid: String = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", _ id: UInt32 = 7,
                     x: Double = -1920, y: Double = 0, width: Double = 1920, height: Double = 1080,
                     pixelWidth: UInt32 = 3840, pixelHeight: UInt32 = 2160) -> CaptureDisplayIdentity {
            CaptureDisplayIdentity(displayUuid: uuid, displayId: id,
                geometry: CaptureDisplayGeometry(x: x, y: y, width: width, height: height,
                                                 pixelWidth: pixelWidth, pixelHeight: pixelHeight))
        }
        let requestedDisplay = display()
        let otherDisplays = [display("BBBBBBBB-BBBB-CCCC-DDDD-EEEEEEEEEEEE"), display(requestedDisplay.displayUuid, 8),
            display(x: 0), display(y: -1080), display(width: 1919), display(height: 1079),
            display(pixelWidth: 1920), display(pixelHeight: 1080)]
        for other in otherDisplays {
            var screenshots = 0
            do {
                _ = try await captureExactDisplayThumbnail(requested: requestedDisplay, resolve: { other }, identity: { $0 },
                    capture: { _ in screenshots += 1; return jpeg })
                fatalError("wrong display captured")
            } catch { precondition(screenshots == 0) }
        }
        for after in otherDisplays.map(Optional.some) + [nil] {
            var lookups = 0
            do {
                _ = try await captureExactDisplayThumbnail(requested: requestedDisplay, resolve: {
                    lookups += 1; return lookups == 1 ? requestedDisplay : after
                }, identity: { $0 }, capture: { _ in jpeg })
                fatalError("stale display snapshot returned")
            } catch { precondition(lookups == 2) }
        }
        for invalid in [display("main"), display(requestedDisplay.displayUuid, 0), display(x: .nan), display(y: .infinity),
                        display(width: 0), display(height: -1), display(pixelWidth: 0), display(pixelHeight: 0)] {
            rejects { try invalid.validate() }
        }
        let screenJPEG = try await captureExactDisplayThumbnail(requested: requestedDisplay,
            resolve: { requestedDisplay }, identity: { $0 }, capture: { _ in jpeg })
        precondition(screenJPEG == jpeg)
        // Reported scaled display: legacy CGDisplayPixelsWide/High describe
        // 3008x1269 logical pixels while its mode renders 6016x2538 backing
        // pixels. OBS freezes the latter; the thumbnail must use those too,
        // without relaxing the exact geometry check to admit either value.
        let scaled = display(width: 3008, height: 1269, pixelWidth: 6016, pixelHeight: 2538)
        let logicalOnly = display(width: 3008, height: 1269, pixelWidth: 3008, pixelHeight: 1269)
        var scaledCaptures = 0
        do {
            _ = try await captureExactDisplayThumbnail(requested: scaled, resolve: { logicalOnly }, identity: { $0 },
                capture: { _ in scaledCaptures += 1; return jpeg })
            fatalError("logical dimensions accepted as backing pixels")
        } catch { precondition(scaledCaptures == 0) }
        let scaledJPEG = try await captureExactDisplayThumbnail(requested: scaled, resolve: { scaled }, identity: { $0 },
            capture: { _ in scaledCaptures += 1; return jpeg })
        precondition(scaledJPEG == jpeg && scaledCaptures == 1)
        print("Exact-window/display identity, post-capture invalidation, JPEG/dimension and crop policies passed; no capture APIs called.")
    }
}
