// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include "capture-config.hpp"
#include <atomic>
#include <deque>
#include <mutex>
#include <thread>

namespace sauce_obs {
struct StartCapture {
    unsigned slot = 0;
    uint64_t generation = 0;
    WindowIdentity identity;
    Crop crop;
};
// Newline JSON start/stop commands plus P/Q lines. Strictly bounded, local
// owner pipe only. Stops are latched even while the OBS thread is starting.
class ServiceControl final {
public:
    ServiceControl();
    ~ServiceControl();
    bool stopping() const { return stopping_.load(); }
    bool cancelled(unsigned slot, uint64_t generation) const;
    std::optional<StartCapture> next();
private:
    bool accept(const std::string &line);
    void watch();
    std::mutex mutex_;
    std::deque<StartCapture> pending_;
    std::atomic<uint64_t> cancelled_[2]{};
    uint64_t last_[2]{};
    std::atomic<bool> stopping_{false}, finished_{false};
    const int parent_;
    std::thread thread_;
};
} // namespace sauce_obs
