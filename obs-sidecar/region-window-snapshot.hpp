// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#import <AppKit/AppKit.h>
#include "region-overlay-policy.hpp"

namespace sauce_obs {
// Metadata only, restricted to the four helper-owned registry IDs. The
// IncludingWindow list option is a relative onscreen-list modifier: it does
// not reliably describe reserved panels that have never been ordered onscreen.
// Direct ID descriptions include those panels without showing them or asking
// for other applications' windows. ScreenCaptureKit membership is still
// independently required by the module before it creates any stream.
inline std::vector<RegionWindow> regionWindowSnapshot(const std::vector<uint32_t> &ids) {
    if (ids.size() != 4) return {};
    const void *values[4];
    for (size_t i = 0; i < ids.size(); ++i) {
        if (!ids[i] || std::find(ids.begin(), ids.begin() + i, ids[i]) != ids.begin() + i) return {};
        // CGWindowList arrays encode CGWindowID values directly, not CFObjects.
        values[i] = reinterpret_cast<const void *>(static_cast<uintptr_t>(ids[i]));
    }
    CFArrayRef requested = CFArrayCreate(kCFAllocatorDefault, values, 4, nullptr);
    if (!requested) return {};
    NSArray *windows = CFBridgingRelease(CGWindowListCreateDescriptionFromArray(requested));
    CFRelease(requested);
    if (windows.count > ids.size()) return {};
    std::vector<RegionWindow> result;
    result.reserve(windows.count);
    for (NSDictionary *window in windows)
        result.push_back({[window[(id)kCGWindowNumber] unsignedIntValue], [window[(id)kCGWindowOwnerPID] intValue]});
    return result;
}
}
