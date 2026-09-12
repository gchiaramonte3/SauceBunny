// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <array>
#include <cstdint>
#include <mutex>
#include <unistd.h>

namespace sauce_obs {
// stdout: kind:u8, slot:u8, generation:u64 BE, length:u32 BE, payload.
// Chunks, not a second media cache. The owner continuously demultiplexes them
// into its existing bounded rings. A broken pipe is fatal to this helper.
inline void serviceRecord(unsigned kind, unsigned slot, uint64_t generation, const void *data, size_t length) {
    static std::mutex mutex;
    std::lock_guard<std::mutex> lock(mutex);
    if (slot > 1 || kind < 1 || kind > 3 || length > 16384) std::_Exit(7);
    std::array<uint8_t,14> header{};
    header[0] = kind; header[1] = slot;
    for (unsigned n = 0; n < 8; n++) header[2+n] = generation >> (56-8*n);
    for (unsigned n = 0; n < 4; n++) header[10+n] = length >> (24-8*n);
    auto send = [](const void *buffer, size_t count) {
        auto bytes = static_cast<const uint8_t *>(buffer);
        while (count) {
            const auto written = write(STDOUT_FILENO, bytes, count);
            if (written <= 0) std::_Exit(7);
            count -= written; bytes += written;
        }
    };
    send(header.data(), header.size()); send(data, length);
}
} // namespace sauce_obs
