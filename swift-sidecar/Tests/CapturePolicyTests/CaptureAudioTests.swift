import AVFoundation
import CoreMedia
import Foundation

// Generated PCM/CMSampleBuffer fixtures only. No devices, capture or playback.
func audioSample(channels: AVAudioChannelCount, interleaved: Bool, frames: AVAudioFrameCount = 4,
                 sampleRate: Double = 48000, commonFormat: AVAudioCommonFormat = .pcmFormatFloat32) -> CMSampleBuffer {
    let format = AVAudioFormat(commonFormat: commonFormat, sampleRate: sampleRate,
                               channels: channels, interleaved: interleaved)!
    let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
    pcm.frameLength = frames
    if commonFormat == .pcmFormatFloat32 {
        for channel in 0..<Int(channels) {
            for frame in 0..<Int(frames) {
                let value = Float(frame + 1) / 10 + Float(channel) / 2
                if interleaved { pcm.floatChannelData![0][frame * Int(channels) + channel] = value }
                else { pcm.floatChannelData![channel][frame] = value }
            }
        }
    } else {
        for buffer in UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList) {
            memset(buffer.mData!, 0, Int(buffer.mDataByteSize))
        }
    }
    var description: CMAudioFormatDescription?
    precondition(CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: format.streamDescription,
        layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil,
        formatDescriptionOut: &description) == noErr)
    var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: CMTimeScale(sampleRate)),
                                   presentationTimeStamp: .zero, decodeTimeStamp: .invalid)
    var sample: CMSampleBuffer?
    precondition(CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false,
        makeDataReadyCallback: nil, refcon: nil, formatDescription: description, sampleCount: Int(frames),
        sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 0,
        sampleSizeArray: nil, sampleBufferOut: &sample) == noErr)
    let dataStatus = CMSampleBufferSetDataBufferFromAudioBufferList(sample!, blockBufferAllocator: kCFAllocatorDefault,
        blockBufferMemoryAllocator: kCFAllocatorDefault, flags: 0, bufferList: pcm.audioBufferList)
    precondition(dataStatus == noErr, "Generated audio fixture failed: \(channels) channels, interleaved \(interleaved), \(frames) frames, \(sampleRate) Hz, status \(dataStatus)")
    precondition(CMSampleBufferSetDataReady(sample!) == noErr)
    return sample!
}

@main struct CaptureAudioTests {
    static func expectedPCM(channels: Int, frames: Int = 4) -> Data {
        var values: [Float32] = []
        for frame in 0..<frames {
            for channel in 0..<channels { values.append(Float(frame + 1) / 10 + Float(channel) / 2) }
        }
        return values.withUnsafeBytes { Data($0) }
    }

    static func rejectsMalformedLists() {
        let list = AudioBufferList.allocate(maximumBuffers: 2)
        defer { list.unsafeMutablePointer.deallocate() }
        var left: [Float32] = [0.1, 0.2, 0.3, 0.4]
        var right: [Float32] = [0.6, 0.7, 0.8, 0.9]
        left.withUnsafeMutableBytes { l in
            right.withUnsafeMutableBytes { r in
                list[0] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(l.count), mData: l.baseAddress)
                list[1] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(r.count), mData: r.baseAddress)
                precondition(interleavedCapturePCM(list, frames: 4, channels: 2, planar: true) != nil)
                for frames in [0, -1, captureAudioMaxFrames + 1, Int.max] {
                    precondition(interleavedCapturePCM(list, frames: frames, channels: 2, planar: true) == nil)
                }
                for channels in [0, 3, Int.max] {
                    precondition(interleavedCapturePCM(list, frames: 4, channels: channels, planar: true) == nil)
                }
                for bytes in [UInt32(0), 12, 15, 20, .max] {
                    list[1].mDataByteSize = bytes
                    precondition(interleavedCapturePCM(list, frames: 4, channels: 2, planar: true) == nil)
                }
                list[1].mDataByteSize = UInt32(r.count)
                list[1].mNumberChannels = 2
                precondition(interleavedCapturePCM(list, frames: 4, channels: 2, planar: true) == nil)
                list[1].mNumberChannels = 1; list[1].mData = nil
                precondition(interleavedCapturePCM(list, frames: 4, channels: 2, planar: true) == nil)
                list[1].mData = r.baseAddress
                list.unsafeMutablePointer.pointee.mNumberBuffers = 1
                precondition(interleavedCapturePCM(list, frames: 4, channels: 2, planar: true) == nil)
                list.unsafeMutablePointer.pointee.mNumberBuffers = 2
                precondition(interleavedCapturePCM(list, frames: 4, channels: 2, planar: false) == nil)
            }
        }
    }

    static func main() {
        let sample = audioSample(channels: 2, interleaved: false)
        var fixed = AudioBufferList()
        var required = 0
        var block: CMBlockBuffer?
        let oldStatus = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample,
            bufferListSizeNeededOut: &required, bufferListOut: &fixed,
            bufferListSize: MemoryLayout<AudioBufferList>.size, blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: &block)
        precondition(oldStatus == kCMSampleBufferError_ArrayTooSmall && required > MemoryLayout<AudioBufferList>.size)
        print("Generated planar stereo reproduces fixed AudioBufferList rejection: status \(oldStatus), requires \(required) bytes, fixed capacity \(MemoryLayout<AudioBufferList>.size).")
        precondition(captureAudioPCM(sample) == expectedPCM(channels: 2))
        precondition(captureAudioPCM(audioSample(channels: 2, interleaved: true)) == expectedPCM(channels: 2))
        for interleaved in [true, false] {
            precondition(captureAudioPCM(audioSample(channels: 1, interleaved: interleaved)) == expectedPCM(channels: 1))
        }
        for frames: AVAudioFrameCount in [1, 1024, AVAudioFrameCount(captureAudioMaxFrames)] {
            precondition(captureAudioPCM(audioSample(channels: 2, interleaved: false, frames: frames)) == expectedPCM(channels: 2, frames: Int(frames)))
        }
        precondition(captureAudioPCM(audioSample(channels: 2, interleaved: false, frames: AVAudioFrameCount(captureAudioMaxFrames + 1))) == nil)
        precondition(captureAudioPCM(audioSample(channels: 2, interleaved: false, sampleRate: 44100)) == nil)
        for format: AVAudioCommonFormat in [.pcmFormatInt16, .pcmFormatInt32, .pcmFormatFloat64] {
            precondition(captureAudioPCM(audioSample(channels: 2, interleaved: false, commonFormat: format)) == nil)
        }
        let invalidated = audioSample(channels: 2, interleaved: false)
        let retainedCopy = captureAudioPCM(invalidated)
        precondition(CMSampleBufferInvalidate(invalidated) == noErr)
        precondition(captureAudioPCM(invalidated) == nil)
        precondition(retainedCopy == expectedPCM(channels: 2))
        rejectsMalformedLists()
        print("Generated planar/interleaved stereo, mono, retained-copy and malformed-buffer tests passed; no capture or playback.")
    }
}
