// SPDX-License-Identifier: MIT
// Test-only NDI function table. No vendor implementation or network code.
#define NDILIB_CPP_DEFAULT_CONSTRUCTORS 0
#include <cstddef>
#include <Processing.NDI.Lib.h>
#include <array>
#include <cstring>

namespace {
std::array<unsigned, 7> counts{}; // init, destroy, create, close, video, audio, invalid
int mode = 0;
int instance;
NDIlib_send_instance_t handle() { return reinterpret_cast<NDIlib_send_instance_t>(&instance); }
void check(bool okay) { if (!okay) ++counts[6]; }
bool initialize() { ++counts[0]; return mode != 1; }
void destroy() { ++counts[1]; check(counts[3] == (mode == 2 ? 0U : 1U)); }
NDIlib_send_instance_t create(const NDIlib_send_create_t* config) {
    ++counts[2];
    check(config && config->p_ndi_name && std::strcmp(config->p_ndi_name, "Sauce Bunny") == 0 &&
          !config->p_groups && !config->clock_video && !config->clock_audio);
    return mode == 2 ? nullptr : handle();
}
void close_sender(NDIlib_send_instance_t value) { ++counts[3]; check(value == handle() && !counts[1]); }
void video(NDIlib_send_instance_t value, const NDIlib_video_frame_v2_t* frame) {
    ++counts[4];
    check(value == handle() && frame && frame->xres == 4 && frame->yres == 2 &&
          frame->FourCC == NDIlib_FourCC_video_type_BGRA && frame->frame_rate_N == 30 &&
          frame->frame_rate_D == 1 && frame->picture_aspect_ratio == 0.0f &&
          frame->frame_format_type == NDIlib_frame_format_type_progressive &&
          frame->timecode == 1234567 && frame->line_stride_in_bytes == 16 &&
          !frame->p_metadata && !frame->timestamp && frame->p_data);
    if (frame && frame->p_data)
        for (unsigned n = 0; n < 32; ++n) check(frame->p_data[n] == n);
}
void audio(NDIlib_send_instance_t value, const NDIlib_audio_frame_v2_t* frame) {
    ++counts[5];
    check(value == handle() && frame && frame->sample_rate == 48000 &&
          frame->no_channels == 2 && frame->no_samples == 3 && frame->timecode == 1234567 &&
          frame->channel_stride_in_bytes == 12 && !frame->p_metadata && !frame->timestamp && frame->p_data);
    if (frame && frame->p_data)
        for (unsigned n = 0; n < 6; ++n) check(frame->p_data[n] == float(n + 1) / 8);
}
} // namespace

extern "C" void sauce_ndi_fixture_reset(int next) { counts.fill(0); mode = next; }
extern "C" unsigned sauce_ndi_fixture_count(unsigned index) { return index < counts.size() ? counts[index] : 999; }
extern "C" const NDIlib_v6* NDIlib_v6_load() {
    static NDIlib_v6 api{};
    api = {};
    api.initialize = initialize;
    api.destroy = destroy;
    api.send_create = create;
    api.send_destroy = close_sender;
    api.send_send_video_v2 = video;
    api.send_send_audio_v2 = mode == 3 ? nullptr : audio;
    return mode == 4 ? nullptr : &api;
}
