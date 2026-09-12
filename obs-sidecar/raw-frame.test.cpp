// SPDX-License-Identifier: MIT
// Pure wire-format checks. No OBS runtime, media, devices, or network.
#include "raw-frame.hpp"
#include <algorithm>
#include <array>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <sys/mman.h>
#include <unistd.h>

namespace {
using sauce_obs::RawFrameInfo;
using Header = std::array<uint8_t, 64>;
unsigned checks = 0, mutations = 0;
void check(bool condition, const char *message) {
    ++checks;
    if (!condition) {
        std::fprintf(stderr, "raw-frame: %s\n", message);
        std::printf("{\"passed\":false,\"checks\":%u,\"mutations\":%u}\n", checks, mutations);
        std::exit(1);
    }
}
void put(Header &bytes, size_t at, uint64_t value, unsigned count) {
    for (unsigned n = 0; n < count; ++n)
        bytes[at + n] = static_cast<uint8_t>(value >> (8 * (count - n - 1)));
}
bool equal(const RawFrameInfo &a, const RawFrameInfo &b) {
    return a.kind == b.kind && a.captureGeneration == b.captureGeneration &&
        a.broadcastGeneration == b.broadcastGeneration && a.timestamp == b.timestamp &&
        a.payloadBytes == b.payloadBytes && a.width == b.width && a.height == b.height &&
        a.stride == b.stride && a.frames == b.frames && a.sampleRate == b.sampleRate &&
        a.channels == b.channels;
}
void roundTrip(const RawFrameInfo &frame) {
    const auto header = sauce_obs::rawFrameHeader(frame);
    const auto parsed = sauce_obs::readRawFrameHeader(header.data(), header.size());
    check(parsed && equal(*parsed, frame), "valid frame did not round-trip exactly");
}
void reject(const Header &bytes) {
    ++mutations;
    check(!sauce_obs::readRawFrameHeader(bytes.data(), bytes.size()), "hostile header accepted");
}
void rejectField(const Header &valid, size_t at, unsigned count, uint64_t value) {
    Header bytes = valid;
    put(bytes, at, value, count);
    check(bytes != valid, "mutation did not change the canary");
    reject(bytes);
}
void rejectInfo(const RawFrameInfo &frame) {
    check(!sauce_obs::rawFrameValid(frame), "invalid producer frame accepted");
    const Header bytes = sauce_obs::rawFrameHeader(frame);
    check(std::all_of(bytes.begin(), bytes.end(), [](uint8_t b) { return b == 0; }),
          "invalid producer emitted plausible framing");
    reject(bytes);
}
} // namespace

int main() {
    static_assert(sauce_obs::rawHeaderSize == 64);
    static_assert(sizeof(float) == 4);
    const RawFrameInfo video{1, 0x0001020304050607ULL, 0x0011121314151617ULL,
        0x2122232425262728ULL, 230400, 320, 180, 1280, 0, 0, 0};
    const Header expectedVideo{{
        0x53,0x42,0x52,0x31,0x01,0x00,0x00,0x00,
        0x00,0x01,0x02,0x03,0x04,0x05,0x06,0x07,
        0x00,0x11,0x12,0x13,0x14,0x15,0x16,0x17,
        0x21,0x22,0x23,0x24,0x25,0x26,0x27,0x28,
        0x00,0x03,0x84,0x00,0x00,0x00,0x01,0x40,
        0x00,0x00,0x00,0xb4,0x00,0x00,0x05,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00
    }};
    const RawFrameInfo audio{2, 7, 19, 0x0102030405060708ULL, 8192, 0, 0, 0, 1024, 48000, 2};
    const Header expectedAudio{{
        0x53,0x42,0x52,0x31,0x02,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x07,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x13,
        0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08,
        0x00,0x00,0x20,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x04,0x00,0x00,0x00,0xbb,0x80,
        0x00,0x02,0x00,0x00,0x00,0x00,0x00,0x00
    }};
    check(sauce_obs::rawFrameHeader(video) == expectedVideo, "video field offsets or network byte order changed");
    check(sauce_obs::rawFrameHeader(audio) == expectedAudio, "planar float PCM field offsets changed");
    roundTrip(video);
    roundTrip(audio);
    for (uint32_t width : {2u, 320u, 1920u}) {
        for (uint32_t height : {2u, 180u, 1080u}) {
            auto frame = video;
            frame.width = width; frame.height = height;
            frame.stride = width * 4; frame.payloadBytes = width * height * 4;
            roundTrip(frame);
        }
    }
    for (uint32_t frames : {1u, 1024u, 4096u}) {
        auto frame = audio;
        frame.frames = frames; frame.payloadBytes = frames * 8;
        roundTrip(frame);
    }
    for (uint64_t generation : {uint64_t{1}, sauce_obs::rawMaxGeneration}) {
        auto frame = video;
        frame.captureGeneration = frame.broadcastGeneration = generation;
        roundTrip(frame);
    }
    check(!sauce_obs::readRawFrameHeader(nullptr, 64), "null buffer accepted");
    for (size_t size : {size_t{0}, size_t{1}, size_t{63}, size_t{65}, std::numeric_limits<size_t>::max()})
        check(!sauce_obs::readRawFrameHeader(expectedVideo.data(), size), "wrong header length accepted");
    for (size_t offset : {0u, 1u, 2u, 3u, 5u, 6u, 7u, 58u, 59u, 60u, 61u, 62u, 63u}) {
        for (const auto &valid : {expectedVideo, expectedAudio}) {
            for (uint8_t bit = 1; bit; bit = static_cast<uint8_t>(bit << 1)) {
                Header bytes = valid;
                bytes[offset] ^= bit;
                reject(bytes);
            }
        }
    }
    for (const auto &valid : {expectedVideo, expectedAudio}) {
        for (uint64_t kind : {0ULL, 3ULL, 127ULL, 255ULL}) rejectField(valid, 4, 1, kind);
        for (size_t offset : {8u, 16u})
            for (uint64_t value : {uint64_t{0}, sauce_obs::rawMaxGeneration + 1, UINT64_MAX})
                rejectField(valid, offset, 8, value);
        rejectField(valid, 24, 8, 0);
        for (uint64_t value : {0ULL, 1ULL, 0xffffffffULL}) rejectField(valid, 32, 4, value);
    }
    for (uint64_t width : {0ULL, 1ULL, 3ULL, 1922ULL, 0x40000140ULL, 0xffffffffULL})
        rejectField(expectedVideo, 36, 4, width);
    for (uint64_t height : {0ULL, 1ULL, 3ULL, 1082ULL, 0x400000b4ULL, 0xffffffffULL})
        rejectField(expectedVideo, 40, 4, height);
    for (uint64_t stride : {0ULL, 1279ULL, 1281ULL, 0xffffffffULL}) rejectField(expectedVideo, 44, 4, stride);
    for (size_t offset : {48u, 52u, 56u}) rejectField(expectedVideo, offset, offset == 56 ? 2 : 4, 1);
    for (size_t offset : {36u, 40u, 44u}) rejectField(expectedAudio, offset, 4, 1);
    for (uint64_t frames : {0ULL, 4097ULL, 0x20000400ULL, 0xffffffffULL})
        rejectField(expectedAudio, 48, 4, frames);
    for (uint64_t rate : {0ULL, 44100ULL, 96000ULL, 0xffffffffULL}) rejectField(expectedAudio, 52, 4, rate);
    for (uint64_t channels : {0ULL, 1ULL, 3ULL, 0xffffULL}) rejectField(expectedAudio, 56, 2, channels);
    // Dimensions and payload must still be rejected if hostile products wrap
    // to the original valid payload in 32-bit arithmetic.
    auto overflowingVideo = video;
    overflowingVideo.width = 0x40000140; overflowingVideo.stride = 1280;
    rejectInfo(overflowingVideo);
    auto overflowingAudio = audio;
    overflowingAudio.frames = 0x20000400;
    rejectInfo(overflowingAudio);
    auto maximum = video;
    maximum.width = 1920; maximum.height = 1080;
    maximum.stride = 7680; maximum.payloadBytes = 8294400;
    roundTrip(maximum);
    check(maximum.payloadBytes == sauce_obs::rawMaxPayload, "maximum payload disagrees with maximum raster");
    auto tooLarge = sauce_obs::rawFrameHeader(maximum);
    put(tooLarge, 32, sauce_obs::rawMaxPayload + 1ULL, 4);
    reject(tooLarge);
    auto badProducer = video;
    badProducer.timestamp = 0;
    rejectInfo(badProducer);
    badProducer = audio; badProducer.channels = 1;
    rejectInfo(badProducer);
    // Input canaries detect accidental writes; a guard page catches reads
    // beyond the caller's actual 64 bytes when running without sanitizers.
    std::array<uint8_t, 96> guarded{};
    guarded.fill(0xa5);
    std::copy(expectedVideo.begin(), expectedVideo.end(), guarded.begin() + 16);
    const auto before = guarded;
    check(sauce_obs::readRawFrameHeader(guarded.data() + 16, 64).has_value(), "canary frame rejected");
    check(guarded == before, "parser modified input or surrounding canaries");
    const long page = sysconf(_SC_PAGESIZE);
    check(page >= 64, "page size unavailable");
    void *mapping = mmap(nullptr, static_cast<size_t>(page) * 2, PROT_READ | PROT_WRITE,
                         MAP_PRIVATE | MAP_ANON, -1, 0);
    check(mapping != MAP_FAILED, "guard mapping failed");
    auto *edge = static_cast<uint8_t *>(mapping) + page;
    check(mprotect(edge, static_cast<size_t>(page), PROT_NONE) == 0, "guard protection failed");
    std::copy(expectedAudio.begin(), expectedAudio.end(), edge - 64);
    check(sauce_obs::readRawFrameHeader(edge - 64, 64).has_value(), "guarded audio rejected");
    for (size_t length = 0; length < 64; ++length)
        check(!sauce_obs::readRawFrameHeader(edge - length, length), "truncated guarded input accepted");
    check(munmap(mapping, static_cast<size_t>(page) * 2) == 0, "guard mapping cleanup failed");
    check(mutations >= 250, "mutation population disappeared");
    std::printf("{\"passed\":true,\"checks\":%u,\"mutations\":%u}\n", checks, mutations);
    return 0;
}
