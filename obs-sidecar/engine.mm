// SPDX-License-Identifier: GPL-2.0-or-later
#import <AppKit/AppKit.h>
#include "engine.hpp"
#include <util/base.h>
#include <cstdio>
#include <cstring>

namespace sauce_obs {
namespace {
void logMessage(int level, const char *format, va_list args, void *) {
    // Buffer growth can interrupt otherwise valid encoded audio. Retain that
    // bounded diagnostic; the production supervisor still discards stderr.
    if (level > LOG_WARNING && std::strstr(format, "audio buffering") == nullptr) return;
    // stdout is reserved for the media/probe protocol. Keep messages bounded.
    char message[2048];
    std::vsnprintf(message, sizeof(message), format, args);
    std::fprintf(stderr, "[obs-helper] %s\n", message);
}
bool loadModule(const std::filesystem::path &root, const char *name) {
    const auto contents = root / "PlugIns" / (std::string(name) + ".plugin") / "Contents";
    const auto binary = contents / "MacOS" / name;
    const auto resources = contents / "Resources";
    obs_module_t *module = nullptr;
    return obs_open_module(&module, binary.c_str(), resources.c_str()) == MODULE_SUCCESS &&
           obs_init_module(module);
}
} // namespace
Engine::~Engine() { if (started_) obs_shutdown(); }
bool Engine::initialize(const std::filesystem::path &root, uint32_t width, uint32_t height) {
    if (started_) { error_ = "engine_already_started"; return false; }
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    base_set_log_handler(logMessage, nullptr);
    // Reject the unpatched upstream runtime before startup can install its
    // global input listener. The build gate also checks linked input APIs.
    if (std::string(obs_get_version_string()) != "32.2.2-sauce-capture1" ||
        obs_get_version() != LIBOBS_API_VER) {
        error_ = "private_runtime_version_mismatch"; return false;
    }
    if (!(started_ = obs_startup("en-US", nullptr, nullptr))) {
        error_ = "engine_start_failed"; return false;
    }
    obs_video_info video = {};
    // Match OBS's stable macOS default instead of its experimental renderer.
    graphicsPath_ = (root / "Frameworks" / "libobs-opengl.dylib").string();
    video.graphics_module = graphicsPath_.c_str();
    video.fps_num = 30;
    video.fps_den = 1;
    video.base_width = video.output_width = width;
    video.base_height = video.output_height = height;
    video.output_format = VIDEO_FORMAT_NV12;
    // Without this OBS supplies packed RGB bytes while the output declares
    // NV12, producing green/striped corruption even though encoding succeeds.
    video.gpu_conversion = true;
    video.colorspace = VIDEO_CS_709;
    video.range = VIDEO_RANGE_PARTIAL;
    video.scale_type = OBS_SCALE_BILINEAR;
    if (obs_reset_video(&video) != OBS_VIDEO_SUCCESS) {
        error_ = "graphics_initialization_failed"; return false;
    }
    // Six 1024-sample mixer blocks at 48 kHz. ScreenCaptureKit delivers in
    // bursts; a reserve chosen from only its first callback can underflow
    // later and emit one silent mixer block despite continuous source PCM.
    // Keep the reserve fixed and bounded instead of growing latency mid-run.
    obs_audio_info2 audio = {48000, SPEAKERS_STEREO, 128, true};
    if (!obs_reset_audio2(&audio)) { error_ = "audio_initialization_failed"; return false; }
    if (!loadModule(root, "sauce-obs-capture") || !loadModule(root, "obs-ffmpeg")) {
        error_ = "required_module_failed"; return false;
    }
    obs_post_load_modules();
    return true;
}
bool Engine::resizeOutput(uint32_t width, uint32_t height) {
    obs_video_info video = {};
    if (!started_ || width < 2 || height < 2 || width > 1920 || height > 1080 ||
        width % 2 || height % 2 || obs_video_active() || !obs_get_video_info(&video)) {
        error_ = "output_resize_invalid"; return false;
    }
    video.base_width = video.output_width = width;
    video.base_height = video.output_height = height;
    if (obs_reset_video(&video) != OBS_VIDEO_SUCCESS) {
        error_ = "output_resize_failed"; return false;
    }
    return true;
}
void pumpEvents(double seconds) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while ([deadline timeIntervalSinceNow] > 0) {
        [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
}
bool hasInput(const char *wanted) {
    const char *id = nullptr;
    for (size_t i = 0; obs_enum_input_types(i, &id); ++i)
        if (std::string(id) == wanted) return true;
    return false;
}
bool hasOutput(const char *wanted) {
    const char *id = nullptr;
    for (size_t i = 0; obs_enum_output_types(i, &id); ++i)
        if (std::string(id) == wanted) return true;
    return false;
}
} // namespace sauce_obs
