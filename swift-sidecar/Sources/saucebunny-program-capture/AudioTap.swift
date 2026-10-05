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

    /// Every process playing sound except `excluded` (our own playback stays out).
    init(excludingProcesses excluded: [pid_t]) throws {
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: excluded.compactMap(AudioTap.processObject))
        try start(description)
    }

    /// Only these processes (one application and its helpers).
    init(includingProcesses included: [pid_t]) throws {
        let description = CATapDescription(stereoMixdownOfProcesses: included.compactMap(AudioTap.processObject))
        try start(description)
    }

    private func start(_ description: CATapDescription) throws {
        description.uuid = UUID()
        description.name = "Sauce Bunny Preview source"
        description.isPrivate = true
        description.muteBehavior = .unmuted
        guard AudioHardwareCreateProcessTap(description, &tap) == noErr else { throw CaptureError.code("start_audio_tap_failed") }
        var format = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &format) == noErr,
              let input = AVAudioFormat(streamDescription: &format) else { stop(); throw CaptureError.code("start_audio_tap_failed") }
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
        guard AudioHardwareCreateAggregateDevice(device as CFDictionary, &aggregate) == noErr else { stop(); throw CaptureError.code("start_audio_tap_failed") }
        let status = AudioDeviceCreateIOProcIDWithBlock(&proc, aggregate, queue) { [weak self] _, inputData, _, _, _ in
            self?.receive(inputData, format: input)
        }
        guard status == noErr, let proc, AudioDeviceStart(aggregate, proc) == noErr else { stop(); throw CaptureError.code("start_audio_tap_failed") }
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
        if let proc { AudioDeviceStop(aggregate, proc); AudioDeviceDestroyIOProcID(aggregate, proc) }
        proc = nil
        if aggregate != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggregate) }
        if tap != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tap) }
        aggregate = kAudioObjectUnknown; tap = kAudioObjectUnknown
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
