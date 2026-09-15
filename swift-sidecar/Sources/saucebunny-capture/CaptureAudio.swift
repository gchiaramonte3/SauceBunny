import AudioToolbox
import CoreMedia
import Foundation

// One second at the configured 48 kHz rate; malformed sample counts cannot
// produce an unbounded allocation or an unchecked planar-buffer read.
let captureAudioMaxFrames = 48_000

func interleavedCapturePCM(_ buffers: UnsafeMutableAudioBufferListPointer,
                          frames: Int, channels: Int, planar: Bool) -> Data? {
    guard (1...captureAudioMaxFrames).contains(frames), (1...2).contains(channels),
          buffers.count == (planar ? channels : 1) else { return nil }
    let bytesPerSample = MemoryLayout<Float32>.size
    let bytesPerBuffer = frames * bytesPerSample * (planar ? 1 : channels)
    for buffer in buffers {
        guard buffer.mNumberChannels == (planar ? 1 : UInt32(channels)),
              Int(buffer.mDataByteSize) == bytesPerBuffer, buffer.mData != nil else { return nil }
    }
    if !planar || channels == 1 {
        return Data(bytes: buffers[0].mData!, count: bytesPerBuffer)
    }
    var result = Data(count: frames * channels * bytesPerSample)
    result.withUnsafeMutableBytes { output in
        for frame in 0..<frames {
            for channel in 0..<channels {
                // Byte copies preserve Float32 bits without alignment assumptions.
                memcpy(output.baseAddress! + (frame * channels + channel) * bytesPerSample,
                       buffers[channel].mData! + frame * bytesPerSample, bytesPerSample)
            }
        }
    }
    return result
}

/// Copies bounded, ready 48 kHz Float32 mono/stereo into FIFO-ready interleaved
/// PCM. The retained block owns the AudioBufferList pointers until the copy ends.
func captureAudioPCM(_ sample: CMSampleBuffer) -> Data? {
    guard CMSampleBufferIsValid(sample), CMSampleBufferDataIsReady(sample),
          let format = CMSampleBufferGetFormatDescription(sample),
          let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
          asbd.mFormatID == kAudioFormatLinearPCM, asbd.mSampleRate == 48000,
          asbd.mBitsPerChannel == 32, asbd.mFramesPerPacket == 1,
          asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0,
          asbd.mFormatFlags & (kAudioFormatFlagIsBigEndian | kAudioFormatFlagIsSignedInteger) == 0,
          (1...2).contains(asbd.mChannelsPerFrame) else { return nil }
    let frames = CMSampleBufferGetNumSamples(sample)
    guard (1...captureAudioMaxFrames).contains(frames) else { return nil }
    let channels = Int(asbd.mChannelsPerFrame)
    let planar = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
    let frameBytes = UInt32(MemoryLayout<Float32>.size * (planar ? 1 : channels))
    guard asbd.mBytesPerFrame == frameBytes, asbd.mBytesPerPacket == frameBytes else { return nil }

    var required = 0
    let query = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample,
        bufferListSizeNeededOut: &required, bufferListOut: nil, bufferListSize: 0,
        blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
    let maximumListBytes = MemoryLayout<AudioBufferList>.size + MemoryLayout<AudioBuffer>.stride
    guard query == noErr, required >= MemoryLayout<AudioBufferList>.size,
          required <= maximumListBytes else { return nil }
    let storage = UnsafeMutableRawPointer.allocate(byteCount: required, alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { storage.deallocate() }
    let list = storage.bindMemory(to: AudioBufferList.self, capacity: 1)
    var block: CMBlockBuffer?
    let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample,
        bufferListSizeNeededOut: nil, bufferListOut: list, bufferListSize: required,
        blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: &block)
    guard status == noErr, block != nil else { return nil }
    return withExtendedLifetime(block) {
        interleavedCapturePCM(UnsafeMutableAudioBufferListPointer(list), frames: frames, channels: channels, planar: planar)
    }
}
