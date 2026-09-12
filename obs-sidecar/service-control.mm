// SPDX-License-Identifier: GPL-2.0-or-later
#import <Foundation/Foundation.h>
#include "service-control.hpp"
#include <chrono>
#include <poll.h>
#include <unistd.h>

namespace sauce_obs {
namespace {
bool number(id value, double low, double high) {
    return [value isKindOfClass:[NSNumber class]] && CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID() &&
        std::isfinite([value doubleValue]) && [value doubleValue] >= low && [value doubleValue] <= high;
}
bool integer(id value, double low, double high) {
    return number(value, low, high) && std::floor([value doubleValue]) == [value doubleValue];
}
}
ServiceControl::ServiceControl() : parent_(getppid()), thread_([this] { watch(); }) {}
ServiceControl::~ServiceControl() { finished_ = true; thread_.join(); }
bool ServiceControl::cancelled(unsigned slot, uint64_t generation) const {
    return stopping() || slot > 1 || cancelled_[slot].load() >= generation;
}
std::optional<StartCapture> ServiceControl::next() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (pending_.empty()) return std::nullopt;
    auto result = pending_.front(); pending_.pop_front(); return result;
}
bool ServiceControl::accept(const std::string &line) {
    @autoreleasepool {
        NSData *data = [NSData dataWithBytes:line.data() length:line.size()];
        id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        if (![parsed isKindOfClass:[NSDictionary class]]) return false;
        NSDictionary *record = parsed;
        if (!integer(record[@"slot"], 0, 1) || !integer(record[@"generation"], 1, 9007199254740991.0)) return false;
        const unsigned slot = [record[@"slot"] unsignedIntValue];
        const uint64_t generation = [record[@"generation"] unsignedLongLongValue];
        if ([record[@"op"] isEqual:@"stop"]) {
            if (record.count != 3) return false;
            // A delayed stop can never cancel a later occupant of this slot.
            if (generation > cancelled_[slot]) cancelled_[slot] = generation;
            return true;
        }
        if (![record[@"op"] isEqual:@"start"] || record.count != 7 || generation <= last_[slot]) return false;
        NSString *application = record[@"application"];
        if (![application isKindOfClass:[NSString class]] || application.length < 3 || application.length > 256 ||
            ![application containsString:@"."] ||
            [application rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:
                @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_"] invertedSet]].location != NSNotFound ||
            !integer(record[@"process"], 1, INT32_MAX) || !integer(record[@"window"], 1, UINT32_MAX)) return false;
        NSArray *crop = record[@"crop"];
        if (![crop isKindOfClass:[NSArray class]] || crop.count != 4) return false;
        for (id value in crop) if (!number(value, 0, 1)) return false;
        Crop area{[crop[0] doubleValue], [crop[1] doubleValue], [crop[2] doubleValue], [crop[3] doubleValue]};
        if (area.width <= 0 || area.height <= 0 || area.x + area.width > 1 || area.y + area.height > 1) return false;
        StartCapture command{slot, generation, {[record[@"window"] unsignedIntValue],
            [record[@"process"] intValue], application.UTF8String}, area};
        std::lock_guard<std::mutex> lock(mutex_);
        if (pending_.size() >= 2) return false;
        last_[slot] = generation;
        pending_.push_back(command);
        return true;
    }
}
void ServiceControl::watch() {
    using Clock = std::chrono::steady_clock;
    auto heartbeat = Clock::now(), stoppedAt = heartbeat;
    std::string line;
    while (!finished_) {
        if (stopping_) {
            if (Clock::now() - stoppedAt > std::chrono::seconds(3)) std::_Exit(6);
            std::this_thread::sleep_for(std::chrono::milliseconds(25));
            continue;
        }
        pollfd input{STDIN_FILENO, POLLIN, 0};
        const int ready = poll(&input, 1, 50);
        if (ready < 0) stopping_ = true;
        if (ready > 0) {
            char bytes[512];
            const auto count = read(STDIN_FILENO, bytes, sizeof(bytes));
            if (count <= 0) stopping_ = true;
            for (ssize_t n = 0; n < count && !stopping_; n++) {
                if (bytes[n] == '\n') {
                    if (line == "P") heartbeat = Clock::now();
                    else if (line == "Q" || !accept(line)) stopping_ = true;
                    line.clear();
                } else if (line.size() < 4096) line.push_back(bytes[n]);
                else stopping_ = true;
            }
        }
        if (parent_ <= 1 || getppid() != parent_ || Clock::now() - heartbeat > std::chrono::seconds(2)) stopping_ = true;
        if (stopping_) stoppedAt = Clock::now();
    }
}
} // namespace sauce_obs
