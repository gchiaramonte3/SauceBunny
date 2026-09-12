// SPDX-License-Identifier: MIT
#include "ndi_sender.hpp"
#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <fcntl.h>
#include <limits>
#include <memory>
#include <new>
#include <optional>
#include <poll.h>
#include <sys/stat.h>
#include <unistd.h>

namespace sauce_ndi {
namespace {
using Clock = std::chrono::steady_clock;
using Milliseconds = std::chrono::milliseconds;
constexpr auto startupWait = Milliseconds(3000);
constexpr auto inactiveWait = Milliseconds(1000);
constexpr auto partialWait = Milliseconds(500);
constexpr auto cancelPoll = Milliseconds(20);
static_assert(sizeof(float) == 4 && std::numeric_limits<float>::is_iec559);
static_assert(__BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__);

struct Descriptor {
    int value;
    ~Descriptor() { if (value >= 0) close(value); }
};
struct alignas(64) Buffers {
    alignas(64) std::array<uint8_t, sauce_obs::rawMaxPayload> video;
    alignas(64) std::array<float, 4096 * 2> audio;
};

// Eof means zero bytes at an allowed record boundary, never a short record.
std::optional<Result> readExact(int fd, uint8_t *out, size_t size, Clock::time_point deadline,
                                bool boundary, const std::atomic<bool> &stopped) {
    size_t received = 0;
    while (received < size) {
        if (stopped.load()) return Result::Cancelled;
        const auto now = Clock::now();
        if (now >= deadline) return Result::ReadTimeout;
        const auto count = read(fd, out + received, std::min<size_t>(size - received, 65536));
        if (count > 0) { received += size_t(count); continue; }
        if (count == 0) return boundary && !received ? Result::Eof : Result::TruncatedInput;
        if (errno == EINTR) continue;
        if (errno != EAGAIN && errno != EWOULDBLOCK) return Result::ReadFailed;
        pollfd pending{fd, POLLIN, 0};
        const auto remaining = std::chrono::duration_cast<Milliseconds>(deadline - now);
        const int wait = int(std::max<int64_t>(1, std::min(remaining, cancelPoll).count()));
        const int ready = poll(&pending, 1, wait);
        if (ready < 0 && errno == EINTR) continue;
        if (ready < 0 || (pending.revents & (POLLNVAL | POLLERR))) return Result::ReadFailed;
        // POLLHUP may accompany buffered final bytes: read them before EOF.
    }
    return std::nullopt; // Complete; no terminal result.
}

bool continuesAudio(const sauce_obs::RawFrameInfo &frame,
                    uint64_t lastTimestamp, uint32_t lastFrames) {
    if (!lastTimestamp) return true;
    const uint64_t duration = uint64_t(lastFrames) * 1000000000ULL / 48000;
    if (lastTimestamp > std::numeric_limits<uint64_t>::max() - duration) return false;
    const uint64_t expected = lastTimestamp + duration;
    const uint64_t delta = frame.timestamp > expected ? frame.timestamp - expected : expected - frame.timestamp;
    // OBS advances its integer-nanosecond sample clock; allow rounding only,
    // never a missing/duplicated sample, inserted silence, or a clock rebase.
    return delta <= 2;
}
} // namespace

Result consume(int fd, Expected expected, Sink &sink, const std::atomic<bool> &stopped) {
    const auto started = Clock::now();
    if (stopped.load()) return Result::Cancelled;
    if (fd < 0 || !expected.capture || expected.capture > sauce_obs::rawMaxGeneration ||
        !expected.broadcast || expected.broadcast > sauce_obs::rawMaxGeneration) return Result::InvalidInput;
    struct stat description{};
    const int flags = fcntl(fd, F_GETFL);
    if (flags < 0 || (flags & O_ACCMODE) != O_RDONLY ||
        fstat(fd, &description) != 0 || !S_ISFIFO(description.st_mode)) return Result::InvalidInput;
    Descriptor input{fcntl(fd, F_DUPFD_CLOEXEC, 3)};
    if (input.value < 0 || fcntl(input.value, F_SETFL, flags | O_NONBLOCK) < 0) return Result::ReadFailed;
    std::unique_ptr<Buffers> buffers;
    try { buffers.reset(new Buffers); }
    catch (const std::bad_alloc &) { return Result::ReadFailed; }

    uint64_t lastVideo = 0, lastAudio = 0;
    uint32_t lastAudioFrames = 0, width = 0, height = 0, stride = 0;
    auto videoObserved = started, audioObserved = started;
    bool first = true;
    for (;;) {
        // An endless stream of one kind cannot mask a missing/stalled other
        // track. Apply this deadline inside reads, not just between records.
        const auto trackDeadline = !lastVideo || !lastAudio ? started + startupWait :
            std::min(videoObserved, audioObserved) + inactiveWait;
        std::array<uint8_t, sauce_obs::rawHeaderSize> header{};
        // Read the first byte separately to start one unextendable record
        // deadline. Zero progress at this boundary is the only clean EOF.
        auto result = readExact(input.value, header.data(), 1,
                                std::min(Clock::now() + (first ? startupWait : inactiveWait), trackDeadline), true, stopped);
        if (result) return *result;
        const auto deadline = std::min(Clock::now() + partialWait, trackDeadline);
        result = readExact(input.value, header.data() + 1, header.size() - 1, deadline, false, stopped);
        if (result) return *result;
        const auto parsed = sauce_obs::readRawFrameHeader(header.data(), header.size());
        if (!parsed) return Result::InvalidInput;
        const auto &frame = *parsed;
        if (frame.captureGeneration != expected.capture || frame.broadcastGeneration != expected.broadcast)
            return Result::InvalidInput;
        const auto otherTimestamp = frame.kind == 1 ? lastAudio : lastVideo;
        if (otherTimestamp && (frame.timestamp > otherTimestamp ? frame.timestamp - otherTimestamp :
                              otherTimestamp - frame.timestamp) > 1000000000ULL) return Result::InvalidInput;
        if (frame.kind == 1) {
            if (frame.timestamp <= lastVideo || (width &&
                (frame.width != width || frame.height != height || frame.stride != stride))) return Result::InvalidInput;
        } else if (frame.timestamp <= lastAudio || !continuesAudio(frame, lastAudio, lastAudioFrames)) {
            return Result::InvalidInput;
        }
        auto *payload = frame.kind == 1 ? buffers->video.data() : reinterpret_cast<uint8_t *>(buffers->audio.data());
        result = readExact(input.value, payload, frame.payloadBytes, deadline, false, stopped);
        if (result) return *result;
        const auto observed = Clock::now();
        if (frame.kind == 2) {
            for (size_t n = 0; n < size_t(frame.frames) * frame.channels; ++n)
                if (!std::isfinite(buffers->audio[n])) return Result::InvalidInput;
        }
        if (stopped.load()) return Result::Cancelled;
        if (observed >= deadline) return Result::ReadTimeout;
        bool accepted;
        try {
            accepted = frame.kind == 1 ? sink.video(frame, buffers->video.data()) : sink.audio(frame, buffers->audio.data());
        } catch (...) { return Result::SinkFailed; }
        if (!accepted) return Result::SinkFailed;
        if (frame.kind == 1) {
            lastVideo = frame.timestamp;
            width = frame.width; height = frame.height; stride = frame.stride;
            videoObserved = observed;
        } else {
            lastAudio = frame.timestamp;
            lastAudioFrames = frame.frames;
            audioObserved = observed;
        }
        first = false;
    }
}
} // namespace sauce_ndi
