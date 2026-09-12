// SPDX-License-Identifier: MIT
// Generated parent/child lifecycle only. Argument must be the fake-SDK sender.
// A kernel process watch binds to the live child before its parent exits; never
// signal an orphan by a saved PID that another process could subsequently reuse.
#include "../../obs-sidecar/raw-frame.hpp"
#include <array>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <string>
#include <sys/event.h>
#include <sys/wait.h>
#include <unistd.h>
#include <vector>

namespace {
using Clock = std::chrono::steady_clock;
struct Pipe {
    int read = -1, write = -1;
    Pipe() {
        int values[2];
        if (pipe(values) != 0) { std::perror("pipe"); std::exit(1); }
        read = values[0]; write = values[1];
    }
    void closeRead() { if (read >= 0) close(read); read = -1; }
    void closeWrite() { if (write >= 0) close(write); write = -1; }
    ~Pipe() { closeRead(); closeWrite(); }
};
bool writeAll(int fd, const void* data, size_t size) {
    const auto* bytes = static_cast<const uint8_t*>(data);
    while (size) {
        const ssize_t count = write(fd, bytes, size);
        if (count > 0) { bytes += count; size -= size_t(count); }
        else if (count < 0 && errno == EINTR) continue;
        else return false;
    }
    return true;
}
std::vector<uint8_t> frame(bool audio) {
    sauce_obs::RawFrameInfo info;
    info.kind = audio ? 2 : 1;
    info.captureGeneration = 7; info.broadcastGeneration = 9; info.timestamp = 1000000000;
    info.payloadBytes = 16;
    if (audio) { info.frames = 2; info.sampleRate = 48000; info.channels = 2; }
    else { info.width = 2; info.height = 2; info.stride = 8; }
    const auto header = sauce_obs::rawFrameHeader(info);
    std::vector<uint8_t> bytes(header.begin(), header.end());
    bytes.resize(80);
    if (audio) {
        const std::array<float, 4> samples{{0.25f, 0.5f, -0.25f, -0.5f}};
        std::memcpy(bytes.data() + 64, samples.data(), 16);
    }
    return bytes;
}
bool awaitToken(int fd, std::string& output, const char* token) {
    const auto deadline = Clock::now() + std::chrono::seconds(2);
    std::array<char, 1024> bytes{};
    while (Clock::now() < deadline && output.size() <= 8192) {
        if (output.find(token) != std::string::npos) return true;
        pollfd pending{fd, POLLIN, 0};
        const int ready = poll(&pending, 1, 20);
        if (ready < 0 && errno == EINTR) continue;
        if (ready < 0) return false;
        if (!ready) continue;
        const ssize_t count = read(fd, bytes.data(), bytes.size());
        if (count > 0) output.append(bytes.data(), size_t(count));
        else if (count == 0 || errno != EINTR) return false;
    }
    return false;
}
bool eventWithin(int queue, struct kevent& event, int seconds) {
    const auto deadline = Clock::now() + std::chrono::seconds(seconds);
    while (Clock::now() < deadline) {
        const auto remaining = std::chrono::duration_cast<std::chrono::nanoseconds>(deadline - Clock::now()).count();
        if (remaining <= 0) return false;
        timespec wait{time_t(remaining / 1000000000), long(remaining % 1000000000)};
        const int count = kevent(queue, nullptr, 0, &event, 1, &wait);
        if (count == 1) return true;
        if (count == 0 || errno != EINTR) return false;
    }
    return false;
}
bool pipeEof(int fd, int milliseconds) {
    pollfd pending{fd, POLLIN, 0};
    if (poll(&pending, 1, milliseconds) <= 0) return false;
    char byte;
    return read(fd, &byte, 1) == 0;
}

bool ownerCase(const char* binary, const char* mode, const char* entered, bool closeOnLoss) {
    Pipe media, output, lifetime, identity, release;
    const pid_t owner = fork();
    if (owner < 0) return false;
    if (owner == 0) {
        alarm(10); // Independent cleanup if the test driver itself fails.
        const pid_t child = fork();
        if (child == 0) {
            if (dup2(media.read, 0) < 0 || dup2(output.write, 1) < 0 ||
                dup2(output.write, 2) < 0 || dup2(lifetime.write, 198) < 0) _exit(90);
            for (int fd = 3; fd < 256; ++fd) if (fd != 198) close(fd);
            // alarm survives exec; SIGALRM remains default in the fake sender.
            // A broken watchdog thus self-terminates without an orphan-PID kill.
            alarm(8);
            if (setenv("SAUCE_NDI_FAKE_MODE", mode, 1) != 0) _exit(91);
            execl(binary, binary, "--broadcast", "--runtime", binary,
                  "--capture", "7", "--attempt", "9", static_cast<char*>(nullptr));
            _exit(92);
        }
        if (child < 0) _exit(93);
        for (int fd = 3; fd < 256; ++fd)
            if (fd != identity.write && fd != release.read) close(fd);
        if (!writeAll(identity.write, &child, sizeof(child))) _exit(94);
        close(identity.write);
        char byte;
        while (read(release.read, &byte, 1) < 0 && errno == EINTR) {}
        _exit(0); // The actual parent is gone, not merely asked to cancel.
    }
    media.closeRead(); output.closeWrite(); lifetime.closeWrite();
    identity.closeWrite(); release.closeRead();
    pid_t sender = -1;
    pollfd identityReady{identity.read, POLLIN, 0};
    bool okay = poll(&identityReady, 1, 2000) > 0 && read(identity.read, &sender, sizeof(sender)) == sizeof(sender) && sender > 1;
    const int queue = kqueue();
    struct kevent watch{}, exited{};
    EV_SET(&watch, uintptr_t(sender), EVFILT_PROC, EV_ADD | EV_ONESHOT, NOTE_EXIT | NOTE_EXITSTATUS, 0, nullptr);
    okay = okay && queue >= 0 && kevent(queue, &watch, 1, nullptr, 0, nullptr) == 0;
    if (okay && std::strcmp(mode, "block_create") != 0) {
        const auto picture = frame(false), sound = frame(true);
        okay = writeAll(media.write, picture.data(), picture.size()) && writeAll(media.write, sound.data(), sound.size());
    }
    if (std::strcmp(mode, "block_destroy") == 0) media.closeWrite();
    std::string diagnostics;
    if (okay) okay = awaitToken(output.read, diagnostics, entered);
    const auto lostAt = Clock::now();
    if (okay) okay = writeAll(release.write, "x", 1);
    release.closeWrite();
    // owner is our unreaped child, so its PID cannot have been reused here.
    if (!okay) kill(owner, SIGKILL);
    int ownerStatus = 0;
    pid_t reaped;
    do { reaped = waitpid(owner, &ownerStatus, 0); } while (reaped < 0 && errno == EINTR);
    okay = okay && reaped == owner && WIFEXITED(ownerStatus) && WEXITSTATUS(ownerStatus) == 0;
    if (closeOnLoss) media.closeWrite();
    bool observed = queue >= 0 && eventWithin(queue, exited, 4);
    int senderStatus = static_cast<int>(exited.data);
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - lostAt).count();
    okay = okay && observed && (exited.fflags & NOTE_EXIT) &&
        WIFEXITED(senderStatus) && WEXITSTATUS(senderStatus) == 7 && elapsed < 3500;
    if (closeOnLoss) okay = okay && elapsed < 500; // Normal cleanup joins promptly.
    if (!observed && queue >= 0) observed = eventWithin(queue, exited, 6); // Wait for regression-cleanup alarm.
    media.closeWrite();
    const bool eof = pipeEof(lifetime.read, observed ? 500 : 10000);
    senderStatus = static_cast<int>(exited.data);
    okay = okay && observed && eof;
    if (queue >= 0) close(queue);
    std::printf("owner loss: %s, parent reaped=%d, sender exit=%d, lifetime EOF=%d, elapsed=%lldms\n",
        mode, reaped == owner, observed && WIFEXITED(senderStatus) ? WEXITSTATUS(senderStatus) : -1,
        eof, static_cast<long long>(elapsed));
    if (!okay) std::fprintf(stderr, "owner-loss failure diagnostics: %s\n", diagnostics.c_str());
    return okay;
}
} // namespace

int main(int argc, char** argv) {
    if (argc != 2 || argv[1][0] != '/') return 2;
    signal(SIGPIPE, SIG_IGN);
    bool passed = true;
    for (const auto& scenario : std::array<std::pair<const char*, const char*>, 4>{{
        {"block_create", "\"fake\":\"factory\""}, {"block_video", "\"fake\":\"video\""},
        {"block_audio", "\"fake\":\"audio\""}, {"block_destroy", "\"fake\":\"destroy_enter\""}
    }}) passed = ownerCase(argv[1], scenario.first, scenario.second, false) && passed;
    passed = ownerCase(argv[1], "normal", "\"state\":\"live\"", true) && passed;
    return passed ? 0 : 1;
}
