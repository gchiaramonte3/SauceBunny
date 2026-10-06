import AVFoundation
import CoreAudio
import Foundation

/// System or application audio through a Core Audio process tap (macOS 14.2).
/// A picker stream's own audio is silence without a Screen Recording grant,
/// so sound comes from here, behind the narrower "System Audio Recording
/// Only" permission. Converted to 48 kHz stereo float and held in a short
/// ring the 30 Hz pacer drains 1,600 frames at a time.
@available(macOS 14.2, *)
final class AudioTap {
    private var tap = AudioObjectID(kAudioObjectUnknown)
    private var aggregate = AudioObjectID(kAudioObjectUnknown)
    private var proc: AudioDeviceIOProcID?
    private let queue = DispatchQueue(label: "sauce.capture.audio")
    private let ring = SampleRing(capacity: 48_000 * 2 * 2)
    private var converter: AVAudioConverter?
    private let output = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 2, interleaved: true)!
    private(set) var sourceRate: Double = 0
    private(set) var peak: Float = 0

    /// Whose sound to hear. Matching is by bundle identifier and its helpers
    /// ("com.google.Chrome" also takes "com.google.Chrome.helper"), because
    /// most apps play from a helper process rather than the one that owns the window.
    enum Rule {
        /// Only these applications (and this process, when known).
        case only(bundles: [String], process: pid_t?)
        /// Everything except these processes and applications.
        case except(processes: [pid_t], bundles: [String])
    }

    /// Core Audio only knows a process once it has opened audio, and helpers come
    /// and go mid-capture, so the rule is applied again every second. An `only`
    /// tap with nothing to hear yet waits silently until there is something.
    init(_ rule: Rule) throws {
        self.rule = rule
        control.sync { refresh() }
        if startFailed { throw CaptureError.code("start_audio_tap_failed") }
        let timer = DispatchSource.makeTimerSource(queue: control)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in self?.refresh() }
        watch = timer
        timer.resume()
    }

    private var rule: Rule?
    private var description: CATapDescription?
    private var matched: [AudioObjectID]?
    private var startFailed = false
    private var watch: DispatchSourceTimer?
    private let control = DispatchQueue(label: "sauce.capture.audio.control")

    private static func matches(_ bundle: String?, _ bundles: [String]) -> Bool {
        guard let bundle else { return false }
        return bundles.contains { bundle == $0 || bundle.hasPrefix($0 + ".") }
    }

    private func refresh() {
        guard let rule else { return }
        let found = AudioTap.processObjects().filter { object in
            switch rule {
            case let .only(bundles, process):
                return (process != nil && AudioTap.pid(of: object) == process) || AudioTap.matches(AudioTap.bundle(of: object), bundles)
            case let .except(processes, bundles):
                return AudioTap.pid(of: object).map(processes.contains) == true || AudioTap.matches(AudioTap.bundle(of: object), bundles)
            }
        }
        guard found != matched else { return }
        if let description, tap != kAudioObjectUnknown {
            matched = found
            description.processes = found
            var address = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyDescription, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            // The property's data is the description object itself, passed by reference.
            var object = Unmanaged.passUnretained(description).toOpaque()
            _ = AudioObjectSetPropertyData(tap, &address, 0, nil, UInt32(MemoryLayout<UnsafeMutableRawPointer>.size), &object)
            return
        }
        if case .only = rule, found.isEmpty { return }
        matched = found
        let description: CATapDescription
        switch rule {
        case .only: description = CATapDescription(stereoMixdownOfProcesses: found)
        case .except: description = CATapDescription(stereoGlobalTapButExcludeProcesses: found)
        }
        do { try start(description) } catch { startFailed = true }
    }

    private func start(_ description: CATapDescription) throws {
        self.description = description
        description.uuid = UUID()
        description.name = "Sauce Bunny Preview source"
        description.isPrivate = true
        description.muteBehavior = .unmuted
        guard AudioHardwareCreateProcessTap(description, &tap) == noErr else { throw CaptureError.code("start_audio_tap_failed") }
        var format = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &format) == noErr,
              let input = AVAudioFormat(streamDescription: &format) else { teardown(); throw CaptureError.code("start_audio_tap_failed") }
        sourceRate = input.sampleRate
        converter = AVAudioConverter(from: input, to: output)
        let device: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Sauce Bunny Preview source",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: description.uuid.uuidString, kAudioSubTapDriftCompensationKey: true]],
        ]
        guard AudioHardwareCreateAggregateDevice(device as CFDictionary, &aggregate) == noErr else { teardown(); throw CaptureError.code("start_audio_tap_failed") }
        let status = AudioDeviceCreateIOProcIDWithBlock(&proc, aggregate, queue) { [weak self] _, inputData, _, _, _ in
            self?.receive(inputData, format: input)
        }
        guard status == noErr, let proc, AudioDeviceStart(aggregate, proc) == noErr else { teardown(); throw CaptureError.code("start_audio_tap_failed") }
    }

    private func receive(_ list: UnsafePointer<AudioBufferList>, format: AVAudioFormat) {
        guard let converter, let source = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: list, deallocator: nil) else { return }
        let capacity = AVAudioFrameCount(Double(source.frameLength) * 48_000 / format.sampleRate) + 32
        guard let converted = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return }
        var fed = false
        converter.convert(to: converted, error: nil) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData; return source
        }
        guard let samples = converted.floatChannelData?[0] else { return }
        let count = Int(converted.frameLength) * 2
        var loudest: Float = 0
        for index in 0..<count { loudest = max(loudest, abs(samples[index])) }
        peak = max(peak * 0.9, loudest)
        ring.write(UnsafeBufferPointer(start: samples, count: count))
    }

    /// Exactly one tick of audio, zero-filled when the tap has not caught up.
    func take() -> [Float] { ring.read(1_600 * 2) }

    func stop() {
        watch?.cancel()
        control.sync { rule = nil; teardown() }
    }

    private func teardown() {
        if let proc { AudioDeviceStop(aggregate, proc); AudioDeviceDestroyIOProcID(aggregate, proc) }
        proc = nil
        if aggregate != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggregate) }
        if tap != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tap) }
        aggregate = kAudioObjectUnknown; tap = kAudioObjectUnknown
    }

    /// Every process Core Audio knows about (each has opened audio at some point).
    static func processObjects() -> [AudioObjectID] {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        let system = AudioObjectID(kAudioObjectSystemObject)
        guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
        var list = [AudioObjectID](repeating: kAudioObjectUnknown, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &list) == noErr else { return [] }
        return list.filter { $0 != kAudioObjectUnknown }
    }

    static func pid(of object: AudioObjectID) -> pid_t? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyPID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var pid: pid_t = -1
        var size = UInt32(MemoryLayout<pid_t>.size)
        return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &pid) == noErr ? pid : nil
    }

    static func bundle(of object: AudioObjectID) -> String? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyBundleID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr, let value else { return nil }
        let text = value.takeRetainedValue() as String
        return text.isEmpty ? nil : text
    }

    /// The Core Audio object for a process, if it has ever opened audio.
    static func processObject(_ pid: pid_t) -> AudioObjectID? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var qualifier = pid, object = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address,
            UInt32(MemoryLayout<pid_t>.size), &qualifier, &size, &object)
        return status == noErr && object != kAudioObjectUnknown ? object : nil
    }
}

/// A bounded float ring: the newest audio wins when the reader falls behind.
final class SampleRing {
    private var storage: [Float]
    private var start = 0, count = 0
    private let lock = NSLock()
    init(capacity: Int) { storage = [Float](repeating: 0, count: capacity) }

    func write(_ samples: UnsafeBufferPointer<Float>) {
        lock.lock(); defer { lock.unlock() }
        for sample in samples {
            if count == storage.count { start = (start + 1) % storage.count; count -= 1 }
            storage[(start + count) % storage.count] = sample
            count += 1
        }
    }

    func read(_ wanted: Int) -> [Float] {
        lock.lock(); defer { lock.unlock() }
        var out = [Float](repeating: 0, count: wanted)
        let available = min(wanted, count)
        for index in 0..<available { out[index] = storage[(start + index) % storage.count] }
        start = (start + available) % storage.count
        count -= available
        return out
    }
}
