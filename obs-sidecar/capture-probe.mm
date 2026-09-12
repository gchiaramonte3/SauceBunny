// SPDX-License-Identifier: GPL-2.0-or-later
// Finite exact-window capture proof; not a release sidecar or NDI broadcaster.
#import <AppKit/AppKit.h>
#include "window-discovery.hpp"
#include "proof-output.hpp"
#include "capture-health.hpp"
#ifdef SAUCE_OBS_SUPERVISED
#include "owner-watchdog.hpp"
#endif
#include <charconv>
#include <chrono>
#include <cstring>
#include <cstdio>

namespace {
bool positiveInteger(const char *text, uint32_t &value) {
    const auto end = text + std::strlen(text);
    const auto parsed = std::from_chars(text, end, value);
    return parsed.ec == std::errc() && parsed.ptr == end && value > 0;
}
bool stillTheSameWindow(const sauce_obs::WindowIdentity &expected) {
    auto *application = [NSRunningApplication runningApplicationWithProcessIdentifier:expected.process];
    if (!application || !application.bundleIdentifier ||
        expected.application != application.bundleIdentifier.UTF8String) return false;
    NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, expected.window));
    if (windows.count != 1) return false;
    NSDictionary *window = windows.firstObject;
    return [window[(id)kCGWindowNumber] unsignedIntValue] == expected.window &&
           [window[(id)kCGWindowOwnerPID] intValue] == expected.process &&
           [window[(id)kCGWindowIsOnscreen] boolValue];
}
}
int main(int argc, char **argv) {
    @autoreleasepool {
#ifdef SAUCE_OBS_SUPERVISED
        sauce_obs::OwnerWatchdog owner;
        const auto shouldStop = [&] { return owner.stopping(); };
        const std::optional<double> duration = std::nullopt;
#else
        const auto shouldStop = [] { return false; };
        const std::optional<double> duration = 8.0;
#endif
        if (argc != 5 && argc != 9) {
            std::fputs("usage: saucebunny-obs-capture-probe <runtime> <bundle-id> <pid> <window-id> [crop-x crop-y crop-width crop-height]\n", stderr);
            return 2;
        }
        uint32_t pid = 0, id = 0;
        if (!positiveInteger(argv[3], pid) || pid > INT32_MAX || !positiveInteger(argv[4], id)) return 2;
        const auto crop = argc == 9 ? sauce_obs::parseCrop({argv[5], argv[6], argv[7], argv[8]})
                                    : std::optional<sauce_obs::Crop>(sauce_obs::Crop{});
        if (!crop) return 2;
        const sauce_obs::WindowIdentity requested{id, static_cast<int32_t>(pid), argv[2]};
        const auto available = sauce_obs::windowsForApplication(requested.application);
        if (!available.error.empty()) { std::fprintf(stderr, "%s\n", available.error.c_str()); return 4; }
        unsigned matches = 0;
        for (const auto &window : available.windows) if (sauce_obs::sameWindow(requested, window.identity)) matches++;
        if (matches != 1 || shouldStop()) { std::fputs("selected_window_unavailable\n", stderr); return 4; }
        std::error_code error;
        const auto root = std::filesystem::canonical(argv[1], error);
        if (error) return 2;
        sauce_obs::Engine engine;
        if (!engine.initialize(root, 1280, 720)) {
            std::fprintf(stderr, "%s\n", engine.error().c_str()); return 3;
        }
        obs_data_t *settings = obs_data_create();
        obs_data_set_int(settings, "type", 1); // OBS window capture; never desktop.
        obs_data_set_int(settings, "window", id);
        obs_data_set_bool(settings, "show_cursor", false);
        obs_data_set_bool(settings, "show_hidden_windows", false);
        obs_source_t *source = obs_source_create_private("screen_capture", "selected-window", settings);
        obs_data_release(settings);
        if (!source) return 4;
        auto *health = obs_source_get_proc_handler(source);
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
        while (!shouldStop() && sauce_obs::captureHealthy(health) && obs_source_get_width(source) == 0 &&
               std::chrono::steady_clock::now() < deadline)
            sauce_obs::pumpEvents(0.01);
        if (!sauce_obs::captureHealthy(health)) {
            obs_source_release(source); std::fputs("selected_capture_stopped\n", stderr); return 4;
        }
        const auto sourceWidth = obs_source_get_width(source), sourceHeight = obs_source_get_height(source);
        if (sourceWidth == 0 || sourceHeight == 0 || !stillTheSameWindow(requested)) {
            obs_source_release(source); std::fputs("selected_window_no_frame\n", stderr); return 4;
        }
        const auto raster = sauce_obs::captureRaster(sourceWidth, sourceHeight, *crop);
        if (!raster || !engine.resizeOutput(raster->width, raster->height)) {
            obs_source_release(source); std::fputs("selected_crop_invalid\n", stderr); return 4;
        }
        const int result = sauce_obs::writeProgram(source, *raster, [&] {
            if (!sauce_obs::captureHealthy(health)) {
                std::fputs("selected_capture_stopped\n", stderr); return false;
            }
            return stillTheSameWindow(requested) && obs_source_get_width(source) == sourceWidth &&
                obs_source_get_height(source) == sourceHeight && CGPreflightScreenCaptureAccess();
        }, shouldStop, duration);
        obs_source_release(source);
        return result;
    }
}
