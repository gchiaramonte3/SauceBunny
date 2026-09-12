// SPDX-License-Identifier: MIT
// Pure generated-pipe tests. No SDK, source discovery, capture, or network.
#include "ndi_sender.hpp"
#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <limits>
#include <signal.h>
#include <stdexcept>
#include <sys/socket.h>
#include <thread>
#include <unistd.h>
#include <vector>

namespace {
using sauce_ndi::Expected;
using sauce_ndi::Result;
using sauce_obs::RawFrameInfo;
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;
unsigned checks = 0;
void check(bool condition, const char *name) {
    ++checks;
    if (!condition) { std::fprintf(stderr, "ndi_sender: %s\n", name); std::exit(1); }
}
struct Pipe {
    int read = -1, write = -1;
    Pipe() { int fds[2]; check(pipe(fds) == 0, "pipe creation"); read = fds[0]; write = fds[1]; }
    void closeRead() { if (read >= 0) close(read); read = -1; }
    void closeWrite() { if (write >= 0) close(write); write = -1; }
    ~Pipe() { closeRead(); closeWrite(); }
};
bool writeAll(int fd, const uint8_t *bytes, size_t size, size_t chunk = 65536) {
    while (size) {
        const auto count = ::write(fd, bytes, std::min(size, chunk));
        if (count > 0) { bytes += count; size -= size_t(count); }
        else if (count < 0 && errno == EINTR) continue;
        else return false;
    }
    return true;
}
RawFrameInfo video(uint64_t timestamp = 1000000000ULL, uint32_t width = 2, uint32_t height = 2) {
    RawFrameInfo frame;
    frame.kind = 1; frame.captureGeneration = 7; frame.broadcastGeneration = 9;
    frame.timestamp = timestamp; frame.width = width; frame.height = height;
    frame.stride = width * 4; frame.payloadBytes = frame.stride * height;
    return frame;
}
RawFrameInfo audio(uint64_t timestamp = 1000000000ULL, uint32_t frames = 1024) {
    RawFrameInfo frame;
    frame.kind = 2; frame.captureGeneration = 7; frame.broadcastGeneration = 9;
    frame.timestamp = timestamp; frame.frames = frames; frame.sampleRate = 48000;
    frame.channels = 2; frame.payloadBytes = frames * 8;
    return frame;
}
std::vector<uint8_t> record(const RawFrameInfo &frame) {
    const auto header = sauce_obs::rawFrameHeader(frame);
    std::vector<uint8_t> result(header.begin(), header.end());
    result.resize(header.size() + frame.payloadBytes);
    if (frame.kind == 1) {
        for (size_t n = header.size(); n < result.size(); ++n) result[n] = uint8_t(n - header.size());
    } else {
        for (size_t n = 0; n < size_t(frame.frames) * 2; ++n) {
            const float sample = n < frame.frames ? 0.25f : -0.5f;
            std::memcpy(result.data() + header.size() + n * sizeof(float), &sample, sizeof(sample));
        }
    }
    return result;
}
void append(std::vector<uint8_t> &bytes, const RawFrameInfo &frame) {
    const auto next = record(frame); bytes.insert(bytes.end(), next.begin(), next.end());
}
void put(std::vector<uint8_t> &bytes, size_t at, uint64_t value, unsigned count) {
    for (unsigned n = 0; n < count; ++n) bytes[at+n] = uint8_t(value >> ((count - n - 1) * 8));
}
struct Recording : sauce_ndi::Sink {
    unsigned videos = 0, audios = 0;
    unsigned failKind = 0;
    bool throws = false;
    const uint8_t *videoBuffer = nullptr;
    const float *audioBuffer = nullptr;
    std::atomic<bool> *cancel = nullptr;
    bool video(const RawFrameInfo &frame, const uint8_t *bytes) override {
        ++videos;
        check(uintptr_t(bytes) % 64 == 0, "video alignment");
        check(!videoBuffer || videoBuffer == bytes, "video storage reused");
        videoBuffer = bytes;
        check(bytes[0] == 0 && bytes[frame.payloadBytes - 1] == uint8_t(frame.payloadBytes - 1), "video payload preserved");
        if (cancel) cancel->store(true);
        if (throws) throw std::runtime_error("fake sink");
        return failKind != 1;
    }
    bool audio(const RawFrameInfo &frame, const float *samples) override {
        ++audios;
        check(uintptr_t(samples) % 64 == 0, "audio alignment");
        check(!audioBuffer || audioBuffer == samples, "audio storage reused");
        audioBuffer = samples;
        check(samples[0] == 0.25f && samples[frame.frames - 1] == 0.25f &&
              samples[frame.frames] == -0.5f && samples[frame.frames * 2 - 1] == -0.5f, "planar channels preserved");
        if (cancel) cancel->store(true);
        if (throws) throw std::runtime_error("fake sink");
        return failKind != 2;
    }
};
Result feed(const std::vector<uint8_t> &bytes, Recording &sink, Expected expected = {7,9}, size_t chunk = 65536) {
    Pipe channel;
    std::atomic<bool> stopped{false};
    std::thread writer([&] { writeAll(channel.write, bytes.data(), bytes.size(), chunk); channel.closeWrite(); });
    const auto result = sauce_ndi::consume(channel.read, expected, sink, stopped);
    check(fcntl(channel.read, F_GETFD) >= 0, "caller retains fd");
    channel.closeRead(); // Also releases a writer after intentionally invalid input.
    writer.join();
    return result;
}
void validStreams() {
    Recording empty;
    check(feed({}, empty) == Result::Eof && !empty.videos && !empty.audios, "clean empty EOF");
    auto bytes = record(video(2000000000));
    append(bytes, audio(1900000000, 1)); // Separate tracks are not globally sorted.
    append(bytes, video(2033333333));
    append(bytes, audio(1900020833, 4096));
    append(bytes, audio(1985354168, 17)); // +2 ns sample-clock rounding is allowed.
    Recording sink;
    check(feed(bytes, sink, {7,9}, 1) == Result::Eof, "fragmented mixed stream");
    check(sink.videos == 2 && sink.audios == 3, "all mixed frames delivered");
    Recording maximum;
    check(feed(record(video(1000000000, 1920, 1080)), maximum) == Result::Eof && maximum.videos == 1, "bounded maximum raster");
    auto rounding = record(audio(2000000000, 1));
    append(rounding, audio(2000020831, 1)); // -2 ns is allowed too.
    Recording negativeRounding;
    check(feed(rounding, negativeRounding) == Result::Eof && negativeRounding.audios == 2, "negative rounding boundary");
}
void malformedFrames() {
    for (size_t position : {size_t(0),1UL,2UL,3UL,5UL,6UL,7UL,58UL,59UL,60UL,61UL,62UL,63UL}) {
        auto bytes = record(video()); bytes[position] ^= 1;
        Recording sink;
        check(feed(bytes, sink) == Result::InvalidInput && !sink.videos, "magic/reserved byte rejected");
    }
    // A leading zero is malformed, not an empty EOF sentinel.
    auto zero = record(video()); zero[0] = 0;
    Recording zeroSink; check(feed(zero, zeroSink) == Result::InvalidInput, "zero magic rejected");
    struct BadField { size_t at; uint64_t value; unsigned bytes; };
    for (const auto field : std::array<BadField, 18>{{
        {4,3,1}, {8,0,8}, {8,sauce_obs::rawMaxGeneration + 1,8}, {8,8,8}, {16,10,8},
        {16,0,8}, {16,sauce_obs::rawMaxGeneration + 1,8}, {24,0,8}, {32,0xffffffff,4},
        {36,1,4}, {36,3,4}, {36,1922,4}, {40,0,4}, {40,1082,4}, {44,9,4},
        {48,1,4}, {52,48000,4}, {56,2,2}
    }}) {
        auto bytes = record(video()); put(bytes, field.at, field.value, field.bytes);
        Recording sink;
        check(feed(bytes, sink) == Result::InvalidInput && !sink.videos && !sink.audios, "invalid video/tuple field rejected");
    }
    for (const auto field : std::array<BadField, 8>{{
        {36,2,4}, {40,2,4}, {44,8,4}, {48,0,4}, {48,4097,4},
        {52,44100,4}, {56,1,2}, {32,7,4}
    }}) {
        auto bytes = record(audio()); put(bytes, field.at, field.value, field.bytes);
        Recording sink;
        check(feed(bytes, sink) == Result::InvalidInput && !sink.audios, "invalid audio shape rejected");
    }
    for (const float bad : {std::numeric_limits<float>::infinity(), -std::numeric_limits<float>::infinity(),
                            std::numeric_limits<float>::quiet_NaN()}) {
        for (size_t sample : {size_t(0),size_t(2047)}) {
            auto bytes = record(audio()); std::memcpy(bytes.data() + 64 + sample * 4, &bad, 4);
            Recording sink;
            check(feed(bytes, sink) == Result::InvalidInput && !sink.audios, "nonfinite PCM rejected before sink");
        }
    }
}
void statefulValidation() {
    for (const auto next : {video(1000000000), video(999999999), video(2000000000, 4, 2), video(2000000000, 2, 4)}) {
        auto bytes = record(video()); append(bytes, next);
        Recording sink;
        check(feed(bytes, sink) == Result::InvalidInput && sink.videos == 1, "video clock/raster change rejected");
    }
    for (const uint64_t timestamp : {1000000000ULL,999999999ULL,1021333330ULL,1021333336ULL,1021354166ULL}) {
        auto bytes = record(audio()); append(bytes, audio(timestamp));
        Recording sink;
        check(feed(bytes, sink) == Result::InvalidInput && sink.audios == 1, "audio duplicate/regression/gap rejected");
    }
    auto wrap = record(audio(std::numeric_limits<uint64_t>::max() - 10, 1));
    append(wrap, audio(std::numeric_limits<uint64_t>::max(), 1));
    Recording overflow;
    check(feed(wrap, overflow) == Result::InvalidInput && overflow.audios == 1, "audio timestamp arithmetic overflow rejected");
    for (const bool capture : {false,true}) {
        auto next = video(2000000000);
        if (capture) next.captureGeneration++; else next.broadcastGeneration++;
        auto bytes = record(video()); append(bytes, next);
        Recording sink;
        check(feed(bytes, sink) == Result::InvalidInput && sink.videos == 1, "midstream tuple change rejected");
    }
    for (const bool videoFirst : {false,true}) {
        auto bytes = record(videoFirst ? video(2000000001) : audio(2000000001));
        append(bytes, videoFirst ? audio(1000000000) : video(1000000000));
        Recording sink;
        check(feed(bytes, sink) == Result::InvalidInput && sink.videos + sink.audios == 1, "gross cross-track skew rejected");
        auto boundary = record(videoFirst ? video(2000000000) : audio(1000000000));
        append(boundary, videoFirst ? audio(1000000000) : video(2000000000));
        Recording permitted;
        check(feed(boundary, permitted) == Result::Eof && permitted.videos == 1 && permitted.audios == 1, "one-second skew boundary permitted");
    }
}
void truncationAndSinks() {
    const auto good = record(video());
    for (size_t length = 1; length < good.size(); ++length) {
        Recording sink;
        check(feed(std::vector<uint8_t>(good.begin(), good.begin() + length), sink) == Result::TruncatedInput && !sink.videos,
              "every short header/payload is truncated");
    }
    auto malformed = record(video()); malformed[0] = 0;
    append(malformed, video(2000000000));
    Recording noResync;
    check(feed(malformed, noResync) == Result::InvalidInput && !noResync.videos, "never scan forward for valid magic");
    for (const unsigned kind : {1U,2U}) {
        auto bytes = record(kind == 1 ? video() : audio()); append(bytes, video(2000000000));
        Recording sink; sink.failKind = kind;
        check(feed(bytes, sink) == Result::SinkFailed && sink.videos + sink.audios == 1, "sink failure is terminal");
        Recording throwing; throwing.throws = true;
        check(feed(bytes, throwing) == Result::SinkFailed && throwing.videos + throwing.audios == 1, "sink exception is terminal");
    }
}
void descriptorsAndCancel() {
    Recording sink;
    std::atomic<bool> stopped{false};
    check(sauce_ndi::consume(-1, {7,9}, sink, stopped) == Result::InvalidInput, "negative fd rejected");
    const int regular = open("/dev/null", O_RDONLY);
    check(regular >= 0, "open non-pipe");
    check(sauce_ndi::consume(regular, {7,9}, sink, stopped) == Result::InvalidInput, "non-FIFO rejected");
    close(regular);
    Pipe closed;
    const int closedFd = closed.read;
    closed.closeRead();
    check(sauce_ndi::consume(closedFd, {7,9}, sink, stopped) == Result::InvalidInput, "closed fd rejected");
    int sockets[2]; check(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0, "socketpair creation");
    check(sauce_ndi::consume(sockets[0], {7,9}, sink, stopped) == Result::InvalidInput, "socket rejected");
    close(sockets[0]); close(sockets[1]);
    Pipe channel;
    const int initialFlags = fcntl(channel.read, F_GETFL);
    for (const Expected expected : {Expected{0,9},Expected{7,0},Expected{sauce_obs::rawMaxGeneration+1,9},Expected{7,sauce_obs::rawMaxGeneration+1}})
        check(sauce_ndi::consume(channel.read, expected, sink, stopped) == Result::InvalidInput, "invalid expected tuple rejected");
    check(fcntl(channel.read, F_GETFL) == initialFlags, "validation does not mutate fd flags");
    check(sauce_ndi::consume(channel.write, {7,9}, sink, stopped) == Result::InvalidInput, "writer fd rejected");
    stopped = true;
    check(sauce_ndi::consume(channel.read, {7,9}, sink, stopped) == Result::Cancelled, "cancel before starting");
    stopped = false;
    std::thread canceller([&] { std::this_thread::sleep_for(40ms); stopped = true; });
    const auto before = Clock::now();
    check(sauce_ndi::consume(channel.read, {7,9}, sink, stopped) == Result::Cancelled, "idle cancel");
    check(Clock::now() - before < 250ms, "idle cancellation bounded");
    canceller.join();
    check(fcntl(channel.read, F_GETFD) >= 0, "cancel retains caller fd");
    stopped = false;
    auto bytes = record(video()); append(bytes, video(2000000000));
    check(writeAll(channel.write, bytes.data(), bytes.size()), "queue cancellation frames");
    Recording afterOne; afterOne.cancel = &stopped;
    check(sauce_ndi::consume(channel.read, {7,9}, afterOne, stopped) == Result::Cancelled && afterOne.videos == 1,
          "cancel during sink prevents next sink call");
    channel.closeRead();
    const uint8_t byte = 0;
    check(::write(channel.write, &byte, 1) < 0 && errno == EPIPE, "cancel closes internal reader duplicate");
    for (const size_t partial : {size_t(1),size_t(65)}) {
        Pipe unfinished;
        stopped = false;
        const auto wire = record(video());
        check(writeAll(unfinished.write, wire.data(), partial), "queue cancellable partial record");
        std::thread partialCanceller([&] { std::this_thread::sleep_for(40ms); stopped = true; });
        const auto started = Clock::now();
        Recording untouched;
        check(sauce_ndi::consume(unfinished.read, {7,9}, untouched, stopped) == Result::Cancelled,
              "cancel partial header/payload");
        check(Clock::now() - started < 250ms && !untouched.videos && !untouched.audios, "partial cancellation bounded before sink");
        partialCanceller.join();
        unfinished.closeRead();
        check(::write(unfinished.write, &byte, 1) < 0 && errno == EPIPE, "partial cancel closes internal duplicate");
    }
}
void deadlines() {
    for (const unsigned phase : {0U,1U,2U,3U}) {
        Pipe channel;
        std::atomic<bool> stopped{false};
        Recording sink;
        const auto bytes = record(video());
        if (phase == 1) check(writeAll(channel.write, bytes.data(), 1), "queue partial header");
        if (phase == 2) check(writeAll(channel.write, bytes.data(), 65), "queue partial payload");
        if (phase == 3) check(writeAll(channel.write, bytes.data(), bytes.size()), "queue pre-idle record");
        const auto before = Clock::now();
        check(sauce_ndi::consume(channel.read, {7,9}, sink, stopped) == Result::ReadTimeout, "startup/partial/inactivity timeout");
        const auto elapsed = Clock::now() - before;
        const auto expected = phase == 0 ? 3000ms : phase == 3 ? 1000ms : 500ms;
        check(elapsed >= expected - 20ms && elapsed < expected + 500ms, "documented deadline bounded");
    }
    // Progress cannot keep an unfinished record alive indefinitely.
    Pipe trickle;
    std::atomic<bool> stopped{false}, writerDone{false};
    std::thread writer([&] {
        const auto bytes = record(video());
        for (size_t n = 0; n < 10 && !writerDone.load(); ++n) {
            if (!writeAll(trickle.write, bytes.data() + n, 1)) break;
            std::this_thread::sleep_for(100ms);
        }
    });
    Recording sink;
    const auto before = Clock::now();
    check(sauce_ndi::consume(trickle.read, {7,9}, sink, stopped) == Result::ReadTimeout, "trickle timeout");
    check(Clock::now() - before < 800ms, "progress never extends record deadline");
    writerDone = true; trickle.closeRead(); writer.join();
}
void trackLiveness() {
    for (const bool bothInitially : {false,true}) {
        for (const bool flowingVideo : {false,true}) {
            Pipe channel;
            std::atomic<bool> stopped{false}, done{false};
            Recording sink;
            std::thread writer([&] {
                if (bothInitially) {
                    const auto initial = record(flowingVideo ? audio(1000000000, 48) : video());
                    if (!writeAll(channel.write, initial.data(), initial.size())) return;
                }
                for (uint64_t n = 0; !done.load(); ++n) {
                    // Keep source clocks close while varying wall-clock time:
                    // this specifically isolates the missing/stalled-track gate.
                    const auto bytes = record(flowingVideo ? video(1000000000 + n * 1000000) :
                                               audio(1000000000 + n * 1000000, 48));
                    if (!writeAll(channel.write, bytes.data(), bytes.size())) return;
                    std::this_thread::sleep_for(20ms);
                }
            });
            const auto before = Clock::now();
            check(sauce_ndi::consume(channel.read, {7,9}, sink, stopped) == Result::ReadTimeout,
                  "flowing track cannot mask missing/stalled other track");
            const auto elapsed = Clock::now() - before;
            const auto expected = bothInitially ? 1000ms : 3000ms;
            check(elapsed >= expected - 20ms && elapsed < expected + 500ms, "per-track liveness deadline bounded");
            const auto flowing = flowingVideo ? sink.videos : sink.audios;
            const auto absent = flowingVideo ? sink.audios : sink.videos;
            check(flowing > 5 && absent == unsigned(bothInitially), "liveness fake-sink counts");
            done = true; channel.closeRead(); writer.join();
        }
    }
}
} // namespace
int main() {
    signal(SIGPIPE, SIG_IGN); // Only this isolated test process writes invalid test pipes.
    validStreams(); malformedFrames(); statefulValidation(); truncationAndSinks(); descriptorsAndCancel(); deadlines(); trackLiveness();
    std::printf("{\"passed\":true,\"checks\":%u}\n", checks);
}
