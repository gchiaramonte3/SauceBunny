// SPDX-License-Identifier: GPL-2.0-or-later
#include "raw-control.hpp"
#include "raw-frame.hpp"
#include <algorithm>
#include <cerrno>
#include <climits>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

namespace sauce_obs {
namespace {
// Darwin can install SCM_RIGHTS descriptors that MSG_CTRUNC does not disclose.
// Avoid truncation: sockargs caps accepted control at MCLBYTES (2048), and its
// LP64 int-to-pointer expansion further limits rights to 254 on this platform.
// This fixed buffer covers the entire accepted control, with 2x margin.
// https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/kern/uipc_syscalls.c
// https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/arm/param.h
constexpr size_t ancillaryCapacity = 4096;
bool valid(const RawMessage &m) {
    const auto op = static_cast<unsigned>(m.op);
    const auto reason = static_cast<unsigned>(m.reason);
    if (op < 1 || op > 7 || m.slot > 1 || reason > 8) return false;
    if (m.op == RawOp::Hello) return m.slot == 0 && !m.capture && !m.broadcast && reason == 0;
    if (!m.capture || m.capture > rawMaxGeneration || !m.broadcast || m.broadcast > rawMaxGeneration) return false;
    if ((m.op == RawOp::Failed || m.op == RawOp::Rejected) && reason == 0) return false;
    return (m.op != RawOp::Start && m.op != RawOp::Stop && m.op != RawOp::Started) || reason == 0;
}
}
RawDescriptor::~RawDescriptor() { reset(); }
RawDescriptor::RawDescriptor(RawDescriptor &&other) noexcept : descriptor_(other.descriptor_) { other.descriptor_ = -1; }
RawDescriptor &RawDescriptor::operator=(RawDescriptor &&other) noexcept {
    if (this != &other) { reset(); descriptor_ = other.descriptor_; other.descriptor_ = -1; }
    return *this;
}
void RawDescriptor::reset() { if (descriptor_ >= 0) close(descriptor_); descriptor_ = -1; }

std::array<uint8_t, rawControlSize> rawControlBytes(const RawMessage &m) {
    std::array<uint8_t, rawControlSize> bytes{};
    if (!valid(m)) return bytes;
    bytes[0] = 'S'; bytes[1] = 'B'; bytes[2] = 'C'; bytes[3] = '1';
    bytes[4] = static_cast<uint8_t>(m.op); bytes[5] = static_cast<uint8_t>(m.slot);
    const auto reason = static_cast<uint16_t>(m.reason);
    bytes[6] = static_cast<uint8_t>(reason >> 8); bytes[7] = static_cast<uint8_t>(reason);
    for (unsigned n = 0; n < 8; ++n) {
        bytes[8 + n] = static_cast<uint8_t>(m.capture >> (56 - 8 * n));
        bytes[16 + n] = static_cast<uint8_t>(m.broadcast >> (56 - 8 * n));
    }
    return bytes;
}
std::optional<RawMessage> readRawControlBytes(const uint8_t *bytes, size_t length) {
    if (!bytes || length != rawControlSize || std::memcmp(bytes, "SBC1", 4) != 0) return std::nullopt;
    for (size_t i = 24; i < rawControlSize; ++i) if (bytes[i]) return std::nullopt;
    RawMessage m;
    m.op = static_cast<RawOp>(bytes[4]); m.slot = bytes[5];
    m.reason = static_cast<RawReason>((static_cast<unsigned>(bytes[6]) << 8) | bytes[7]);
    for (unsigned n = 0; n < 8; ++n) { m.capture = (m.capture << 8) | bytes[8 + n]; m.broadcast = (m.broadcast << 8) | bytes[16 + n]; }
    return valid(m) ? std::optional<RawMessage>(m) : std::nullopt;
}
RawControl::RawControl() {
    const char *text = std::getenv("SAUCE_OBS_RAW_CONTROL_FD");
    if (!text) return;
    if (!*text) { failed_ = true; return; }
    uint64_t descriptor = 0;
    for (const char *p = text; *p; ++p) {
        if (*p < '0' || *p > '9' || descriptor > (INT_MAX - static_cast<unsigned>(*p - '0')) / 10u) {
            failed_ = true; return;
        }
        descriptor = descriptor * 10 + static_cast<unsigned>(*p - '0');
    }
    initialize(static_cast<int>(descriptor));
}
RawControl::RawControl(int inheritedDescriptor) { initialize(inheritedDescriptor); }
void RawControl::initialize(int inheritedDescriptor) {
    // A malformed optional value must never close the existing stdio protocol.
    if (inheritedDescriptor <= STDERR_FILENO) { failed_ = true; return; }
    descriptor_ = RawDescriptor(inheritedDescriptor);
    int type = 0; socklen_t typeLength = sizeof(type);
    sockaddr_storage local{}, peer{}; socklen_t localLength = sizeof(local), peerLength = sizeof(peer);
    const int flags = fcntl(inheritedDescriptor, F_GETFL);
    if (flags < 0 || getsockopt(inheritedDescriptor, SOL_SOCKET, SO_TYPE, &type, &typeLength) != 0 || type != SOCK_DGRAM ||
        getsockname(inheritedDescriptor, reinterpret_cast<sockaddr *>(&local), &localLength) != 0 || local.ss_family != AF_UNIX ||
        getpeername(inheritedDescriptor, reinterpret_cast<sockaddr *>(&peer), &peerLength) != 0 || peer.ss_family != AF_UNIX ||
        reinterpret_cast<const sockaddr_un *>(&local)->sun_path[0] ||
        reinterpret_cast<const sockaddr_un *>(&peer)->sun_path[0] ||
        fcntl(inheritedDescriptor, F_SETFD, FD_CLOEXEC) < 0 ||
        fcntl(inheritedDescriptor, F_SETFL, flags | O_NONBLOCK) < 0) { fail(); return; }
    const int suppressSignal = 1;
    if (setsockopt(inheritedDescriptor, SOL_SOCKET, SO_NOSIGPIPE, &suppressSignal, sizeof(suppressSignal)) != 0) { fail(); return; }
    reply({RawOp::Hello, 0, 0, 0, RawReason::None});
}
void RawControl::fail() { failed_ = true; pending_.clear(); descriptor_.reset(); }
void RawControl::flush() {
    while (enabled() && !pending_.empty()) {
        if (std::chrono::steady_clock::now() - pending_.front().queued > std::chrono::seconds(1)) { fail(); return; }
        const auto bytes = rawControlBytes(pending_.front().message);
        const auto written = send(descriptor_.get(), bytes.data(), bytes.size(), 0);
        // Darwin reports a full connected UNIX datagram receive queue as
        // ENOBUFS. Retry on the next engine tick under the same deadline/cap.
        if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == ENOBUFS)) return;
        if (written < 0 && errno == EINTR) return; // Next engine tick retries, never spins.
        if (written != static_cast<ssize_t>(bytes.size())) { fail(); return; }
        pending_.pop_front();
    }
}
void RawControl::reply(RawMessage message) {
    if (!enabled()) return;
    if (!valid(message) || message.op == RawOp::Start || message.op == RawOp::Stop) { fail(); return; }
    if (message.op == RawOp::Stopped || message.op == RawOp::Failed) terminal_[message.slot] = message;
    flush();
    if (!enabled()) return;
    if (pending_.size() >= 8) { fail(); return; }
    pending_.push_back({message, std::chrono::steady_clock::now()});
    flush();
}
std::optional<RawMessage> RawControl::terminal(unsigned slot, uint64_t capture, uint64_t broadcast) const {
    if (slot > 1 || !terminal_[slot] || terminal_[slot]->capture != capture || terminal_[slot]->broadcast != broadcast)
        return std::nullopt;
    return terminal_[slot];
}
std::vector<RawRequest> RawControl::poll() {
    std::vector<RawRequest> requests;
    if (!enabled()) return requests;
    flush();
    for (unsigned iteration = 0; enabled() && iteration < 4; ++iteration) {
        std::array<uint8_t, rawControlSize> bytes{};
        // Receive the kernel's full possible rights population before enforcing
        // our one-descriptor Start contract, then close every rejected right.
        // An undersized buffer leaks undisclosed rights on macOS.
        alignas(cmsghdr) std::array<uint8_t, ancillaryCapacity> control{};
        iovec buffer{bytes.data(), bytes.size()};
        msghdr packet{};
        packet.msg_iov = &buffer; packet.msg_iovlen = 1;
        packet.msg_control = control.data(); packet.msg_controllen = control.size();
        const ssize_t count = recvmsg(descriptor_.get(), &packet, 0);
        if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break;
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) { fail(); break; }
        std::vector<RawDescriptor> rights;
        bool ancillaryValid = true;
        unsigned ancillaryCount = 0;
        for (cmsghdr *header = CMSG_FIRSTHDR(&packet); header; header = CMSG_NXTHDR(&packet, header)) {
            ++ancillaryCount;
            const auto *position = reinterpret_cast<uint8_t *>(header);
            const size_t available = packet.msg_controllen - static_cast<size_t>(position - control.data());
            if (header->cmsg_len < CMSG_LEN(0) || available < CMSG_LEN(0)) { ancillaryValid = false; break; }
            const bool contained = header->cmsg_len <= available;
            if (!contained) ancillaryValid = false;
            if (header->cmsg_level != SOL_SOCKET || header->cmsg_type != SCM_RIGHTS) { ancillaryValid = false; continue; }
            // Some recvmsg implementations retain the original cmsg_len on
            // truncation. Adopt the installed descriptors that fit before
            // rejecting the packet; never trust that length past the buffer.
            const size_t payload = std::min<size_t>(header->cmsg_len, available) - CMSG_LEN(0);
            if (payload % sizeof(int)) ancillaryValid = false;
            for (size_t offset = 0; offset + sizeof(int) <= payload; offset += sizeof(int)) {
                int received = -1;
                std::memcpy(&received, CMSG_DATA(header) + offset, sizeof(received));
                rights.emplace_back(received);
            }
            if (!contained) break;
        }
        const auto message = readRawControlBytes(bytes.data(), static_cast<size_t>(count));
        if (!message || (message->op != RawOp::Start && message->op != RawOp::Stop) ||
            (packet.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) || !ancillaryValid) { fail(); break; }
        const bool starting = message->op == RawOp::Start;
        if (rights.size() != (starting ? 1u : 0u) || ancillaryCount != (starting ? 1u : 0u)) {
            rights.clear();
            reply({RawOp::Rejected, message->slot, message->capture, message->broadcast, RawReason::InvalidDescriptor});
            continue;
        }
        RawDescriptor descriptor;
        if (starting) {
            descriptor = std::move(rights.front());
            struct stat info{};
            const int flags = fcntl(descriptor.get(), F_GETFL);
            if (flags < 0 || (flags & O_ACCMODE) != O_WRONLY || fstat(descriptor.get(), &info) != 0 ||
                !S_ISFIFO(info.st_mode) || fcntl(descriptor.get(), F_SETFD, FD_CLOEXEC) < 0) {
                descriptor.reset();
                reply({RawOp::Rejected, message->slot, message->capture, message->broadcast, RawReason::InvalidDescriptor});
                continue;
            }
        }
        requests.push_back({*message, std::move(descriptor)});
    }
    if (!enabled()) requests.clear();
    return requests;
}
} // namespace sauce_obs
