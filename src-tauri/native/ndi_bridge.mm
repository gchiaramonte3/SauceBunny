// Native-only NDI -> hardware H.264 + native AAC -> independently decodable fMP4.
// Build against the user's SDK. No vendor implementation or raw frame crosses IPC.
#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreImage/CoreImage.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <VideoToolbox/VideoToolbox.h>
#include <Processing.NDI.Lib.h>
#include <dlfcn.h>
#include <atomic>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using Emit = void (*)(void*, int, const uint8_t*, size_t);
using Stop = bool (*)(void*);
using TimingProbe = uint64_t (*)(void*);
static NSData* json(NSDictionary* value) { return [NSJSONSerialization dataWithJSONObject:value options:0 error:nil]; }
static NSString* str(const char* s) { return s ? [NSString stringWithUTF8String:s] ?: @"Invalid UTF-8" : @""; }
static void status(Emit emit, void* context, NSDictionary* value) {
    NSData* data = json(value); emit(context, 3, (const uint8_t*)data.bytes, data.length);
}

// Diagnostics copy at most 2 KiB while the frame is owned by framesync.
// Do not parse sender-controlled XML, follow URLs, or infer sequence timing.
static id timingMetadata(const char* bytes, bool& truncated, bool& invalidUtf8) {
    truncated = false; invalidUtf8 = false;
    if (!bytes) return [NSNull null];
    constexpr size_t limit = 2048;
    const size_t observed = strnlen(bytes, limit + 1);
    truncated = observed > limit;
    size_t length = std::min(observed, limit);
    NSString* value = [[NSString alloc] initWithBytes:bytes length:length encoding:NSUTF8StringEncoding];
    // A bounded copy may cut a valid multi-byte code point. Trim only the
    // incomplete suffix, not malformed bytes elsewhere in the observation.
    if (!value && truncated) for (size_t trim = 1; trim <= 3 && trim < length; trim++) {
        value = [[NSString alloc] initWithBytes:bytes length:length-trim encoding:NSUTF8StringEncoding];
        if (value) break;
    }
    invalidUtf8 = !value;
    return value ?: (id)[NSNull null];
}
static NSString* timingDecimal(int64_t value) { return [NSString stringWithFormat:@"%lld", (long long)value]; }

#ifdef SAUCE_NDI_TIMING_TESTS
// Linked only into the explicit synthetic harness, never the application.
extern "C" bool sauce_ndi_timing_helpers_test() {
    @autoreleasepool {
        bool truncated = false, invalid = false;
        id empty = timingMetadata(nullptr, truncated, invalid);
        if (empty != [NSNull null] || truncated || invalid) return false;
        const std::string longText = std::string(2047, 'x') + "\xf0\x9f\x98\x80";
        id bounded = timingMetadata(longText.c_str(), truncated, invalid);
        if (![bounded isKindOfClass:[NSString class]] || !truncated || invalid
            || [bounded lengthOfBytesUsingEncoding:NSUTF8StringEncoding] != 2047) return false;
        id malformed = timingMetadata("\xff", truncated, invalid);
        if (malformed != [NSNull null] || truncated || !invalid) return false;
        return [timingDecimal(INT64_MAX) isEqual:@"9223372036854775807"]
            && [timingDecimal(INT64_MIN) isEqual:@"-9223372036854775808"];
    }
}
#endif

struct RuntimeState {
    std::mutex lock;
    void* library = nullptr;
    const NDIlib_v6* api = nullptr;
    std::string path;
    unsigned users = 0;
};
static RuntimeState& runtimeState() { static RuntimeState state; return state; }
struct Runtime {
    const NDIlib_v6* api = nullptr;
    explicit Runtime(const char* path) {
        auto& shared = runtimeState();
        std::lock_guard<std::mutex> guard(shared.lock);
        if (shared.users && shared.path != path)
            throw std::runtime_error("Disconnect NDI inputs before changing the developer runtime");
        if (!shared.users) {
            void* library = dlopen(path, RTLD_NOW | RTLD_LOCAL);
            if (!library) throw std::runtime_error(dlerror() ?: "NDI runtime could not be loaded");
            auto load = (const NDIlib_v6* (*)())dlsym(library, "NDIlib_v6_load");
            const NDIlib_v6* loaded = load ? load() : nullptr;
            if (!loaded || !loaded->initialize()) {
                dlclose(library);
                throw std::runtime_error("NDI 6 runtime is incompatible or initialization failed");
            }
            shared.library = library; shared.api = loaded; shared.path = path;
        }
        ++shared.users; api = shared.api;
    }
    Runtime(const Runtime&) = delete;
    Runtime& operator=(const Runtime&) = delete;
    ~Runtime() {
        auto& shared = runtimeState();
        std::lock_guard<std::mutex> guard(shared.lock);
        // Finder, receiver, frame-sync and encoder guards have already
        // drained. Discovery finishing cannot destroy another receiver.
        if (--shared.users == 0) {
            shared.api->destroy(); dlclose(shared.library);
            shared.api = nullptr; shared.library = nullptr; shared.path.clear();
        }
    }
};
struct Finder {
    const NDIlib_v6* api;
    NDIlib_find_instance_t handle;
    explicit Finder(const NDIlib_v6* api): api(api), handle(api->find_create_v2(nullptr)) {
        if (!handle) throw std::runtime_error("NDI discovery could not start");
    }
    ~Finder() { api->find_destroy(handle); }
};

extern "C" char* sauce_ndi_query(const char* path, bool discover) {
    @autoreleasepool {
        @try { try {
            Runtime runtime(path);
            NSMutableArray* sources = [NSMutableArray array];
            if (discover) {
                Finder finder(runtime.api);
                // Acceptance gives a newly-enabled Mercury Transmit source up
                // to five seconds to appear. Return promptly when any source
                // is already available; an empty/denied scan alone pays the
                // full diagnostic window.
                const auto end = std::chrono::steady_clock::now() + std::chrono::seconds(5);
                uint32_t count = 0; const NDIlib_source_t* found = nullptr;
                do {
                    runtime.api->find_wait_for_sources(finder.handle, 200);
                    found = runtime.api->find_get_current_sources(finder.handle, &count);
                } while (count == 0 && std::chrono::steady_clock::now() < end);
                for (uint32_t i = 0; i < std::min(count, 256u); i++)
                    [sources addObject:@{ @"name":str(found[i].p_ndi_name) }];
            }
            NSData* data = json(@{ @"available":@YES, @"version":str(runtime.api->version()), @"sources":sources });
            return strndup((const char*)data.bytes, data.length);
        } catch (const std::exception& e) {
            NSData* data = json(@{ @"available":@NO, @"error":str(e.what()), @"sources":@[] });
            return strndup((const char*)data.bytes, data.length);
        }} @catch (NSException* e) {
            NSData* data = json(@{ @"available":@NO, @"error":e.reason ?: @"Native NDI error", @"sources":@[] });
            return strndup((const char*)data.bytes, data.length);
        }
    }
}
extern "C" void sauce_ndi_free(char* value) { free(value); }

@interface SegmentOutput : NSObject <AVAssetWriterDelegate>
@property(nonatomic, assign) Emit emit;
@property(nonatomic, assign) void* context;
@property(nonatomic, assign) uint64_t emittedBytes;
- (uint64_t)byteCount;
@end
@implementation SegmentOutput
- (void)assetWriter:(AVAssetWriter*)writer didOutputSegmentData:(NSData*)data segmentType:(AVAssetSegmentType)kind {
    @synchronized(self) {
        if (self.emit) {
            self.emittedBytes += data.length;
            self.emit(self.context, kind == AVAssetSegmentTypeInitialization ? 1 : 2,
                (const uint8_t*)data.bytes, data.length);
        }
    }
}
- (uint64_t)byteCount { @synchronized(self) { return self.emittedBytes; } }
@end

struct Encoder {
    AVAssetWriter* writer;
    AVAssetWriterInput* video;
    AVAssetWriterInput* audio;
    AVAssetWriterInputPixelBufferAdaptor* pixels;
    SegmentOutput* output;
    CIContext* ci;
    CMAudioFormatDescriptionRef audioFormat = nullptr;
    int width, height;
    uint64_t dropped = 0;
    uint64_t encodedFrames = 0, droppedAudioSamples = 0;
    Encoder(int inWidth, int inHeight, Emit emit, void* context) {
        const double scale = std::min(1.0, std::min(1920.0 / inWidth, 1080.0 / inHeight));
        width = std::max(2, (int)(inWidth * scale) & ~1);
        height = std::max(2, (int)(inHeight * scale) & ~1);
        writer = [[AVAssetWriter alloc] initWithContentType:UTTypeMPEG4Movie];
        writer.outputFileTypeProfile = AVFileTypeProfileMPEG4AppleHLS;
        // Editorial monitoring cannot wait half a second for every chunk.
        // Three-frame closed fragments keep both local and peer feeds near
        // the current picture without introducing a second encoder path.
        writer.preferredOutputSegmentInterval = CMTimeMake(1, 10);
        writer.initialSegmentStartTime = kCMTimeZero;
        output = [SegmentOutput new]; output.emit = emit; output.context = context; writer.delegate = output;
        NSDictionary* settings = @{
            AVVideoCodecKey:AVVideoCodecTypeH264, AVVideoWidthKey:@(width), AVVideoHeightKey:@(height),
            AVVideoEncoderSpecificationKey:@{ (__bridge NSString*)kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder:@YES },
            AVVideoCompressionPropertiesKey:@{
                AVVideoAverageBitRateKey:@6000000, AVVideoExpectedSourceFrameRateKey:@30,
                AVVideoMaxKeyFrameIntervalKey:@3, AVVideoMaxKeyFrameIntervalDurationKey:@0.1,
                AVVideoAllowFrameReorderingKey:@NO, AVVideoProfileLevelKey:AVVideoProfileLevelH264MainAutoLevel,
            }
        };
        video = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:settings];
        video.expectsMediaDataInRealTime = YES;
        pixels = [AVAssetWriterInputPixelBufferAdaptor assetWriterInputPixelBufferAdaptorWithAssetWriterInput:video
            sourcePixelBufferAttributes:@{ (NSString*)kCVPixelBufferPixelFormatTypeKey:@(kCVPixelFormatType_32BGRA),
              (NSString*)kCVPixelBufferWidthKey:@(width), (NSString*)kCVPixelBufferHeightKey:@(height),
              (NSString*)kCVPixelBufferIOSurfacePropertiesKey:@{} }];
        audio = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeAudio outputSettings:@{
            AVFormatIDKey:@(kAudioFormatMPEG4AAC), AVSampleRateKey:@48000, AVNumberOfChannelsKey:@2, AVEncoderBitRateKey:@192000 }];
        audio.expectsMediaDataInRealTime = YES;
        if (![writer canAddInput:video] || ![writer canAddInput:audio])
            throw std::runtime_error("Hardware H.264 video or AAC audio encoding is unavailable");
        [writer addInput:video]; [writer addInput:audio];
        ci = [CIContext contextWithOptions:@{ kCIContextCacheIntermediates:@NO }];
        AudioStreamBasicDescription format = {48000, kAudioFormatLinearPCM,
            kAudioFormatFlagsNativeFloatPacked, 8, 1, 8, 2, 32, 0};
        if (CMAudioFormatDescriptionCreate(kCFAllocatorDefault, &format, 0, nullptr, 0, nullptr, nullptr, &audioFormat))
            throw std::runtime_error("Cannot create stereo audio format");
        if (![writer startWriting]) {
            CFRelease(audioFormat); audioFormat = nullptr;
            @synchronized(output) { output.emit = nullptr; output.context = nullptr; }
            throw std::runtime_error(writer.error.localizedDescription.UTF8String ?: "Cannot start hardware encoder");
        }
        [writer startSessionAtSourceTime:kCMTimeZero];
    }
    ~Encoder() {
        // Drain an in-flight callback and prevent late AVFoundation callbacks
        // from touching a Rust context after sauce_ndi_run returns.
        @synchronized(output) { output.emit = nullptr; output.context = nullptr; }
        [writer cancelWriting]; if (audioFormat) CFRelease(audioFormat);
    }
    bool frame(const NDIlib_video_frame_v2_t& frame, const NDIlib_audio_frame_v2_t& samples, int64_t tick) {
        const CMTime pts = CMTimeMake(tick, 30);
        if (video.readyForMoreMediaData) {
            CVPixelBufferRef input = nullptr, dest = nullptr;
            if (CVPixelBufferCreateWithBytes(kCFAllocatorDefault, frame.xres, frame.yres, kCVPixelFormatType_32BGRA,
                frame.p_data, frame.line_stride_in_bytes ?: frame.xres * 4, nullptr, nullptr, nullptr, &input) == kCVReturnSuccess) {
                if (CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pixels.pixelBufferPool, &dest) == kCVReturnSuccess) {
                    CIImage* picture = [CIImage imageWithCVPixelBuffer:input];
                    // NDI BGRX's unused byte is not alpha. Treat program
                    // picture as opaque for either negotiated BGRA format.
                    picture = [picture imageByApplyingFilter:@"CIColorMatrix" withInputParameters:@{
                        @"inputAVector":[CIVector vectorWithX:0 Y:0 Z:0 W:0],
                        @"inputBiasVector":[CIVector vectorWithX:0 Y:0 Z:0 W:1] }];
                    const double scale = std::min((double)width / frame.xres, (double)height / frame.yres);
                    picture = [picture imageByApplyingTransform:CGAffineTransformMakeScale(scale, scale)];
                    picture = [picture imageByApplyingTransform:CGAffineTransformMakeTranslation((width-frame.xres*scale)/2, (height-frame.yres*scale)/2)];
                    picture = [picture imageByCompositingOverImage:[[CIImage imageWithColor:[CIColor blackColor]] imageByCroppingToRect:CGRectMake(0,0,width,height)]];
                    [ci render:picture toCVPixelBuffer:dest];
                    if (![pixels appendPixelBuffer:dest withPresentationTime:pts]) dropped++;
                    else encodedFrames++;
                    CVPixelBufferRelease(dest);
                } else dropped++;
                CVPixelBufferRelease(input);
            } else dropped++;
        } else dropped++;
        if (audio.readyForMoreMediaData) {
            // Framesync supplies planar 48k stereo. Interleave natively; never pass PCM through JS.
            std::vector<float> stereo(1600 * 2, 0);
            if (samples.p_data && samples.no_channels >= 2 && samples.no_samples == 1600) {
                const float* right = (const float*)((const uint8_t*)samples.p_data + samples.channel_stride_in_bytes);
                for (int i = 0; i < 1600; i++) { stereo[i*2] = samples.p_data[i]; stereo[i*2+1] = right[i]; }
            }
            CMBlockBufferRef block = nullptr;
            CMSampleBufferRef buffer = nullptr;
            size_t bytes = stereo.size() * sizeof(float);
            if (CMBlockBufferCreateWithMemoryBlock(kCFAllocatorDefault, nullptr, bytes, kCFAllocatorDefault, nullptr, 0, bytes, 0, &block) == noErr) {
                CMBlockBufferReplaceDataBytes(stereo.data(), block, 0, bytes);
                CMSampleTimingInfo timing = { CMTimeMake(1,48000), pts, kCMTimeInvalid };
                const size_t sampleSize = 8;
                if (CMSampleBufferCreateReady(kCFAllocatorDefault, block, audioFormat, 1600, 1, &timing, 1, &sampleSize, &buffer) == noErr) {
                    if (![audio appendSampleBuffer:buffer]) droppedAudioSamples += 1600;
                    CFRelease(buffer);
                } else droppedAudioSamples += 1600;
                CFRelease(block);
            } else droppedAudioSamples += 1600;
        } else droppedAudioSamples += 1600;
        return writer.status != AVAssetWriterStatusFailed;
    }
};

extern "C" void sauce_ndi_run_with_timing(const char* path, const char* selected, void* context, Emit emit, Stop stop, TimingProbe timingProbe) {
    @autoreleasepool { @try { try {
        Runtime runtime(path);
        Finder finder(runtime.api);
        std::string name, address;
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
        while (!stop(context) && std::chrono::steady_clock::now() < deadline) {
            runtime.api->find_wait_for_sources(finder.handle, 200);
            uint32_t count = 0; const auto* found = runtime.api->find_get_current_sources(finder.handle, &count);
            for (uint32_t i = 0; i < count; i++) if (found[i].p_ndi_name && strcmp(found[i].p_ndi_name, selected) == 0) {
                name = found[i].p_ndi_name; address = found[i].p_url_address ?: ""; break;
            }
            if (!name.empty()) break;
        }
        if (stop(context)) return;
        if (name.empty()) throw std::runtime_error("Selected NDI source is no longer discoverable. Check Premiere Mercury Transmit and Local Network permission.");
        NDIlib_recv_create_v3_t config;
        config.source_to_connect_to.p_ndi_name = name.c_str(); config.source_to_connect_to.p_url_address = address.c_str();
        config.color_format = NDIlib_recv_color_format_BGRX_BGRA;
        config.bandwidth = NDIlib_recv_bandwidth_highest;
        config.allow_video_fields = false; config.p_ndi_recv_name = "Sauce Bunny experimental program input";
        auto receiver = runtime.api->recv_create_v3(&config);
        if (!receiver) throw std::runtime_error("NDI receiver could not start");
        struct ReceiverGuard { const NDIlib_v6* api; NDIlib_recv_instance_t r; ~ReceiverGuard(){api->recv_destroy(r);} } receiverGuard{runtime.api, receiver};
        auto sync = runtime.api->framesync_create(receiver);
        if (!sync) throw std::runtime_error("NDI frame synchronizer could not start");
        struct SyncGuard { const NDIlib_v6* api; NDIlib_framesync_instance_t s; ~SyncGuard(){api->framesync_destroy(s);} } syncGuard{runtime.api, sync};
        std::unique_ptr<Encoder> encoder;
        auto clock = std::chrono::steady_clock::now(), fresh = clock, report = clock;
        int64_t tick = 0, previousReceived = 0;
        int inputWidth = 0, inputHeight = 0;
        uint64_t previousEncodedBytes = 0;
        uint64_t previousEncodedFrames = 0;
        double inputFps = 0;
        double leftPeak = 0, rightPeak = 0;
        uint64_t previousProbe = 0;
        int64_t previousTimecode = 0, previousTimestamp = 0;
        bool previousTimingValid = false;
        while (!stop(context)) { @autoreleasepool {
            NDIlib_video_frame_v2_t frame{};
            NDIlib_audio_frame_v2_t samples{};
            runtime.api->framesync_capture_video(sync, &frame, NDIlib_frame_format_type_progressive);
            runtime.api->framesync_capture_audio(sync, &samples, 48000, 2, 1600);
            struct FramesGuard { const NDIlib_v6* api; NDIlib_framesync_instance_t s; NDIlib_video_frame_v2_t* v; NDIlib_audio_frame_v2_t* a;
                ~FramesGuard(){api->framesync_free_video(s,v);api->framesync_free_audio(s,a);} } frames{runtime.api,sync,&frame,&samples};
            NDIlib_recv_performance_t total{}, dropped{};
            runtime.api->recv_get_performance(receiver, &total, &dropped);
            const auto now = std::chrono::steady_clock::now();
            if (total.video_frames != previousReceived) { previousReceived = total.video_frames; fresh = now; }
            const bool stale = now - fresh > std::chrono::seconds(2);
            const bool validInput = frame.p_data && frame.xres > 0 && frame.xres <= 8192 && frame.yres > 0 && frame.yres <= 8192
                && (frame.FourCC == NDIlib_FourCC_video_type_BGRA || frame.FourCC == NDIlib_FourCC_video_type_BGRX);
            bool attemptedOutput = false;
            const uint64_t framesBefore = encoder ? encoder->encodedFrames : 0;
            if (validInput) {
                inputWidth = frame.xres; inputHeight = frame.yres;
                inputFps = frame.frame_rate_D > 0 ? (double)frame.frame_rate_N / frame.frame_rate_D : 0;
                // Premiere can send an 8x8 blank frame before a sequence has
                // picture (observed in Mercury Transmit 26.3.2). Do not lock
                // the entire session's fixed encoder raster to that sentinel.
                // Once initialized, small/black frames remain legitimate
                // picture and audio, scaled into the established output.
                if (!encoder && frame.xres >= 16 && frame.yres >= 16) {
                    encoder = std::make_unique<Encoder>(frame.xres,frame.yres,emit,context); tick = 0; clock = now;
                }
                attemptedOutput = encoder != nullptr;
                if (encoder && !encoder->frame(frame, samples, tick)) throw std::runtime_error(encoder->writer.error.localizedDescription.UTF8String ?: "Encoder stopped");
            }
            const uint64_t probe = timingProbe ? timingProbe(context) : 0;
            if (probe) {
                // An allocation/serialization failure in an optional probe
                // must not fail the receiver or its program audio/video.
                @try { try {
                    bool truncated = false, invalidUtf8 = false;
                    id metadata = validInput ? timingMetadata(frame.p_metadata, truncated, invalidUtf8) : [NSNull null];
                    const bool sameTiming = previousProbe == probe && previousTimingValid && validInput
                        && previousTimecode == frame.timecode && previousTimestamp == frame.timestamp;
                    const uint64_t age = std::chrono::duration_cast<std::chrono::milliseconds>(now-fresh).count();
                    NSData* data = json(@{
                        @"probeId":[NSString stringWithFormat:@"%llu", (unsigned long long)probe],
                        @"outputTick":attemptedOutput ? timingDecimal(tick) : (id)[NSNull null],
                        @"outputTimescale":@30, @"outputAccepted":@(encoder && encoder->encodedFrames > framesBefore),
                        @"inputValid":@(validInput), @"inputWidth":@(validInput ? frame.xres : 0), @"inputHeight":@(validInput ? frame.yres : 0),
                        @"inputRateN":@(validInput ? std::max(0, frame.frame_rate_N) : 0),
                        @"inputRateD":@(validInput ? std::max(0, frame.frame_rate_D) : 0),
                        @"ndiTimecode":validInput ? timingDecimal(frame.timecode) : (id)[NSNull null],
                        @"ndiTimestamp":validInput ? timingDecimal(frame.timestamp) : (id)[NSNull null],
                        @"metadata":metadata, @"metadataTruncated":@(truncated), @"metadataInvalidUtf8":@(invalidUtf8),
                        @"sameTimingAsPreviousCapture":@(sameTiming), @"receivedFrames":timingDecimal(std::max<int64_t>(0,total.video_frames)),
                        @"ndiDroppedFrames":timingDecimal(std::max<int64_t>(0,dropped.video_frames)),
                        @"encoderDroppedFrames":[NSString stringWithFormat:@"%llu", (unsigned long long)(encoder ? encoder->dropped : 0)],
                        @"lastInputAgeMs":@(std::min<uint64_t>(age, UINT32_MAX)), @"stale":@(stale)
                    });
                    if (data) emit(context, 4, (const uint8_t*)data.bytes, data.length);
                } catch (...) {}} @catch (NSException*) {}
            }
            previousProbe = probe; previousTimingValid = validInput && probe;
            if (previousTimingValid) { previousTimecode = frame.timecode; previousTimestamp = frame.timestamp; }
            if (samples.p_data && samples.no_channels >= 2) {
                const float* right = (const float*)((const uint8_t*)samples.p_data + samples.channel_stride_in_bytes);
                for (int i=0;i<samples.no_samples;i++) { leftPeak = std::max(leftPeak,(double)fabsf(samples.p_data[i])); rightPeak = std::max(rightPeak,(double)fabsf(right[i])); }
            }
            if (now-report >= std::chrono::seconds(1)) {
                const double reportSeconds = std::chrono::duration<double>(now-report).count();
                const uint64_t encodedBytes = encoder ? [encoder->output byteCount] : 0;
                const uint64_t bitrateKbps = reportSeconds > 0
                    ? (uint64_t)((encodedBytes-previousEncodedBytes)*8.0/reportSeconds/1000.0) : 0;
                const uint64_t inputAgeMs = (uint64_t)std::chrono::duration_cast<std::chrono::milliseconds>(now-fresh).count();
                const uint64_t encodedFrames = encoder ? encoder->encodedFrames : 0;
                const double outputFps = reportSeconds > 0 ? (encodedFrames - previousEncodedFrames) / reportSeconds : 0;
                const int connections = runtime.api->recv_get_no_connections(receiver);
                status(emit, context, @{ @"phase":encoder ? (stale ? @"stale" : @"live") : @"connecting",
                    @"inputWidth":@(inputWidth), @"inputHeight":@(inputHeight), @"outputFps":@(outputFps),
                    @"inputFps":inputFps > 0 ? @(inputFps) : [NSNull null], @"connectionCount":@(std::max(0,connections)),
                    @"receivedFrames":@(total.video_frames), @"ndiDroppedFrames":@(dropped.video_frames),
                    @"encoderDroppedFrames":@(encoder ? encoder->dropped : 0), @"lastInputAgeMs":@(inputAgeMs),
                    @"encoderDroppedAudioSamples":@(encoder ? encoder->droppedAudioSamples : 0),
                    @"encodedBitrateKbps":@(bitrateKbps),
                    @"leftPeak":@(std::isfinite(leftPeak) ? std::min(1.0,leftPeak) : 0), @"rightPeak":@(std::isfinite(rightPeak) ? std::min(1.0,rightPeak) : 0),
                    @"hardwareEncoder":@YES, @"timingVerified":@NO });
                report = now; previousEncodedBytes = encodedBytes; previousEncodedFrames = encodedFrames; leftPeak = rightPeak = 0;
            }
            tick++;
            std::this_thread::sleep_until(clock + std::chrono::nanoseconds(tick * 1000000000LL / 30));
            // Never try to encode a backlog after a stalled encoder/OS suspension.
            if (std::chrono::steady_clock::now() - clock > std::chrono::nanoseconds((tick+2)*1000000000LL/30))
                tick = std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now()-clock).count()*30/1000000000LL;
        }}
    } catch (const std::exception& e) { status(emit,context,@{ @"phase":@"error", @"error":str(e.what()) }); }
    } @catch (NSException* e) { status(emit,context,@{ @"phase":@"error", @"error":e.reason ?: @"Native encoder exception" }); }}
}

// Existing synthetic harnesses and callers remain probe-free by default.
extern "C" void sauce_ndi_run(const char* path, const char* selected, void* context, Emit emit, Stop stop) {
    sauce_ndi_run_with_timing(path, selected, context, emit, stop, nullptr);
}
