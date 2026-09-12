// SPDX-License-Identifier: GPL-2.0-or-later
// Generated PCM only: no device, window, microphone, monitor or network.
// Deliver continuous source samples with a short, repeatable arrival delay.
#import <Foundation/Foundation.h>
#include "engine.hpp"
#include <util/platform.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <mutex>
#include <thread>

namespace {
constexpr uint64_t second = 1000000000;
struct Observation {
    std::mutex mutex;
    uint64_t origin = 0, frames = 0;
    std::array<unsigned, 2> quiet{}, longest{};
    std::array<double, 2> energy{};
};
void observe(void *context, size_t, audio_data *data) {
    auto &state = *static_cast<Observation *>(context);
    std::lock_guard<std::mutex> lock(state.mutex);
    if (data->timestamp < state.origin + second || data->timestamp >= state.origin + 6 * second) return;
    state.frames += data->frames;
    for (unsigned channel = 0; channel < 2; channel++) {
        const float *values = reinterpret_cast<const float *>(data->data[channel]);
        for (unsigned frame = 0; frame < data->frames; frame++) {
            state.energy[channel] += values[frame] * values[frame];
            state.quiet[channel] = std::abs(values[frame]) < .0001f ? state.quiet[channel] + 1 : 0;
            state.longest[channel] = std::max(state.longest[channel], state.quiet[channel]);
        }
    }
}
const char *name(void *) { return "Generated jitter fixture"; }
void *create(obs_data_t *, obs_source_t *source) { return source; }
void destroy(void *) {}
}

int main(int argc, char **argv) {
    @autoreleasepool {
        const bool control = argc == 3 && std::string(argv[2]) == "--dynamic-control";
        if (argc != 2 && !control) return 2;
        sauce_obs::Engine engine;
        if (!engine.initialize(argv[1], 640, 360)) return 3;
        if (control) {
            obs_audio_info audio = {48000, SPEAKERS_STEREO};
            if (!obs_reset_audio(&audio)) return 3;
        }
        obs_audio_info2 configuration = {};
        if (!obs_get_audio_info2(&configuration)) return 3;
        obs_source_info info = {};
        info.id = "sauce-generated-jitter-test";
        info.type = OBS_SOURCE_TYPE_INPUT;
        info.output_flags = OBS_SOURCE_AUDIO;
        info.get_name = name; info.create = create; info.destroy = destroy;
        obs_register_source(&info);
        obs_source_t *source = obs_source_create_private(info.id, "generated-audio", nullptr);
        if (!source) return 3;
        obs_source_set_audio_mixers(source, 1);
        obs_source_set_monitoring_type(source, OBS_MONITORING_TYPE_NONE);
        obs_set_output_source(0, source);
        Observation observation;
        observation.origin = os_gettime_ns() + 100000000;
        if (!audio_output_connect(obs_get_audio(), 0, nullptr, observe, &observation)) return 3;
        std::thread producer([&] {
            std::array<std::array<float, 960>, 2> samples{};
            for (unsigned block = 0; block < 325; block++) {
                const uint64_t timestamp = observation.origin + block * 20000000ULL;
                // 40 ms baseline delivery latency; a 50 ms scheduling stall
                // every 1.5 s. Source timestamps/samples remain contiguous.
                const uint64_t delay = (block == 100 || block == 175 || block == 250) ? 90000000 : 40000000;
                os_sleepto_ns(timestamp + delay);
                for (unsigned channel = 0; channel < 2; channel++)
                    for (unsigned frame = 0; frame < 960; frame++)
                        samples[channel][frame] = .01 * std::sin(2 * M_PI * (channel ? 660 : 440) *
                            (block * 960 + frame) / 48000.0);
                obs_source_audio audio = {};
                audio.data[0] = reinterpret_cast<uint8_t *>(samples[0].data());
                audio.data[1] = reinterpret_cast<uint8_t *>(samples[1].data());
                audio.frames = 960; audio.speakers = SPEAKERS_STEREO;
                audio.format = AUDIO_FORMAT_FLOAT_PLANAR; audio.samples_per_sec = 48000;
                audio.timestamp = timestamp;
                obs_source_output_audio(source, &audio);
            }
        });
        sauce_obs::pumpEvents(6.85);
        producer.join();
        audio_output_disconnect(obs_get_audio(), 0, observe, &observation);
        obs_set_output_source(0, nullptr);
        obs_source_release(source);
        const double left = observation.frames ? std::sqrt(observation.energy[0] / observation.frames) : 0;
        const double right = observation.frames ? std::sqrt(observation.energy[1] / observation.frames) : 0;
        const bool passed = observation.frames >= 4 * 48000 && left > .006 && right > .006 &&
                            observation.longest[0] < 240 && observation.longest[1] < 240;
        std::printf("{\"passed\":%s,\"fixed\":%s,\"bufferMs\":%u,\"frames\":%llu,\"quietFrames\":[%u,%u],\"rms\":[%.8f,%.8f]}\n",
            passed ? "true" : "false", configuration.fixed_buffering ? "true" : "false", configuration.max_buffering_ms,
            (unsigned long long)observation.frames, observation.longest[0], observation.longest[1], left, right);
        return passed ? 0 : 5;
    }
}
