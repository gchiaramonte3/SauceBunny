// SPDX-License-Identifier: MIT
// Real adapter + official SDK ABI, but only the generated fake dylib is loaded.
#include "ndi_sender_sdk.hpp"
#include <array>
#include <cstdio>
#include <cstdlib>
#include <dlfcn.h>

namespace {
unsigned checks = 0;
void require(bool okay) { ++checks; if (!okay) { std::fprintf(stderr, "SDK adapter check %u failed\n", checks); std::exit(1); } }
} // namespace
int main(int argc, char** argv) {
    require(argc == 2 && argv[1][0] == '/');
    void* fixture = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    require(fixture != nullptr);
    auto reset = reinterpret_cast<void (*)(int)>(dlsym(fixture, "sauce_ndi_fixture_reset"));
    auto count = reinterpret_cast<unsigned (*)(unsigned)>(dlsym(fixture, "sauce_ndi_fixture_count"));
    require(reset && count);
    reset(0);
    require(!sauce_ndi::create_sdk_sink(nullptr));
    require(!sauce_ndi::create_sdk_sink("relative-runtime.dylib"));
    require(count(0) == 0);
    auto sink = sauce_ndi::create_sdk_sink(argv[1]);
    require(bool(sink) && count(0) == 1 && count(2) == 1);
    sauce_obs::RawFrameInfo picture{};
    picture.kind = 1; picture.captureGeneration = 1; picture.broadcastGeneration = 2;
    picture.timestamp = 123456789; picture.width = 4; picture.height = 2;
    picture.stride = 16; picture.payloadBytes = 32;
    std::array<uint8_t, 32> pixels{};
    for (unsigned n = 0; n < pixels.size(); ++n) pixels[n] = n;
    require(sink->video(picture, pixels.data()));
    require(!sink->video(picture, nullptr));
    auto invalid = picture; invalid.stride = 1;
    require(!sink->video(invalid, pixels.data()));
    sauce_obs::RawFrameInfo sound{};
    sound.kind = 2; sound.captureGeneration = 1; sound.broadcastGeneration = 2;
    sound.timestamp = picture.timestamp; sound.frames = 3; sound.sampleRate = 48000;
    sound.channels = 2; sound.payloadBytes = 24;
    std::array<float, 6> samples{};
    for (unsigned n = 0; n < samples.size(); ++n) samples[n] = float(n + 1) / 8;
    require(sink->audio(sound, samples.data()));
    require(!sink->audio(sound, nullptr));
    require(!sink->video(sound, pixels.data()));
    require(!sink->audio(picture, samples.data()));
    require(count(4) == 1 && count(5) == 1 && count(6) == 0);
    sink.reset();
    require(count(1) == 1 && count(3) == 1 && count(6) == 0);
    for (int mode = 1; mode <= 4; ++mode) {
        reset(mode);
        require(!sauce_ndi::create_sdk_sink(argv[1]));
        require(count(0) == (mode <= 2 ? 1U : 0U));
        require(count(1) == (mode == 2 ? 1U : 0U));
        require(count(2) == (mode == 2 ? 1U : 0U));
        require(count(3) == 0 && count(4) == 0 && count(5) == 0 && count(6) == 0);
    }
    require(dlclose(fixture) == 0);
    std::printf("NDI SDK adapter: %u checks passed against fake runtime; no network\n", checks);
}
