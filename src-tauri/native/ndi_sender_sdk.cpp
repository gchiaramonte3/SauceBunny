// SPDX-License-Identifier: MIT
// Separate-process sender only. No libobs, discovery, receiver, or app linkage.
#include "ndi_sender_sdk.hpp"
#define NDILIB_CPP_DEFAULT_CONSTRUCTORS 0
#include <Processing.NDI.Lib.h>
#include <dlfcn.h>
#include <cstring>

namespace sauce_ndi {
namespace {
class SdkSink final : public Sink {
    void* library_ = nullptr;
    const NDIlib_v6* api_ = nullptr;
    NDIlib_send_instance_t sender_ = nullptr;
    bool initialized_ = false;
public:
    bool open(const char* path) {
        if (!path || path[0] != '/' || strnlen(path, 4097) > 4096) return false;
        library_ = dlopen(path, RTLD_NOW | RTLD_LOCAL);
        if (!library_) return false;
        using Load = const NDIlib_v6* (*)();
        auto load = reinterpret_cast<Load>(dlsym(library_, "NDIlib_v6_load"));
        api_ = load ? load() : nullptr;
        if (!api_ || !api_->initialize || !api_->destroy || !api_->send_create ||
            !api_->send_destroy || !api_->send_send_video_v2 || !api_->send_send_audio_v2)
            return false;
        initialized_ = api_->initialize();
        if (!initialized_) return false;
        NDIlib_send_create_t settings{};
        settings.p_ndi_name = "Sauce Bunny";
        settings.p_groups = nullptr;
        // OBS already paces both tracks. A second SDK clock would block the
        // single consumer and needlessly accumulate source audio behind video.
        settings.clock_video = false;
        settings.clock_audio = false;
        sender_ = api_->send_create(&settings);
        return sender_ != nullptr;
    }

    ~SdkSink() override {
        // Only the consumer thread destroys SDK state, after its synchronous
        // calls have returned. A blocked vendor call/destructor must be ended
        // by reaping this process, never by freeing its buffers on another thread.
        if (sender_) api_->send_destroy(sender_);
        if (initialized_) api_->destroy();
        if (library_) dlclose(library_);
    }

    bool video(const sauce_obs::RawFrameInfo& info, const uint8_t* pixels) override {
        if (!sender_ || !pixels || info.kind != 1 || !sauce_obs::rawFrameValid(info)) return false;
        NDIlib_video_frame_v2_t frame{};
        frame.xres = static_cast<int>(info.width);
        frame.yres = static_cast<int>(info.height);
        frame.FourCC = NDIlib_FourCC_video_type_BGRA;
        // SBR1 carries the current engine's fixed 30/1 output. A new cadence
        // requires a versioned source contract, not inference from dropped video.
        frame.frame_rate_N = 30;
        frame.frame_rate_D = 1;
        frame.picture_aspect_ratio = 0.0f; // square pixels, including cropped rasters
        frame.frame_format_type = NDIlib_frame_format_type_progressive;
        frame.timecode = static_cast<int64_t>(info.timestamp / 100);
        frame.p_data = const_cast<uint8_t*>(pixels);
        frame.line_stride_in_bytes = static_cast<int>(info.stride);
        frame.p_metadata = nullptr;
        // timestamp is receive-only. timecode above preserves the shared OBS
        // clock in NDI's 100 ns units; it is not editor sequence timecode.
        api_->send_send_video_v2(sender_, &frame);
        // Deliberately synchronous. The reader may reuse its pixels now; the
        // async SDK API retains them until a later synchronization operation.
        return true;
    }

    bool audio(const sauce_obs::RawFrameInfo& info, const float* planar) override {
        if (!sender_ || !planar || info.kind != 2 || !sauce_obs::rawFrameValid(info)) return false;
        NDIlib_audio_frame_v2_t frame{};
        frame.sample_rate = static_cast<int>(info.sampleRate);
        frame.no_channels = static_cast<int>(info.channels);
        frame.no_samples = static_cast<int>(info.frames);
        frame.timecode = static_cast<int64_t>(info.timestamp / 100);
        frame.p_data = const_cast<float*>(planar);
        frame.channel_stride_in_bytes = static_cast<int>(info.frames * sizeof(float));
        frame.p_metadata = nullptr;
        api_->send_send_audio_v2(sender_, &frame);
        return true; // synchronous consumption; no sample pointers retained here
    }
};
} // namespace

std::unique_ptr<Sink> create_sdk_sink(const char* absolute_runtime_path) noexcept {
    try {
        auto sink = std::make_unique<SdkSink>();
        if (!sink->open(absolute_runtime_path)) return nullptr;
        return sink;
    } catch (...) {
        // Do not copy vendor diagnostics, runtime paths, or arbitrary strings
        // into the machine-readable process status channel.
        return nullptr;
    }
}
} // namespace sauce_ndi
