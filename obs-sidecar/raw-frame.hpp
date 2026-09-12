// SPDX-License-Identifier: MIT
// Private process-boundary framing. No OBS or NDI types, source names or paths.
#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>

namespace sauce_obs {
constexpr size_t rawHeaderSize = 64;
constexpr uint64_t rawMaxGeneration = 9007199254740991ULL;
constexpr uint32_t rawMaxPayload = 1920 * 1080 * 4;
struct RawFrameInfo {
    uint8_t kind = 0; // 1: tightly packed BGRA; 2: left then right float32 LE.
    uint64_t captureGeneration = 0, broadcastGeneration = 0, timestamp = 0;
    uint32_t payloadBytes = 0, width = 0, height = 0, stride = 0;
    uint32_t frames = 0, sampleRate = 0;
    uint16_t channels = 0;
};
inline bool rawFrameValid(const RawFrameInfo &f) {
    if (!f.captureGeneration || f.captureGeneration > rawMaxGeneration ||
        !f.broadcastGeneration || f.broadcastGeneration > rawMaxGeneration || !f.timestamp) return false;
    if (f.kind == 1) {
        return f.width >= 2 && f.width <= 1920 && !(f.width % 2) &&
            f.height >= 2 && f.height <= 1080 && !(f.height % 2) &&
            f.stride == f.width * 4 && f.payloadBytes == f.stride * f.height &&
            !f.frames && !f.sampleRate && !f.channels;
    }
    return f.kind == 2 && !f.width && !f.height && !f.stride &&
        f.frames > 0 && f.frames <= 4096 && f.sampleRate == 48000 &&
        f.channels == 2 && f.payloadBytes == f.frames * 2 * 4;
}
inline std::array<uint8_t,rawHeaderSize> rawFrameHeader(const RawFrameInfo &f) {
    std::array<uint8_t,rawHeaderSize> bytes{};
    // Invalid callers produce an invalid magic, never a plausible partial frame.
    if (!rawFrameValid(f)) return bytes;
    bytes[0] = 'S'; bytes[1] = 'B'; bytes[2] = 'R'; bytes[3] = '1'; bytes[4] = f.kind;
    auto put = [&](size_t at, uint64_t value, unsigned size) {
        for (unsigned n = 0; n < size; n++) bytes[at+n] = static_cast<uint8_t>(value >> (8*(size-1-n)));
    };
    put(8,f.captureGeneration,8); put(16,f.broadcastGeneration,8); put(24,f.timestamp,8);
    put(32,f.payloadBytes,4); put(36,f.width,4); put(40,f.height,4); put(44,f.stride,4);
    put(48,f.frames,4); put(52,f.sampleRate,4); put(56,f.channels,2);
    // Reserved bytes remain zero. A future layout must use a new magic/version.
    return bytes;
}
inline std::optional<RawFrameInfo> readRawFrameHeader(const uint8_t *bytes, size_t size) {
    if (!bytes || size != rawHeaderSize || bytes[0] != 'S' || bytes[1] != 'B' ||
        bytes[2] != 'R' || bytes[3] != '1') return std::nullopt;
    for (size_t n : {5,6,7,58,59,60,61,62,63}) if (bytes[n]) return std::nullopt;
    auto get = [&](size_t at, unsigned count) {
        uint64_t value = 0;
        for (unsigned n = 0; n < count; n++) value = (value << 8) | bytes[at+n];
        return value;
    };
    RawFrameInfo result;
    result.kind = bytes[4];
    result.captureGeneration = get(8,8); result.broadcastGeneration = get(16,8); result.timestamp = get(24,8);
    result.payloadBytes = get(32,4); result.width = get(36,4); result.height = get(40,4); result.stride = get(44,4);
    result.frames = get(48,4); result.sampleRate = get(52,4); result.channels = get(56,2);
    return rawFrameValid(result) ? std::optional<RawFrameInfo>(result) : std::nullopt;
}
} // namespace sauce_obs
