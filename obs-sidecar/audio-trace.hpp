// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <obs.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <mutex>

namespace sauce_obs {
// Test-only observations of generated tones, never a PCM recording. The Rust
// production launcher clears the environment and cannot enable this path.
class AudioTrace final {
    struct Event { const char *kind; unsigned channel; uint64_t timestamp; int64_t value; };
    struct Stage {
        std::mutex mutex;
        uint64_t first = 0, expected = 0, frames = 0, calls = 0, invalid = 0;
        std::array<uint64_t, 2> quiet{}, quietStart{}, maximumQuiet{};
        std::array<double, 2> energy{}, peak{};
        std::array<Event, 64> events{};
        size_t count = 0, omitted = 0;
        void event(const char *kind, unsigned channel, uint64_t timestamp, int64_t value) {
            if (count < events.size()) events[count++] = {kind, channel, timestamp, value};
            else omitted++;
        }
        void observe(const audio_data *data) {
            std::lock_guard<std::mutex> lock(mutex);
            if (!data || !data->data[0] || !data->data[1] || data->frames > 8192) { invalid++; return; }
            if (!first) first = data->timestamp;
            if (expected) {
                const int64_t delta = static_cast<int64_t>(data->timestamp) - static_cast<int64_t>(expected);
                if (std::abs(delta) > 100000) event("timestamp-gap-ns", 0, data->timestamp, delta);
            }
            expected = data->timestamp + static_cast<uint64_t>(data->frames) * 1000000000 / 48000;
            frames += data->frames; calls++;
            for (unsigned channel = 0; channel < 2; channel++) {
                const float *values = reinterpret_cast<const float *>(data->data[channel]);
                for (uint32_t frame = 0; frame < data->frames; frame++) {
                    if (!std::isfinite(values[frame])) { invalid++; continue; }
                    energy[channel] += static_cast<double>(values[frame]) * values[frame];
                    peak[channel] = std::max(peak[channel], static_cast<double>(std::abs(values[frame])));
                    if (std::abs(values[frame]) < .0001f) {
                        if (!quiet[channel]) quietStart[channel] = data->timestamp + static_cast<uint64_t>(frame) * 1000000000 / 48000;
                        quiet[channel]++;
                        maximumQuiet[channel] = std::max(maximumQuiet[channel], quiet[channel]);
                    } else {
                        if (quiet[channel] >= 240) event("quiet-frames", channel, quietStart[channel], quiet[channel]);
                        quiet[channel] = 0;
                    }
                }
            }
        }
        void report(const char *stage, unsigned slot, uint64_t generation) {
            std::lock_guard<std::mutex> lock(mutex);
            std::fprintf(stderr, "[obs-audio-trace] stage=%s slot=%u generation=%llu first=%llu frames=%llu calls=%llu invalid=%llu maxQuiet=%llu/%llu rms=%.8f/%.8f peak=%.8f/%.8f omitted=%zu\n",
                stage, slot, (unsigned long long)generation, (unsigned long long)first,
                (unsigned long long)frames, (unsigned long long)calls, (unsigned long long)invalid,
                (unsigned long long)maximumQuiet[0], (unsigned long long)maximumQuiet[1],
                frames ? std::sqrt(energy[0] / frames) : 0, frames ? std::sqrt(energy[1] / frames) : 0,
                peak[0], peak[1], omitted);
            for (size_t index = 0; index < count; index++) {
                const auto &value = events[index];
                std::fprintf(stderr, "[obs-audio-trace] stage=%s slot=%u generation=%llu kind=%s channel=%u timestamp=%llu value=%lld\n",
                    stage, slot, (unsigned long long)generation, value.kind, value.channel,
                    (unsigned long long)value.timestamp, (long long)value.value);
            }
        }
    } captured_, mixed_;
    obs_source_t *source_;
    unsigned slot_;
    uint64_t generation_;
    bool connected_;
    static void captured(void *context, obs_source_t *, const audio_data *data, bool) {
        static_cast<AudioTrace *>(context)->captured_.observe(data);
    }
    static void mixed(void *context, size_t, audio_data *data) {
        static_cast<AudioTrace *>(context)->mixed_.observe(data);
    }
public:
    AudioTrace(obs_source_t *source, unsigned slot, uint64_t generation) : source_(source), slot_(slot), generation_(generation) {
        obs_source_add_audio_capture_callback(source_, captured, this);
        connected_ = audio_output_connect(obs_get_audio(), slot_, nullptr, mixed, this);
    }
    ~AudioTrace() {
        obs_source_remove_audio_capture_callback(source_, captured, this);
        if (connected_) audio_output_disconnect(obs_get_audio(), slot_, mixed, this);
        captured_.report("captured", slot_, generation_);
        mixed_.report("mixed", slot_, generation_);
    }
    AudioTrace(const AudioTrace &) = delete;
    AudioTrace &operator=(const AudioTrace &) = delete;
};
} // namespace sauce_obs
