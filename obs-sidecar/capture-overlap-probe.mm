// SPDX-License-Identifier: GPL-2.0-or-later
// Finite diagnostic: two exact GENERATED windows, one OBS engine, two isolated outputs.
#import <AppKit/AppKit.h>
#include "proof-output.hpp"
#include "capture-health.hpp"
#include "capture-config.hpp"
#include "window-discovery.hpp"
#include <charconv>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <string>

static double now() {
    return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
}
static bool positiveInteger(const char *text, uint32_t &value) {
    const auto end = text + std::strlen(text);
    const auto parsed = std::from_chars(text, end, value);
    return parsed.ec == std::errc() && parsed.ptr == end && value > 0;
}
struct Program {
    obs_source_t *source = nullptr;
    sauce_obs::ProgramOutput output;
    bool active = false;
    sauce_obs::WindowIdentity identity{};
    unsigned width = 0, height = 0, slot = 0;
    bool failed = false;
    double began = 0;
    bool healthy() const {
        if (!source || !sauce_obs::captureHealthy(obs_source_get_proc_handler(source))) return false;
        auto *app = [NSRunningApplication runningApplicationWithProcessIdentifier:identity.process];
        if (!app.bundleIdentifier || identity.application != app.bundleIdentifier.UTF8String) return false;
        NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, identity.window));
        return windows.count == 1 && [windows.firstObject[(id)kCGWindowIsOnscreen] boolValue] &&
            obs_source_get_width(source) == width && obs_source_get_height(source) == height &&
            CGPreflightScreenCaptureAccess();
    }
    void report(const char *event) {
        std::fprintf(stderr, "{\"event\":\"%s\",\"slot\":%u,\"time\":%.6f,\"frames\":%u,\"healthy\":%s,\"code\":%d}\n",
            event, slot, now(), output.frames(), healthy() ? "true" : "false", output.code());
    }
    bool start(sauce_obs::WindowIdentity selected, unsigned index) {
        identity = selected; slot = index;
        const std::string name = "isolated-" + std::to_string(index);
        obs_data_t *settings = obs_data_create();
        obs_data_set_int(settings, "type", 1);
        obs_data_set_int(settings, "window", identity.window);
        obs_data_set_bool(settings, "show_cursor", false);
        obs_data_set_bool(settings, "show_hidden_windows", false);
        source = obs_source_create_private("screen_capture", name.c_str(), settings);
        obs_data_release(settings);
        if (!source) return false;
        const double deadline = now() + 3;
        while (obs_source_get_width(source) == 0 && now() < deadline) sauce_obs::pumpEvents(.01);
        width = obs_source_get_width(source); height = obs_source_get_height(source);
        if (!healthy() || width == 0 || height == 0) return false;
        auto raster = sauce_obs::captureRaster(width, height, sauce_obs::Crop{});
        if (!raster || !output.prepare(source, *raster, slot, static_cast<int>(3 + slot))) return false;
        sauce_obs::pumpEvents(.5);
        if (!healthy() || !output.start()) return false;
        active = true;
        began = now();
        report("started");
        return true;
    }
    void stop() {
        if (active) failed = failed || !healthy();
        output.stop();
        if (active) {
            report("stopped");
            failed = failed || !output.started() || !output.stopped() || output.code() != 0;
        }
        active = false;
        if (source) { obs_source_release(source); source = nullptr; }
        obs_wait_for_destroy_queue();
    }
    ~Program() { stop(); }
};

int main(int argc, char **argv) {
    if (argc != 8) return 2;
    @autoreleasepool {
        sauce_obs::WindowIdentity selected[2];
        for (unsigned n = 0; n < 2; n++) {
            uint32_t window = 0, pid = 0;
            if (!positiveInteger(argv[4+n*3], window) || !positiveInteger(argv[3+n*3], pid) || pid > INT32_MAX) return 2;
            selected[n] = {window, static_cast<int32_t>(pid), argv[2+n*3]};
            if (selected[n].application.rfind("com.saucebunny.capture-test-", 0) != 0) return 2;
            const auto discovery = sauce_obs::windowsForApplication(selected[n].application);
            unsigned matches = 0;
            for (const auto &window : discovery.windows) if (sauce_obs::sameWindow(selected[n], window.identity)) matches++;
            if (!discovery.error.empty() || matches != 1) return 4;
        }
        sauce_obs::Engine engine;
        if (!engine.initialize(argv[1], 1280, 720)) return 3;
        Program a, b;
        if (!a.start(selected[0], 0)) return 5;
        // An occupied audio mix or invalid slot must fail before changing any source routing.
        const auto firstRaster = sauce_obs::captureRaster(a.width, a.height, sauce_obs::Crop{});
        sauce_obs::ProgramOutput duplicate, invalid;
        if (!firstRaster || duplicate.prepare(a.source, *firstRaster, 0, 3) ||
            invalid.prepare(a.source, *firstRaster, 2, 3)) return 6;
        bool secondStarted = false, firstStopped = false;
        double nextReport = 0;
        while (now() - a.began < 12) {
            if (!secondStarted && now() - a.began > 2) {
                secondStarted = b.start(selected[1], 1);
                if (!secondStarted) return 5;
            }
            if (!firstStopped && now() - a.began > 7) {
                a.stop(); firstStopped = true;
            }
            if ((a.active && !a.healthy()) || (b.active && !b.healthy())) {
                a.report("health-failure"); b.report("health-failure"); return 5;
            }
            if (now() > nextReport) {
                if (a.active) a.report("sample");
                if (b.active) b.report("sample");
                nextReport = now() + .25;
            }
            sauce_obs::pumpEvents(.02);
        }
        b.stop();
        return a.failed || b.failed ? 5 : 0;
    }
}
