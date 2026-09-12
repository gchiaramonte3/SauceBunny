// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <media-io/audio-io.h>
#include <media-io/video-io.h>
#include <atomic>
#include <cstdint>
#include <memory>

namespace sauce_obs {
// Optional raw consumer of one program's private canvas and exact audio mix.
// The caller serializes start/stop and keeps both OBS outputs alive until stop
// returns. Status queries are atomic. No callbacks retain OBS-owned frame data.
class RawOutput final {
public:
    RawOutput();
    ~RawOutput();
    RawOutput(const RawOutput &) = delete;
    RawOutput &operator=(const RawOutput &) = delete;
    // Duplicates an inherited pipe writer; its owner retains the original fd.
    // O_NONBLOCK affects their shared open-file description. A clean stop can
    // restart; failed() permanently poisons this owner and its inherited channel.
    bool start(video_t *video, audio_t *audio, unsigned mixIndex,
               unsigned width, unsigned height, int inheritedFd,
               uint64_t captureGeneration, uint64_t broadcastGeneration);
    void stop();
    bool active() const { return active_.load(); }
    bool failed() const { return failed_.load(); }
private:
    struct State;
    std::unique_ptr<State> state_;
    std::atomic<bool> active_{false}, failed_{false};
};
} // namespace sauce_obs
