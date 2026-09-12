// SPDX-License-Identifier: GPL-2.0-or-later
// Anonymous socketpairs and pipes only; no libobs, capture, files, or network.
#include "raw-control.hpp"
#include <array>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <string>
#include <sys/socket.h>
#include <thread>
#include <unistd.h>
#include <vector>

namespace {
using namespace sauce_obs;
unsigned checks = 0;
void check(bool value, const char *message) {
    ++checks;
    if (!value) {
        std::fprintf(stderr, "raw-control: %s\n", message);
        std::printf("{\"passed\":false,\"checks\":%u}\n", checks);
        std::exit(1);
    }
}
struct Pair {
    int peer = -1, child = -1;
    Pair() {
        int descriptors[2];
        check(socketpair(AF_UNIX, SOCK_DGRAM, 0, descriptors) == 0, "socketpair failed");
        peer = descriptors[0]; child = descriptors[1];
        check(fcntl(peer, F_SETFL, O_NONBLOCK) == 0, "peer nonblocking failed");
    }
    ~Pair() { if (peer >= 0) close(peer); if (child >= 0) close(child); }
    int takeChild() { const int result = child; child = -1; return result; }
};
struct Pipe {
    RawDescriptor reader, writer;
    Pipe() {
        int descriptors[2];
        check(pipe(descriptors) == 0, "pipe failed");
        reader = RawDescriptor(descriptors[0]); writer = RawDescriptor(descriptors[1]);
        check(fcntl(reader.get(), F_SETFL, O_NONBLOCK) == 0, "reader nonblocking failed");
    }
    bool eof() const { uint8_t byte; return read(reader.get(), &byte, 1) == 0; }
};
void sendPacket(int peer, const uint8_t *bytes, size_t size, const std::vector<int> &rights = {}, int expectedError = 0) {
    iovec buffer{const_cast<uint8_t *>(bytes), size};
    msghdr packet{};
    packet.msg_iov = &buffer; packet.msg_iovlen = 1;
    alignas(cmsghdr) std::array<uint8_t, 4096> control{};
    check(rights.size() <= 512, "test rights population exceeded");
    if (!rights.empty()) {
        packet.msg_control = control.data(); packet.msg_controllen = CMSG_SPACE(sizeof(int) * rights.size());
        auto *header = CMSG_FIRSTHDR(&packet);
        header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS;
        header->cmsg_len = CMSG_LEN(sizeof(int) * rights.size());
        std::memcpy(CMSG_DATA(header), rights.data(), sizeof(int) * rights.size());
    }
    const auto sent = sendmsg(peer, &packet, 0);
    if (expectedError) check(sent == -1 && errno == expectedError, "oversized ancillary was not rejected by kernel");
    else check(sent == static_cast<ssize_t>(size), "test sendmsg failed");
}
void sendRequest(int peer, RawMessage message, const std::vector<int> &rights = {}) {
    const auto bytes = rawControlBytes(message);
    sendPacket(peer, bytes.data(), bytes.size(), rights);
}
RawMessage receive(int peer) {
    std::array<uint8_t, 33> bytes{};
    const auto count = recv(peer, bytes.data(), bytes.size(), 0);
    check(count == 32, "expected one complete reply");
    const auto message = readRawControlBytes(bytes.data(), static_cast<size_t>(count));
    check(message.has_value(), "invalid reply wire format");
    return *message;
}
void hello(int peer) {
    const auto message = receive(peer);
    check(message.op == RawOp::Hello && !message.capture && !message.broadcast && !message.slot &&
          message.reason == RawReason::None, "initial hello incorrect");
}
void expectRejected(int peer) {
    const auto message = receive(peer);
    check(message.op == RawOp::Rejected && message.reason == RawReason::InvalidDescriptor &&
          message.capture == 11 && message.broadcast == 1, "invalid descriptor not rejected");
}
void fillSendBuffer(int descriptor) {
    const auto bytes = rawControlBytes({RawOp::Started, 0, 11, 1, RawReason::None});
    unsigned count = 0;
    while (count < 10000) {
        const auto written = send(descriptor, bytes.data(), bytes.size(), 0);
        if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == ENOBUFS)) break;
        check(written == 32, "fill send failed");
        ++count;
    }
    check(count > 0 && count < 10000, "send-buffer saturation canary missing");
}
} // namespace

int main() {
    const RawMessage start{RawOp::Start, 1, 0x0001020304050607ULL, 0x0011121314151617ULL, RawReason::None};
    const std::array<uint8_t, 32> expected{{
        'S','B','C','1',2,1,0,0, 0,1,2,3,4,5,6,7,
        0,0x11,0x12,0x13,0x14,0x15,0x16,0x17, 0,0,0,0,0,0,0,0
    }};
    check(rawControlBytes(start) == expected, "exact SBC1 layout changed");
    auto parsed = readRawControlBytes(expected.data(), expected.size());
    check(parsed && parsed->op == start.op && parsed->slot == start.slot && parsed->capture == start.capture &&
          parsed->broadcast == start.broadcast, "SBC1 round trip failed");
    for (size_t offset : {0u,1u,2u,3u,24u,25u,26u,27u,28u,29u,30u,31u}) {
        auto mutation = expected; mutation[offset] ^= 1;
        check(!readRawControlBytes(mutation.data(), mutation.size()), "bad magic/reserved mutation accepted");
    }
    for (size_t size : {size_t{0},size_t{1},size_t{31},size_t{33},SIZE_MAX})
        check(!readRawControlBytes(expected.data(), size), "wrong datagram size accepted");
    check(!readRawControlBytes(nullptr, 32), "null wire data accepted");
    for (auto message : {
        RawMessage{RawOp::Hello,1,0,0,RawReason::None},
        RawMessage{RawOp::Hello,0,1,1,RawReason::None},
        RawMessage{RawOp::Start,2,11,1,RawReason::None},
        RawMessage{RawOp::Start,0,0,1,RawReason::None},
        RawMessage{RawOp::Start,0,11,9007199254740992ULL,RawReason::None},
        RawMessage{RawOp::Stop,0,11,1,RawReason::Cancelled},
        RawMessage{RawOp::Started,0,11,1,RawReason::Busy},
        RawMessage{RawOp::Failed,0,11,1,RawReason::None},
        RawMessage{RawOp::Rejected,0,11,1,RawReason::None},
        RawMessage{static_cast<RawOp>(8),0,11,1,RawReason::None},
        RawMessage{RawOp::Rejected,0,11,1,static_cast<RawReason>(9)}}) {
        const auto bytes = rawControlBytes(message);
        check(!readRawControlBytes(bytes.data(), bytes.size()), "invalid message encoded valid wire data");
    }
    {
        const char *previous = std::getenv("SAUCE_OBS_RAW_CONTROL_FD");
        const std::string saved = previous ? previous : "";
        const bool hadPrevious = previous != nullptr;
        unsetenv("SAUCE_OBS_RAW_CONTROL_FD");
        RawControl absent;
        check(!absent.enabled() && !absent.failed() && absent.poll().empty(), "absent optional channel changed behavior");
        for (const char *invalid : {"", "-1", "1", " 3", "3x", "99999999999999999999"}) {
            setenv("SAUCE_OBS_RAW_CONTROL_FD", invalid, 1);
            RawControl control;
            check(control.failed() && !control.enabled(), "invalid optional descriptor accepted");
            check(fcntl(STDOUT_FILENO, F_GETFD) >= 0, "invalid channel closed stdout");
        }
        if (hadPrevious) setenv("SAUCE_OBS_RAW_CONTROL_FD", saved.c_str(), 1);
        else unsetenv("SAUCE_OBS_RAW_CONTROL_FD");
    }
    {
        Pipe pipe;
        const int invalid = dup(pipe.writer.get());
        check(invalid > 2, "test duplicate failed");
        RawControl control(invalid);
        pipe.writer.reset();
        check(control.failed() && !control.enabled() && pipe.eof(), "invalid inherited channel leaked its descriptor");
    }
    {
        Pair pair; RawControl control(pair.takeChild()); hello(pair.peer);
        Pipe pipe;
        sendRequest(pair.peer, {RawOp::Start,0,11,1,RawReason::None}, {pipe.writer.get()});
        pipe.writer.reset();
        auto requests = control.poll();
        check(requests.size() == 1 && requests[0].message.op == RawOp::Start, "start descriptor not delivered");
        check(!pipe.eof(), "received descriptor closed before delivery");
        check(fcntl(requests[0].descriptor.get(), F_GETFD) & FD_CLOEXEC, "received descriptor lacks CLOEXEC");
        requests.clear();
        check(pipe.eof(), "owned received descriptor leaked");
        sendRequest(pair.peer, {RawOp::Stop,0,11,1,RawReason::None});
        requests = control.poll();
        check(requests.size() == 1 && requests[0].message.op == RawOp::Stop && requests[0].descriptor.get() == -1,
              "stop request incorrect");
        control.reply({RawOp::Stopped,0,11,1,RawReason::None});
        check(receive(pair.peer).op == RawOp::Stopped, "stop acknowledgement missing");
        const auto terminal = control.terminal(0,11,1);
        check(terminal && !control.terminal(1,11,1) && !control.terminal(0,12,1) && !control.terminal(0,11,2),
              "terminal cache crosses generations or slots");
        control.reply(*terminal);
        check(receive(pair.peer).op == RawOp::Stopped, "idempotent terminal acknowledgement missing");
        control.reply({RawOp::Failed,0,11,2,RawReason::WriterFailed});
        const auto failed = receive(pair.peer);
        check(failed.op == RawOp::Failed && failed.reason == RawReason::WriterFailed, "failure acknowledgement incorrect");
    }
    for (unsigned descriptors : {0u,2u}) {
        Pair pair; RawControl control(pair.takeChild()); hello(pair.peer);
        std::array<Pipe,2> pipes;
        std::vector<int> rights;
        for (unsigned i = 0; i < descriptors; ++i) rights.push_back(pipes[i].writer.get());
        sendRequest(pair.peer,{RawOp::Start,0,11,1,RawReason::None},rights);
        for (auto &pipe : pipes) pipe.writer.reset();
        check(control.poll().empty() && control.enabled(), "wrong start descriptor count not scoped to request");
        expectRejected(pair.peer);
        for (const auto &pipe : pipes) check(pipe.eof(), "rejected extra descriptor leaked");
    }
    {
        Pair pair; RawControl control(pair.takeChild()); hello(pair.peer); Pipe pipe;
        sendRequest(pair.peer,{RawOp::Stop,0,11,1,RawReason::None},{pipe.writer.get()});
        pipe.writer.reset();
        check(control.poll().empty() && control.enabled(), "stop with rights accepted");
        expectRejected(pair.peer); check(pipe.eof(), "stop ancillary descriptor leaked");
    }
    {
        Pair pair; RawControl control(pair.takeChild()); hello(pair.peer); Pipe pipe;
        sendRequest(pair.peer,{RawOp::Start,0,11,1,RawReason::None},{pipe.reader.get()});
        check(control.poll().empty(), "read-only pipe accepted"); expectRejected(pair.peer);
        sendRequest(pair.peer,{RawOp::Start,0,11,1,RawReason::None},{pair.peer});
        check(control.poll().empty(), "socket accepted as media pipe"); expectRejected(pair.peer);
    }
    for (unsigned mutation = 0; mutation < 4; ++mutation) {
        Pair pair; RawControl control(pair.takeChild()); hello(pair.peer); Pipe pipe;
        auto header = rawControlBytes({mutation == 2 ? RawOp::Started : RawOp::Start,0,11,1,RawReason::None});
        std::vector<uint8_t> bytes(header.begin(),header.end());
        if (mutation == 0) bytes[0] = 'X';
        if (mutation == 1) bytes.push_back(0); // MSG_TRUNC
        if (mutation == 3) bytes.resize(12);
        sendPacket(pair.peer,bytes.data(),bytes.size(),{pipe.writer.get()});
        pipe.writer.reset();
        check(control.poll().empty() && control.failed(), "malformed/direction packet did not disable raw channel");
        check(pipe.eof(), "malformed packet descriptor leaked");
    }
    {
        Pair pair; RawControl control(pair.takeChild()); hello(pair.peer);
        std::array<Pipe,20> pipes;
        std::vector<int> rights;
        for (auto &pipe : pipes) rights.push_back(pipe.writer.get());
        sendRequest(pair.peer,{RawOp::Start,0,11,1,RawReason::None},rights);
        for (auto &pipe : pipes) pipe.writer.reset();
        // This population exceeded the old 16-fd receive buffer. Darwin kept
        // the four undisclosed descriptors open on MSG_CTRUNC, so all twenty
        // EOF assertions are required even after switching to a full buffer.
        check(control.poll().empty() && control.enabled(), "oversized rights population accepted");
        expectRejected(pair.peer);
        for (const auto &pipe : pipes) check(pipe.eof(), "previously truncated ancillary descriptor leaked");
    }
    {
        // sockargs expands the SCM_RIGHTS int array to LP64 pointers and caps
        // the resulting control at 2048-byte MCLBYTES: 254 rights fit, 255 do not.
        // https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/kern/uipc_syscalls.c
        // https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/arm/param.h
        static_assert(sizeof(uintptr_t) == 8);
        constexpr size_t maximumRights = (2048 - CMSG_LEN(0)) / sizeof(uintptr_t);
        static_assert(maximumRights == 254);
        Pair pair; RawControl control(pair.takeChild()); hello(pair.peer); Pipe pipe;
        const auto bytes = rawControlBytes({RawOp::Start,0,11,1,RawReason::None});
        sendPacket(pair.peer,bytes.data(),bytes.size(),std::vector<int>(maximumRights,pipe.writer.get()));
        pipe.writer.reset();
        check(control.poll().empty() && control.enabled(), "kernel-maximum rights population accepted");
        expectRejected(pair.peer);
        check(pipe.eof(), "kernel-maximum ancillary descriptor leaked");

        Pipe beyond;
        sendPacket(pair.peer,bytes.data(),bytes.size(),std::vector<int>(maximumRights + 1,beyond.writer.get()),EINVAL);
        beyond.writer.reset();
        check(control.poll().empty() && control.enabled(), "kernel-rejected rights reached control parser");
        check(beyond.eof(), "kernel-rejected ancillary descriptor leaked");
    }
    {
        Pair pair; RawControl control(pair.takeChild()); hello(pair.peer);
        for (uint64_t generation = 1; generation <= 8; ++generation)
            sendRequest(pair.peer,{RawOp::Stop,0,11,generation,RawReason::None});
        const auto first = control.poll(); const auto second = control.poll();
        check(first.size() == 4 && second.size() == 4 && control.poll().empty(), "poll exceeded four-message budget");
        check(first.front().message.broadcast == 1 && second.back().message.broadcast == 8, "datagram order changed");
    }
    {
        Pair pair; const int writer = pair.child; RawControl control(pair.takeChild()); hello(pair.peer);
        fillSendBuffer(writer);
        control.reply({RawOp::Stopped,0,11,1,RawReason::None});
        check(control.enabled(), "temporary reply backpressure failed immediately");
        std::array<uint8_t,32> bytes{};
        while (recv(pair.peer,bytes.data(),bytes.size(),0) > 0) {}
        control.poll();
        check(receive(pair.peer).op == RawOp::Stopped, "terminal reply did not retry after backpressure");
        fillSendBuffer(writer);
        control.reply({RawOp::Failed,0,11,2,RawReason::WriterFailed});
        std::this_thread::sleep_for(std::chrono::milliseconds(1050));
        control.poll();
        check(control.failed(), "terminal retry deadline was unbounded");
    }
    {
        Pair pair; const int writer = pair.child; RawControl control(pair.takeChild()); hello(pair.peer);
        fillSendBuffer(writer);
        for (uint64_t generation = 1; generation <= 9; ++generation)
            control.reply({RawOp::Rejected,0,11,generation,RawReason::Busy});
        check(control.failed(), "terminal reply queue was unbounded");
    }
    check(checks > 150, "test population disappeared");
    std::printf("{\"passed\":true,\"checks\":%u}\n", checks);
    return 0;
}
