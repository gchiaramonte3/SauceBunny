// SPDX-License-Identifier: MIT
// TEST ONLY: link instead of ndi_sender_sdk.cpp. No runtime loader or network.
#include "ndi_sender_sdk.hpp"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <inttypes.h>
#include <new>
#include <unistd.h>

namespace sauce_ndi {
namespace {
enum class Mode { Normal, Unavailable, BlockCreate, FailVideo, FailAudio,
    BlockVideo, BlockAudio, BlockDestroy };

Mode mode() {
    const char *value = std::getenv("SAUCE_NDI_FAKE_MODE");
    if (!value || !std::strcmp(value, "normal")) return Mode::Normal;
    if (!std::strcmp(value, "unavailable")) return Mode::Unavailable;
    if (!std::strcmp(value, "block_create")) return Mode::BlockCreate;
    if (!std::strcmp(value, "fail_video")) return Mode::FailVideo;
    if (!std::strcmp(value, "fail_audio")) return Mode::FailAudio;
    if (!std::strcmp(value, "block_video")) return Mode::BlockVideo;
    if (!std::strcmp(value, "block_audio")) return Mode::BlockAudio;
    if (!std::strcmp(value, "block_destroy")) return Mode::BlockDestroy;
    return Mode::Unavailable;
}

void event(const char *name) {
    std::fprintf(stderr, "{\"fake\":\"%s\"}\n", name);
    std::fflush(stderr);
}

[[noreturn]] void blocked() {
    // Model foreign code that never returns, even when SIGTERM interrupts it.
    // Only the owning subprocess harness can terminate/reap this process.
    for (;;) pause();
}

uint32_t checksum(const uint8_t *bytes, size_t length) {
    uint32_t value = 2166136261U;
    for (size_t index = 0; index < length; ++index) value = (value ^ bytes[index]) * 16777619U;
    return value;
}

class FakeSink final : public Sink {
public:
    explicit FakeSink(Mode value) : mode_(value) {}
    ~FakeSink() override {
        event("destroy_enter");
        if (mode_ == Mode::BlockDestroy) blocked();
        event("destroy_done");
    }
    bool video(const sauce_obs::RawFrameInfo &frame, const uint8_t *bytes) override {
        std::fprintf(stderr,
            "{\"fake\":\"video\",\"capture\":%" PRIu64 ",\"broadcast\":%" PRIu64
            ",\"timestamp\":\"%" PRIu64 "\",\"width\":%u,\"height\":%u,\"stride\":%u,\"bytes\":%u,\"checksum\":%u}\n",
            frame.captureGeneration, frame.broadcastGeneration, frame.timestamp,
            frame.width, frame.height, frame.stride, frame.payloadBytes, checksum(bytes, frame.payloadBytes));
        std::fflush(stderr);
        if (mode_ == Mode::BlockVideo) blocked();
        return mode_ != Mode::FailVideo;
    }
    bool audio(const sauce_obs::RawFrameInfo &frame, const float *samples) override {
        std::fprintf(stderr,
            "{\"fake\":\"audio\",\"capture\":%" PRIu64 ",\"broadcast\":%" PRIu64
            ",\"timestamp\":\"%" PRIu64 "\",\"frames\":%u,\"sampleRate\":%u,\"channels\":%u,"
            "\"leftFirst\":%.9g,\"leftLast\":%.9g,\"rightFirst\":%.9g,\"rightLast\":%.9g}\n",
            frame.captureGeneration, frame.broadcastGeneration, frame.timestamp,
            frame.frames, frame.sampleRate, unsigned(frame.channels),
            double(samples[0]), double(samples[frame.frames - 1]),
            double(samples[frame.frames]), double(samples[frame.frames * 2 - 1]));
        std::fflush(stderr);
        if (mode_ == Mode::BlockAudio) blocked();
        return mode_ != Mode::FailAudio;
    }
private:
    Mode mode_;
};
}

std::unique_ptr<Sink> create_sdk_sink(const char *absolute_runtime_path) noexcept {
    event("factory"); // Canary: forbidden CLI/input cases must never reach here.
    const Mode selected = mode();
    if (selected == Mode::BlockCreate) blocked();
    if (selected == Mode::Unavailable || !absolute_runtime_path || absolute_runtime_path[0] != '/') return {};
    return std::unique_ptr<Sink>(new (std::nothrow) FakeSink(selected));
}
}
