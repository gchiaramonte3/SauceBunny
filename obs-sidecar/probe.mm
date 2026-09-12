// SPDX-License-Identifier: GPL-2.0-or-later
// Creates no screen/audio source; does not capture user content.
#import <Foundation/Foundation.h>
#include "engine.hpp"
#include <atomic>
#include <cstdio>

namespace {
std::atomic<unsigned long> frames{0};
void frame(void *, video_data *) { frames.fetch_add(1); }
}
int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc != 2) {
            std::fputs("usage: saucebunny-obs-probe <private-runtime-directory>\n", stderr);
            return 2;
        }
        std::error_code error;
        const auto root = std::filesystem::canonical(argv[1], error);
        if (error) { std::fputs("runtime_directory_missing\n", stderr); return 2; }
        sauce_obs::Engine engine;
        if (!engine.initialize(root, 640, 360)) {
            std::fprintf(stderr, "%s\n", engine.error().c_str()); return 3;
        }
        obs_add_raw_video_callback(nullptr, frame, nullptr);
        sauce_obs::pumpEvents(1);
        obs_remove_raw_video_callback(frame, nullptr);
        const bool capture = sauce_obs::hasInput("screen_capture");
        const bool output = sauce_obs::hasOutput("ffmpeg_output");
        obs_video_info video = {};
        const bool converted = obs_get_video_info(&video) && video.gpu_conversion &&
                               video.output_format == VIDEO_FORMAT_NV12;
        std::printf("{\"engine\":\"OBS\",\"version\":\"%s\",\"captureRegistered\":%s,"
                    "\"outputRegistered\":%s,\"nv12Conversion\":%s,\"renderedFrames\":%lu,\"capturedUserContent\":false}\n",
                    obs_get_version_string(), capture ? "true" : "false",
                    output ? "true" : "false", converted ? "true" : "false", frames.load());
        return capture && output && converted && frames.load() >= 15 ? 0 : 5;
    }
}
