// SPDX-License-Identifier: GPL-2.0-or-later
// Finite generated/local-media proof. Creates no screen or microphone source.
#import <Foundation/Foundation.h>
#include "proof-output.hpp"
#ifdef SAUCE_OBS_SUPERVISED
#include "owner-watchdog.hpp"
#endif
#include <cstdio>

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
        if (argc != 3) {
            std::fputs("usage: saucebunny-obs-media-probe <runtime> <local-test-media>\n", stderr); return 2;
        }
        std::error_code error;
        const auto root = std::filesystem::canonical(argv[1], error);
        if (error) { std::fputs("runtime_directory_missing\n", stderr); return 2; }
        const auto fixture = std::filesystem::canonical(argv[2], error);
        if (error || !std::filesystem::is_regular_file(fixture, error) || error) {
            std::fputs("local_fixture_missing\n", stderr); return 2;
        }
        sauce_obs::Engine engine;
        if (!engine.initialize(root, 1280, 720)) {
            std::fprintf(stderr, "%s\n", engine.error().c_str()); return 3;
        }
        obs_data_t *settings = obs_data_create();
        obs_data_set_bool(settings, "is_local_file", true);
        obs_data_set_string(settings, "local_file", fixture.c_str());
        obs_data_set_bool(settings, "looping", true);
        obs_data_set_bool(settings, "restart_on_activate", true);
        obs_source_t *source = obs_source_create_private("ffmpeg_source", "fixture", settings);
        obs_data_release(settings);
        if (!source) { std::fputs("fixture_source_failed\n", stderr); return 4; }
        const int result = sauce_obs::writeProgram(source, {0, 0, 0, 0, 1280, 720}, [] { return true; }, shouldStop, duration);
        obs_source_release(source);
        return result;
    }
}
