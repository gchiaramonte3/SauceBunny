// SPDX-License-Identifier: GPL-2.0-or-later
// Opt-in real WindowServer metadata, not capture. Only four generated hidden
// nonactivating panels are allocated. No user windows, image/audio acquisition,
// ScreenCaptureKit call or permission request; all test panels are closed.
#include "region-window-snapshot.hpp"
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <string_view>
#include <unistd.h>
using namespace sauce_obs;
int main() {
    const char *enabled = std::getenv("SAUCE_OBS_OVERLAY_METADATA_TEST");
    if (!enabled || std::string_view(enabled) != "1") {
        std::puts("SKIP owned overlay metadata: opt in with SAUCE_OBS_OVERLAY_METADATA_TEST=1 in a WindowServer session.");
        return 0;
    }
    @autoreleasepool {
        [NSApplication sharedApplication];
        NSMutableArray<NSPanel *> *panels = [NSMutableArray array];
        std::vector<uint32_t> ids;
        for (unsigned i = 0; i < 4; ++i) {
            NSPanel *panel = [[NSPanel alloc] initWithContentRect:NSMakeRect(0, 0, 32, 32)
                styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                backing:NSBackingStoreBuffered defer:NO];
            panel.opaque = NO; panel.backgroundColor = NSColor.clearColor;
            panel.ignoresMouseEvents = YES; panel.hasShadow = NO; panel.releasedWhenClosed = NO;
            [panels addObject:panel];
            assert(panel.windowNumber > 0 && panel.windowNumber <= UINT32_MAX);
            ids.push_back(static_cast<uint32_t>(panel.windowNumber));
        }
        // This is the original failing state: both slots are retained, and the
        // candidate slot has never been ordered onscreen. No sleep can be needed.
        const auto observed = regionWindowSnapshot(ids);
        const bool exact = exactRegionWindows(ids, getpid(), observed);
        const bool wrongOwner = exactRegionWindows(ids, getpid() + 1, observed);
        auto duplicate = ids; duplicate[3] = duplicate[0];
        const bool rejectedDuplicate = regionWindowSnapshot(duplicate).empty();
        auto zero = ids; zero[0] = 0;
        const bool rejectedZero = regionWindowSnapshot(zero).empty();
        const bool rejectedOversized = regionWindowSnapshot({1, 2, 3, 4, 5}).empty();
        const auto registry = RegionRegistry::make({ids[0], ids[1], ids[2], ids[3]});
        for (NSPanel *panel in panels) { assert(!panel.visible); [panel close]; }
        assert(registry && exact && observed.size() == 4);
        assert(!wrongOwner && rejectedDuplicate && rejectedZero && rejectedOversized);
        std::puts("Four never-ordered owned overlay IDs verified without capture; wrong owner and invalid registries remain rejected.");
    }
}
