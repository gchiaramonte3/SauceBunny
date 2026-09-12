// SPDX-License-Identifier: GPL-2.0-or-later
// Exercise the actual module's SCStream delegate with synthetic errors. No
// capture source/SCStream is created and no permissions are requested/reset.
#include "engine.hpp"
#include "capture-health.hpp"
#include "mac-sck-common.h"
#include <cassert>
#include <dlfcn.h>
#include <cstdio>

// An idle SCStream notification is not a new picture. Exercise the actual
// module with a generated IOSurface so a missing geometry attachment cannot
// silently turn an unchanged source into a zero-sized raster.
static void checkFrameStatus(void *module) {
    using Update = void (*)(screen_capture *, CMSampleBufferRef);
    const auto update = reinterpret_cast<Update>(dlsym(module, "screen_stream_video_update"));
    assert(update);
    CVPixelBufferRef image = nullptr;
    NSDictionary *options = @{(id)kCVPixelBufferIOSurfacePropertiesKey: @{}};
    assert(CVPixelBufferCreate(kCFAllocatorDefault, 1200, 704, kCVPixelFormatType_32BGRA,
        (__bridge CFDictionaryRef)options, &image) == kCVReturnSuccess);
    CMVideoFormatDescriptionRef format = nullptr;
    assert(CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault, image, &format) == noErr);
    CMSampleTimingInfo timing = {CMTimeMake(1, 30), CMTimeMake(1, 1), kCMTimeInvalid};
    CMSampleBufferRef sample = nullptr;
    assert(CMSampleBufferCreateReadyWithImageBuffer(kCFAllocatorDefault, image, format, &timing, &sample) == noErr);
    auto attachments = CMSampleBufferGetSampleAttachmentsArray(sample, true);
    auto values = (CFMutableDictionaryRef)CFArrayGetValueAtIndex(attachments, 0);
    screen_capture state = {};
    state.capture_type = ScreenCaptureWindowStream;
    pthread_mutex_init(&state.mutex, nullptr);
    auto complete = [&] {
        CFDictionarySetValue(values, (__bridge CFStringRef)SCStreamFrameInfoStatus, (__bridge CFNumberRef)@(SCFrameStatusComplete));
        auto rect = CGRectCreateDictionaryRepresentation(CGRectMake(0, 0, 600, 352));
        CFDictionarySetValue(values, (__bridge CFStringRef)SCStreamFrameInfoContentRect, rect);
        CFRelease(rect);
        CFDictionarySetValue(values, (__bridge CFStringRef)SCStreamFrameInfoContentScale, (__bridge CFNumberRef)@1);
        CFDictionarySetValue(values, (__bridge CFStringRef)SCStreamFrameInfoScaleFactor, (__bridge CFNumberRef)@2);
    };
    complete(); update(&state, sample);
    assert(state.frame.size.width == 1200 && state.frame.size.height == 704 && state.current);
    const auto confirmed = state.current;
    for (const auto status : {SCFrameStatusIdle, SCFrameStatusStarted}) {
        CFDictionaryRemoveAllValues(values);
        CFDictionarySetValue(values, (__bridge CFStringRef)SCStreamFrameInfoStatus, (__bridge CFNumberRef)@(status));
        update(&state, sample);
        assert(state.frame.size.width == 1200 && state.frame.size.height == 704 && state.current == confirmed);
        assert(!state.sauce_capture_terminated);
    }
    complete(); update(&state, sample);
    assert(state.frame.size.width == 1200 && state.frame.size.height == 704);
    // A real new frame must still update the raster so the lifetime guard can
    // stop on resize; ignoring every callback is not a valid implementation.
    auto resized = CGRectCreateDictionaryRepresentation(CGRectMake(0, 0, 640, 360));
    CFDictionarySetValue(values, (__bridge CFStringRef)SCStreamFrameInfoContentRect, resized);
    CFRelease(resized); update(&state, sample);
    assert(state.frame.size.width == 1280 && state.frame.size.height == 720);
    for (const auto status : {SCFrameStatusBlank, SCFrameStatusSuspended, SCFrameStatusStopped}) {
        state.sauce_capture_terminated = false;
        CFDictionarySetValue(values, (__bridge CFStringRef)SCStreamFrameInfoStatus, (__bridge CFNumberRef)@(status));
        update(&state, sample);
        assert(state.sauce_capture_terminated);
    }
    IOSurfaceDecrementUseCount(state.current); CFRelease(state.current);
    pthread_mutex_destroy(&state.mutex);
    CFRelease(sample); CFRelease(format); CFRelease(image);
}

int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc != 2) return 2;
        const auto root = std::filesystem::canonical(argv[1]);
        sauce_obs::Engine engine;
        if (!engine.initialize(root, 1280, 720)) return 3;
        const auto binary = root / "PlugIns/sauce-obs-capture.plugin/Contents/MacOS/sauce-obs-capture";
        void *module = dlopen(binary.c_str(), RTLD_NOW | RTLD_NOLOAD);
        assert(module);
        checkFrameStatus(module);
        const auto health = reinterpret_cast<proc_handler_proc_t>(dlsym(module, "sauce_capture_health"));
        if (!health) { std::fputs("capture module lacks latched source health\n", stderr); dlclose(module); return 5; }

        assert(!sauce_obs::captureHealthy(nullptr));
        auto *empty = proc_handler_create();
        assert(!sauce_obs::captureHealthy(empty));
        proc_handler_add(empty, "void sauce_capture_health(out int version, out bool healthy)",
            [](void *, calldata_t *result) { calldata_set_bool(result, "healthy", true); }, nullptr);
        assert(!sauce_obs::captureHealthy(empty)); // Missing contract version.
        proc_handler_destroy(empty);

        for (const auto code : {SCStreamErrorUserStopped, SCStreamErrorNoCaptureSource, SCStreamErrorInternalError}) {
            obs_scene_t *scene = obs_scene_create_private("health-fixture");
            assert(scene);
            screen_capture state = {};
            state.source = obs_scene_get_source(scene);
            auto *procedures = obs_source_get_proc_handler(state.source);
            proc_handler_add(procedures, "void sauce_capture_health(out int version, out bool healthy)", health, &state);
            assert(sauce_obs::captureHealthy(procedures));
            ScreenCaptureDelegate *delegate = [NSClassFromString(@"ScreenCaptureDelegate") new];
            assert(delegate);
            delegate.sc = &state;
            // The delegate never reads its stream argument. Keep it nil for
            // this synthetic callback instead of constructing a real capture.
            SCStream *unusedStream = nil;
            [delegate stream:unusedStream didStopWithError:[NSError errorWithDomain:SCStreamErrorDomain code:code userInfo:nil]];
            assert(!sauce_obs::captureHealthy(procedures));
            // Upstream can clear its UI reactivation flag. Our source lifetime
            // remains failed: recovery requires a new explicitly selected source.
            state.capture_failed = false;
            assert(!sauce_obs::captureHealthy(procedures));
            delegate.sc = nullptr;
            [delegate stream:unusedStream didStopWithError:[NSError errorWithDomain:SCStreamErrorDomain code:code userInfo:nil]];
            obs_scene_release(scene);
        }
        dlclose(module);
        std::puts("Capture-health tests passed (synthetic delegate errors; no user capture)");
    }
}
