// SPDX-License-Identifier: MIT
#pragma once
#include "../../obs-sidecar/raw-frame.hpp"
#include <atomic>
#include <cstdint>

namespace sauce_ndi {
struct Expected { uint64_t capture = 0, broadcast = 0; };
enum class Result {
    Eof, Cancelled, InvalidInput, TruncatedInput, ReadTimeout, ReadFailed, SinkFailed
};

// Synchronous calls: a sink may borrow these buffers only until it returns.
// No OBS or NDI runtime types cross this pure, independently testable seam.
struct Sink {
    virtual ~Sink() = default;
    virtual bool video(const sauce_obs::RawFrameInfo &, const uint8_t *) = 0;
    virtual bool audio(const sauce_obs::RawFrameInfo &, const float *planar) = 0;
};

// Borrows a read-only FIFO; the caller retains/ultimately closes its fd. An
// internal CLOEXEC duplicate is closed on every exit. O_NONBLOCK is shared with
// the original open-file description, so this must be a private attempt pipe,
// with no other reader. No byte is consumed before descriptor/tuple validation.
// Both tracks must arrive within 3 s; afterward neither may stall for 1 s.
// Waits also cap each entire partial record at 500 ms from its first byte
// (not renewed by progress), and source clocks may differ by at most 1 s.
// Cancellation is checked at least every 20 ms outside synchronous sink calls. A supervisor
// must terminate the separate sender process if an SDK call/destructor stalls.
// Any error is terminal: no resynchronization or same-pipe retry is supported.
Result consume(int fd, Expected expected, Sink &sink, const std::atomic<bool> &stopped);
} // namespace sauce_ndi
