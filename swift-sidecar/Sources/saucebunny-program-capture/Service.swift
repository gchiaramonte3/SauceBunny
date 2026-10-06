import AppKit
import Foundation
import ProgramCaptureCore
import ScreenCaptureKit

/// The helper's service mode: commands from the app on stdin, records to it
/// on stdout. It holds what the person picked (by the app's token) and runs at
/// most two captures, the Preview's candidate and its published feed.
final class Service {
    private let out = Output()
    private let picker = Picker()
    private var choices: [String: (filter: SCContentFilter, kind: CaptureKind)] = [:]
    private var order: [String] = []
    private var pendingChoose: (request: UInt64, choice: String, kind: CaptureKind)?
    private var slots: [Int: Slot] = [:]
    private var stills: [UInt64: Snapshot] = [:]
    private var lastHeartbeat = Date()
    private let parent = getppid()

    /// A pick the app has not used in a while is dropped; four is plenty for two slots and a re-pick.
    private static let maxChoices = 4

    final class Slot {
        let generation: UInt64
        let choice: String
        let capture: Capture
        let tap: AnyObject?
        var timer: Timer?
        init(generation: UInt64, choice: String, capture: Capture, tap: AnyObject?) {
            self.generation = generation; self.choice = choice; self.capture = capture; self.tap = tap
        }
    }

    func run() {
        let reader = Thread { [weak self] in
            while let line = readLine(strippingNewline: true) {
                guard let command = Command.parse(line) else { continue }
                DispatchQueue.main.async { self?.handle(command) }
            }
            // The app closed our stdin: it quit or crashed. Nothing here outlives it.
            DispatchQueue.main.async { self?.quit() }
        }
        reader.start()
        // No heartbeat for three seconds, or a new parent: the app is gone.
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self else { return }
            if Date().timeIntervalSince(self.lastHeartbeat) > 3 || getppid() != self.parent { self.quit() }
        }
    }

    private func handle(_ command: Command) {
        switch command {
        case .heartbeat: lastHeartbeat = Date()
        case .quit: quit()
        case let .choose(request, choice, kind): choose(request: request, choice: choice, kind: kind)
        case let .cancel(request):
            guard let pending = pendingChoose, pending.request == request else { return }
            pendingChoose = nil
            reply(request: request, ["choice": pending.choice, "outcome": "cancelled"])
        case let .snapshot(request, choice): snapshot(request: request, choice: choice)
        case let .apps(request): reply(request: request, ["outcome": "apps", "apps": Service.audibleApps()])
        case let .start(slot, generation, choice, audio, region, apps): start(slot: slot, generation: generation, choice: choice, audio: audio, region: region, apps: apps)
        case let .stop(slot, generation): stop(slot: slot, generation: generation)
        }
    }

    private func choose(request: UInt64, choice: String, kind: CaptureKind) {
        if let pending = pendingChoose { reply(request: pending.request, ["choice": pending.choice, "outcome": "cancelled"]) }
        pendingChoose = (request, choice, kind)
        picker.choose(kind == .window ? .window : .screen) { [weak self] outcome in
            guard let self, let pending = self.pendingChoose, pending.request == request else { return }
            self.pendingChoose = nil
            switch outcome {
            case .cancelled: self.reply(request: request, ["choice": choice, "outcome": "cancelled"])
            case .failed: self.reply(request: request, ["choice": choice, "outcome": "failed", "error": "picker_failed"])
            case .chosen(let filter):
                self.remember(choice, filter: filter, kind: kind)
                let raster = filter.raster
                self.reply(request: request, ["choice": choice, "outcome": "chosen", "kind": kind.rawValue,
                    "label": Label.of(filter), "width": raster?.width ?? 0, "height": raster?.height ?? 0])
            }
        }
    }

    /// A still of a pick, for drawing a region on: JPEG records, then the answer.
    private func snapshot(request: UInt64, choice: String) {
        guard let chosen = choices[choice], let still = Snapshot(filter: chosen.filter) else {
            reply(request: request, ["choice": choice, "outcome": "failed", "error": "snapshot_failed"]); return
        }
        stills[request] = still
        still.take { [weak self] jpeg in
            guard let self else { return }
            self.stills[request] = nil
            guard let jpeg, !jpeg.isEmpty else { self.reply(request: request, ["choice": choice, "outcome": "failed", "error": "snapshot_failed"]); return }
            self.out.write(Wire.records(.picture, slot: 0, generation: request, payload: jpeg))
            // The size a capture of this pick encodes at, which is what a region's edges are fractions of.
            let raster = chosen.filter.raster
            self.reply(request: request, ["choice": choice, "outcome": "snapshot", "width": raster?.width ?? 0, "height": raster?.height ?? 0])
        }
    }

    private func remember(_ choice: String, filter: SCContentFilter, kind: CaptureKind) {
        choices[choice] = (filter, kind)
        order.removeAll { $0 == choice }
        order.append(choice)
        let inUse = Set(slots.values.map(\.choice))
        while order.count > Service.maxChoices, let oldest = order.first(where: { !inUse.contains($0) }) {
            order.removeAll { $0 == oldest }
            choices[oldest] = nil
        }
    }

    private func start(slot: Int, generation: UInt64, choice: String, audio: Bool, region: NormalizedRect?, apps: [String]?) {
        if let previous = slots[slot] { finish(slot: slot, previous) }
        guard let chosen = choices[choice] else { fail(slot, generation, "start_choice_unknown"); return }
        let filter = chosen.filter
        let points = filter.contentRect.size
        let rect = region.map { CGRect(x: $0.x * points.width, y: $0.y * points.height, width: $0.width * points.width, height: $0.height * points.height) }
        let size = rect?.size ?? points
        guard let raster = Raster(sourceWidth: Double(size.width) * Double(filter.pointPixelScale), sourceHeight: Double(size.height) * Double(filter.pointPixelScale)) else {
            fail(slot, generation, "start_invalid_region"); return
        }
        var tap: AnyObject?
        var take: () -> [Float] = { [] }
        if audio {
            guard #available(macOS 14.2, *) else { fail(slot, generation, "start_audio_unavailable"); return }
            do {
                let rule: AudioTap.Rule
                if let apps {
                    // Only the applications the person chose: nobody hears themselves back.
                    rule = .only(bundles: apps, process: nil)
                } else if chosen.kind == .window {
                    // A window brings only its own application's sound.
                    guard let owner = Service.owner(of: filter) else { fail(slot, generation, "start_application_audio_unavailable"); return }
                    rule = .only(bundles: [owner.bundle], process: owner.process)
                } else {
                    // Everything but Sauce Bunny: this helper, the app, and WebKit's
                    // processes, which play the app's audio (a session's voices
                    // included). Safari plays through them too, so it is left out
                    // with it; choosing apps is the way to include it.
                    rule = .except(processes: [getpid(), parent], bundles: ["com.apple.WebKit"])
                }
                let created = try AudioTap(rule)
                tap = created
                take = { created.take() }
            } catch { fail(slot, generation, "start_audio_tap_failed"); return }
        }
        do {
            let out = self.out
            let capture = try Capture(filter: filter, raster: raster, sourceRect: rect, audio: take, emit: { _, data in
                out.write(Wire.records(.media, slot: UInt8(slot), generation: generation, payload: data))
            }, stopped: { [weak self] code in
                DispatchQueue.main.async { self?.stopped(slot: slot, generation: generation, code: code) }
            })
            let entry = Slot(generation: generation, choice: choice, capture: capture, tap: tap)
            slots[slot] = entry
            capture.start { [weak self] error in
                DispatchQueue.main.async {
                    guard let self, self.slots[slot] === entry else { return }
                    if error != nil { self.slots[slot] = nil; self.release(entry); self.fail(slot, generation, "start_source_initialization_failed"); return }
                    entry.timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.status(slot: slot, entry) }
                }
            }
        } catch {
            if #available(macOS 14.2, *) { (tap as? AudioTap)?.stop() }
            fail(slot, generation, (error as? CaptureError).map { if case .code(let code) = $0 { return code }; return "start_output_failed" } ?? "start_output_failed")
        }
    }

    /// Running applications a person can choose sound from: ordinary apps
    /// (Dock icons), never Sauce Bunny. Names only; no window or screen content.
    static func audibleApps() -> [[String: String]] {
        var seen = Set<String>()
        return NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .compactMap { app -> [String: String]? in
                guard let bundle = app.bundleIdentifier, Command.bundleIdentifier(bundle), !bundle.hasPrefix("com.saucebunny."),
                      seen.insert(bundle).inserted else { return nil }
                let name = String((app.localizedName ?? bundle).unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }.prefix(80).map(Character.init))
                return ["bundle": bundle, "name": name]
            }
            .sorted { $0["name", default: ""].localizedCaseInsensitiveCompare($1["name", default: ""]) == .orderedAscending }
            .prefix(64).map { $0 }
    }

    /// The application that owns a picked window. A picker filter names it from macOS 15.2.
    static func owner(of filter: SCContentFilter) -> (bundle: String, process: pid_t)? {
        guard #available(macOS 15.2, *), let app = filter.includedWindows.first?.owningApplication ?? filter.includedApplications.first,
              !app.bundleIdentifier.isEmpty else { return nil }
        return (app.bundleIdentifier, app.processID)
    }

    private func status(slot: Int, _ entry: Slot, error: String = "", action: String = "none") {
        let object: [String: Any] = ["width": entry.capture.raster.width, "height": entry.capture.raster.height,
                                     "frames": entry.capture.encodedFrames, "error": error, "action": action]
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        out.write(Wire.records(.status, slot: UInt8(slot), generation: entry.generation, payload: data))
    }

    /// The capture ended on its own: the person pressed Stop sharing in the
    /// menu bar, the window closed or the display went away. The app decides
    /// what that means for the room; it then sends `stop`, which ends the slot.
    private func stopped(slot: Int, generation: UInt64, code: String?) {
        guard let entry = slots[slot], entry.generation == generation, let code else { return }
        status(slot: slot, entry, action: code == "source_stopped" ? "stop" : "none")
        if code != "source_stopped" { status(slot: slot, entry, error: code) }
    }

    private func stop(slot: Int, generation: UInt64) {
        guard let entry = slots[slot], entry.generation == generation else { return }
        finish(slot: slot, entry)
    }

    private func finish(slot: Int, _ entry: Slot) {
        slots[slot] = nil
        release(entry)
        out.write(Wire.records(.end, slot: UInt8(slot), generation: entry.generation, payload: Data()))
    }

    private func release(_ entry: Slot) {
        entry.timer?.invalidate()
        entry.capture.stop()
        if #available(macOS 14.2, *) { (entry.tap as? AudioTap)?.stop() }
    }

    /// A start that never got going: say why (a code the app maps to its own words), then end the slot.
    private func fail(_ slot: Int, _ generation: UInt64, _ code: String) {
        let object: [String: Any] = ["width": 2, "height": 2, "frames": 0, "error": code, "action": "none"]
        if let data = try? JSONSerialization.data(withJSONObject: object) { out.write(Wire.records(.status, slot: UInt8(slot), generation: generation, payload: data)) }
        out.write(Wire.records(.end, slot: UInt8(slot), generation: generation, payload: Data()))
    }

    private func reply(request: UInt64, _ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        out.write(Wire.records(.choice, slot: 0, generation: request, payload: data))
    }

    private func quit() {
        for (slot, entry) in slots { finish(slot: slot, entry) }
        out.flush()
        exit(0)
    }
}

/// Stdout belongs to records alone, written whole and in order from any thread.
final class Output {
    private let queue = DispatchQueue(label: "sauce.capture.stdout")
    func write(_ records: [Data]) {
        queue.async {
            for record in records {
                do { try FileHandle.standardOutput.write(contentsOf: record) } catch { exit(0) } // the app stopped reading: it is gone
            }
        }
    }
    func flush() { queue.sync {} }
}

/// What to call a pick in the room and in the Source dialog. A picker filter
/// carries no names before macOS 15.2, so a display is named from NSScreen by
/// its frame, and a window falls back to its size.
enum Label {
    static func of(_ filter: SCContentFilter) -> String {
        if #available(macOS 15.2, *) {
            if let window = filter.includedWindows.first {
                let app = window.owningApplication?.applicationName ?? ""
                let title = window.title ?? ""
                let text = [app, title].filter { !$0.isEmpty }.joined(separator: " · ")
                if !text.isEmpty { return bounded(text) }
            }
        }
        if filter.style == .display, let screen = screen(for: filter.contentRect) { return bounded(screen.localizedName) }
        let size = filter.contentRect.size
        return filter.style == .window ? "Window \(Int(size.width)) × \(Int(size.height))" : "Display \(Int(size.width)) × \(Int(size.height))"
    }

    /// NSScreen frames are bottom-left based; a filter's rect is top-left based on the main display.
    private static func screen(for rect: CGRect) -> NSScreen? {
        guard let main = NSScreen.screens.first else { return nil }
        return NSScreen.screens.first { screen in
            let frame = screen.frame
            let flipped = CGRect(x: frame.minX, y: main.frame.height - frame.maxY, width: frame.width, height: frame.height)
            return abs(flipped.minX - rect.minX) < 1 && abs(flipped.minY - rect.minY) < 1 && abs(flipped.width - rect.width) < 1
        }
    }

    private static func bounded(_ text: String) -> String {
        String(text.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }.prefix(160).map(Character.init))
    }
}
