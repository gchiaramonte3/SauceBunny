// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <poll.h>
#include <thread>
#include <unistd.h>

namespace sauce_obs {
// The app owns stdin. P = heartbeat; S or EOF = stop. No credentials, paths,
// arbitrary commands, or source changes are accepted over this channel.
// This thread is independent of OBS's main/runloop/output threads: vendor
// shutdown or a blocked encoder write cannot keep capture alive indefinitely.
class OwnerWatchdog {
public:
    OwnerWatchdog() : parent_(getppid()), thread_([this] { watch(); }) {}
    ~OwnerWatchdog() { finished_ = true; thread_.join(); }
    OwnerWatchdog(const OwnerWatchdog &) = delete;
    OwnerWatchdog &operator=(const OwnerWatchdog &) = delete;
    bool stopping() const { return stopping_.load(); }
private:
    const pid_t parent_;
    std::atomic<bool> stopping_{false}, finished_{false};
    std::thread thread_;
    void watch() {
        using Clock = std::chrono::steady_clock;
        auto heartbeat = Clock::now();
        auto stopTime = heartbeat;
        while (!finished_) {
            if (!stopping_) {
                pollfd input{STDIN_FILENO, POLLIN, 0};
                const int ready = poll(&input, 1, 50);
                if (ready > 0) {
                    char bytes[32];
                    const auto count = read(STDIN_FILENO, bytes, sizeof(bytes));
                    if (count <= 0) stopping_ = true;
                    for (ssize_t i = 0; i < count; ++i) {
                        if (bytes[i] == 'P') heartbeat = Clock::now();
                        else stopping_ = true;
                    }
                } else if (ready < 0) {
                    stopping_ = true;
                }
                if (getppid() != parent_ || parent_ <= 1 || Clock::now() - heartbeat > std::chrono::seconds(2))
                    stopping_ = true;
                if (stopping_) stopTime = Clock::now();
            } else {
                if (Clock::now() - stopTime > std::chrono::seconds(3)) std::_Exit(6);
                std::this_thread::sleep_for(std::chrono::milliseconds(25));
            }
        }
    }
};
} // namespace sauce_obs
