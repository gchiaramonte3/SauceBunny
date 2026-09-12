// SPDX-License-Identifier: GPL-2.0-or-later
// Private inherited datagrams only. No paths, discovery, or media payloads.
#pragma once
#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <optional>
#include <vector>

namespace sauce_obs {
enum class RawOp : uint8_t { Hello = 1, Start = 2, Stop = 3, Started = 4, Stopped = 5, Failed = 6, Rejected = 7 };
enum class RawReason : uint16_t {
    None = 0, Unavailable = 1, Stale = 2, Busy = 3, InvalidDescriptor = 4,
    AttachFailed = 5, WriterFailed = 6, SourceStopped = 7, Cancelled = 8,
};
struct RawMessage {
    RawOp op = RawOp::Hello;
    unsigned slot = 0;
    uint64_t capture = 0, broadcast = 0;
    RawReason reason = RawReason::None;
};
constexpr size_t rawControlSize = 32;
std::array<uint8_t, rawControlSize> rawControlBytes(const RawMessage &message);
std::optional<RawMessage> readRawControlBytes(const uint8_t *bytes, size_t length);

class RawDescriptor final {
public:
    explicit RawDescriptor(int descriptor = -1) : descriptor_(descriptor) {}
    ~RawDescriptor();
    RawDescriptor(RawDescriptor &&other) noexcept;
    RawDescriptor &operator=(RawDescriptor &&other) noexcept;
    RawDescriptor(const RawDescriptor &) = delete;
    RawDescriptor &operator=(const RawDescriptor &) = delete;
    int get() const { return descriptor_; }
    void reset();
private:
    int descriptor_;
};
struct RawRequest { RawMessage message; RawDescriptor descriptor; };

// All methods run on the OBS engine thread. poll() processes at most four
// datagrams, and replies retry from a bounded queue for at most one second.
// The explicit constructor takes ownership of a descriptor > STDERR_FILENO.
// The default constructor reads only SAUCE_OBS_RAW_CONTROL_FD; absence is inert.
class RawControl final {
public:
    RawControl();
    explicit RawControl(int inheritedDescriptor);
    bool enabled() const { return descriptor_.get() >= 0 && !failed_; }
    bool failed() const { return failed_; }
    std::vector<RawRequest> poll();
    void reply(RawMessage message);
    std::optional<RawMessage> terminal(unsigned slot, uint64_t capture, uint64_t broadcast) const;
private:
    struct Pending { RawMessage message; std::chrono::steady_clock::time_point queued; };
    void initialize(int inheritedDescriptor);
    void fail();
    void flush();
    RawDescriptor descriptor_;
    bool failed_ = false;
    std::deque<Pending> pending_;
    std::array<std::optional<RawMessage>, 2> terminal_;
};
} // namespace sauce_obs
