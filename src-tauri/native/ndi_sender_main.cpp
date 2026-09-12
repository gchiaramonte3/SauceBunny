// SPDX-License-Identifier: MIT
// Explicit standalone sender. Compile tests with a fake SDK factory; never
// start the real runtime from tests, app discovery, settings, or Preview.
#include "ndi_sender_sdk.hpp"
#include <array>
#include <atomic>
#include <cerrno>
#include <charconv>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstring>
#include <fcntl.h>
#include <mutex>
#include <poll.h>
#include <string_view>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>

namespace {
using Clock = std::chrono::steady_clock;
std::atomic<bool> stopped{false};
static_assert(std::atomic<bool>::is_always_lock_free);

class OwnerWatchdog {
    const pid_t owner_;
    std::atomic<bool> finished_{false}, lost_{false};
    std::mutex mutex_;
    std::condition_variable wake_;
    std::thread thread_;
    void run() {
        std::unique_lock<std::mutex> lock(mutex_);
        while (!finished_.load(std::memory_order_acquire)) {
            if (getppid() != owner_) {
                lost_.store(true, std::memory_order_release);
                stopped.store(true, std::memory_order_relaxed);
                // Give the ordinary reader/drain/destructor path time to exit.
                // Foreign SDK code may never return. In that case only process
                // exit can release its state safely; never free it on this thread.
                if (!wake_.wait_for(lock, std::chrono::milliseconds(2500), [this] {
                    return finished_.load(std::memory_order_acquire);
                })) _exit(7);
                return;
            }
            wake_.wait_for(lock, std::chrono::milliseconds(20), [this] {
                return finished_.load(std::memory_order_acquire);
            });
        }
    }
    void join() {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            finished_.store(true, std::memory_order_release);
        }
        wake_.notify_one();
        if (thread_.joinable()) thread_.join();
    }
public:
    explicit OwnerWatchdog(pid_t owner) : owner_(owner) {}
    bool start() noexcept {
        try { thread_ = std::thread([this] { run(); }); return true; }
        catch (...) { return false; }
    }
    ~OwnerWatchdog() { join(); }
    int finish(int result) {
        join();
        return lost_.load(std::memory_order_acquire) || getppid() != owner_ ? 7 : result;
    }
};

void on_signal(int) { stopped.store(true, std::memory_order_relaxed); }

bool install_signals() {
    struct sigaction action{};
    action.sa_handler = on_signal;
    if (sigemptyset(&action.sa_mask) != 0 || sigaction(SIGTERM, &action, nullptr) != 0 ||
        sigaction(SIGINT, &action, nullptr) != 0) return false;
    // A lost status reader is an I/O failure, not an asynchronous process exit.
    action.sa_handler = SIG_IGN;
    return sigaction(SIGPIPE, &action, nullptr) == 0;
}

bool nonblocking(int fd) {
    const int flags = fcntl(fd, F_GETFL);
    return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

bool emit(const char* line) {
    const size_t length = std::strlen(line);
    // All records are fixed literals below 100 bytes. A clogged status channel
    // must not hold up raw input, cancellation, or destruction of the sender.
    for (unsigned tries = 0; tries < 3; ++tries) {
        const ssize_t count = write(STDOUT_FILENO, line, length);
        if (count == static_cast<ssize_t>(length)) return true;
        if (count < 0 && errno == EINTR) continue;
        return false;
    }
    return false;
}

bool fail(const char* reason) {
    // The caller passes only the closed enum-like set below, never user data.
    std::array<char, 100> line{};
    constexpr std::string_view prefix = "{\"state\":\"failed\",\"reason\":\"";
    constexpr std::string_view suffix = "\"}\n";
    const size_t size = std::strlen(reason);
    if (prefix.size() + size + suffix.size() >= line.size()) return false;
    std::memcpy(line.data(), prefix.data(), prefix.size());
    std::memcpy(line.data() + prefix.size(), reason, size);
    std::memcpy(line.data() + prefix.size() + size, suffix.data(), suffix.size());
    return emit(line.data());
}

struct Options {
    const char* runtime = nullptr;
    sauce_ndi::Expected expected{};
};

bool generation(const char* value, uint64_t& target) {
    const size_t length = strnlen(value, 17);
    if (!length || length > 16 || value[0] < '1' || value[0] > '9') return false;
    for (size_t i = 1; i < length; ++i) if (value[i] < '0' || value[i] > '9') return false;
    const auto result = std::from_chars(value, value + length, target);
    return result.ec == std::errc{} && result.ptr == value + length &&
        target > 0 && target <= sauce_obs::rawMaxGeneration;
}

bool options(int argc, char** argv, Options& result) {
    if (argc != 8) return false;
    bool broadcast = false, capture = false, attempt = false;
    for (int index = 1; index < argc; ++index) {
        const std::string_view option(argv[index]);
        if (option == "--broadcast") {
            if (broadcast) return false;
            broadcast = true;
        } else {
            if (++index == argc) return false;
            if (option == "--runtime") {
                if (result.runtime || argv[index][0] != '/' || strnlen(argv[index], 4097) > 4096) return false;
                result.runtime = argv[index];
            } else if (option == "--capture") {
                if (capture || !generation(argv[index], result.expected.capture)) return false;
                capture = true;
            } else if (option == "--attempt") {
                if (attempt || !generation(argv[index], result.expected.broadcast)) return false;
                attempt = true;
            } else return false;
        }
    }
    return broadcast && result.runtime && capture && attempt;
}

bool valid_input() {
    struct stat info{};
    const int flags = fcntl(STDIN_FILENO, F_GETFL);
    return flags >= 0 && (flags & O_ACCMODE) == O_RDONLY &&
        fstat(STDIN_FILENO, &info) == 0 && S_ISFIFO(info.st_mode);
}

enum class Drain { Eof, Timeout, Failed };
Drain drain() {
    const auto deadline = Clock::now() + std::chrono::seconds(2);
    std::array<uint8_t, 65536> discarded{};
    while (Clock::now() < deadline) {
        const ssize_t count = read(STDIN_FILENO, discarded.data(), discarded.size());
        if (count == 0) return Drain::Eof;
        if (count > 0 || (count < 0 && errno == EINTR)) continue;
        if (errno != EAGAIN && errno != EWOULDBLOCK) return Drain::Failed;
        pollfd pending{STDIN_FILENO, POLLIN, 0};
        const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count();
        if (remaining <= 0) return Drain::Timeout;
        const int ready = poll(&pending, 1, static_cast<int>(remaining < 20 ? remaining : 20));
        if (ready < 0 && errno != EINTR) return Drain::Failed;
        if (ready > 0 && (pending.revents & POLLNVAL)) return Drain::Failed;
        // POLLHUP still requires read()==0; buffered media can remain after it.
    }
    return Drain::Timeout;
}

class ObservedSink final : public sauce_ndi::Sink {
    sauce_ndi::Sink& sink_;
    bool video_ = false, audio_ = false, live_ = false;
    bool accepted(bool picture) {
        if (picture) video_ = true; else audio_ = true;
        if (!live_ && video_ && audio_ && !stopped.load(std::memory_order_relaxed)) {
            live_ = true;
            if (!emit("{\"state\":\"live\"}\n")) { output_failed = true; return false; }
        }
        return true;
    }
public:
    bool output_failed = false;
    bool cancelled_before_submit = false;
    explicit ObservedSink(sauce_ndi::Sink& sink) : sink_(sink) {}
    bool video(const sauce_obs::RawFrameInfo& info, const uint8_t* pixels) override {
        if (stopped.load(std::memory_order_relaxed)) { cancelled_before_submit = true; return false; }
        return sink_.video(info, pixels) && accepted(true);
    }
    bool audio(const sauce_obs::RawFrameInfo& info, const float* planar) override {
        if (stopped.load(std::memory_order_relaxed)) { cancelled_before_submit = true; return false; }
        return sink_.audio(info, planar) && accepted(false);
    }
};

const char* failure_reason(sauce_ndi::Result result) {
    using sauce_ndi::Result;
    switch (result) {
        case Result::InvalidInput: return "invalid_input";
        case Result::TruncatedInput: return "truncated_input";
        case Result::ReadTimeout: return "read_timeout";
        case Result::ReadFailed: return "read_failed";
        case Result::SinkFailed: return "sink_failed";
        case Result::Eof: case Result::Cancelled: return nullptr;
    }
    return "read_failed";
}
int send(const Options& requested) {
    if (stopped.load(std::memory_order_relaxed)) {
        emit("{\"state\":\"stopping\"}\n");
        if (drain() == Drain::Eof) return 0;
        fail("drain_timeout"); return 5;
    }
    auto sink = sauce_ndi::create_sdk_sink(requested.runtime);
    if (!sink) {
        fail("sdk_unavailable");
        emit("{\"state\":\"stopping\"}\n");
        const Drain drained = drain();
        if (drained == Drain::Eof) return 3;
        fail(drained == Drain::Timeout ? "drain_timeout" : "read_failed");
        return 5;
    }

    sauce_ndi::Result result = sauce_ndi::Result::Cancelled;
    int exit_code = 0;
    if (!stopped.load(std::memory_order_relaxed)) {
        if (!emit("{\"state\":\"ready\"}\n")) {
            exit_code = 6;
        } else {
            ObservedSink observed(*sink);
            try { result = sauce_ndi::consume(STDIN_FILENO, requested.expected, observed, stopped); }
            catch (...) { result = sauce_ndi::Result::ReadFailed; }
            if (observed.cancelled_before_submit) result = sauce_ndi::Result::Cancelled;
            if (observed.output_failed) exit_code = 6;
        }
    }
    if (const char* reason = failure_reason(result)) {
        fail(reason);
        if (!exit_code) exit_code = 4;
    }
    if (result != sauce_ndi::Result::Eof) {
        emit("{\"state\":\"stopping\"}\n");
        const Drain drained = drain();
        if (drained != Drain::Eof) {
            fail(drained == Drain::Timeout ? "drain_timeout" : "read_failed");
            exit_code = 5;
        }
    }
    sink.reset();
    // No successful terminal line is emitted. Only exit and external reap
    // prove that a potentially blocked SDK destructor has actually returned.
    return exit_code;
}
} // namespace

int main(int argc, char** argv) {
    const pid_t owner = getppid();
    // No worker thread or SDK work precedes explicit broadcast/input validation.
    if (!install_signals() || !nonblocking(STDOUT_FILENO)) return 6;
    Options requested;
    if (!options(argc, argv, requested)) { fail("usage"); return 2; }
    if (!valid_input() || !nonblocking(STDIN_FILENO)) { fail("invalid_input"); return 2; }
    if (owner <= 1 || getppid() != owner) return 7;
    OwnerWatchdog watchdog(owner);
    if (!watchdog.start()) { fail("read_failed"); return 6; }
    const int result = send(requested);
    // SDK destruction completes inside send, while the watchdog is still armed.
    // Owner loss is a failed outcome even when graceful EOF cleanup succeeded.
    return watchdog.finish(result);
}
