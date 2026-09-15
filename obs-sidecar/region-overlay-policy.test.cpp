// SPDX-License-Identifier: GPL-2.0-or-later
// Pure owner input tests. No AppKit objects, windows, capture or permissions.
#include "region-overlay-policy.hpp"
#include <cassert>
#include <cstdio>
#include <limits>
using namespace sauce_obs;
int main() {
    const RegionRect left{-1920, -180, 1920, 1080};
    const auto placed = placeRegion(left, {100.25, 50.5, 640.5, 360.25});
    assert(placed && sameRegionRect(*placed, {-1819.75, 489.25, 640.5, 360.25}));
    assert(sameRegionRect(*placeRegion(left, {0, 0, 1920, 1080}), left));
    assert(sameRegionRect(*placeRegion(left, {1800, 1000, 120, 80}), {-120, -180, 120, 80}));
    assert(!placeRegion(left, {1800, 1000, std::nextafter(120.0, 121.0), 80}));
    for (const auto bad : {-1.0, 0.0, 16.0, std::numeric_limits<double>::infinity(),
                          std::numeric_limits<double>::quiet_NaN()}) {
        assert(!placeRegion(left, {0, 0, bad, 100}));
        assert(!placeRegion(left, {0, 0, 100, bad}));
    }
    assert(!placeRegion(left, {-1, 0, 100, 100}));
    assert(!placeRegion(left, {0, -1, 100, 100}));
    assert(!placeRegion(left, {0, 0, 1921, 1080}));
    assert(!placeRegion({std::numeric_limits<double>::max(), 0, 100, 100}, {0, 0, 90, 90}));
    assert(placeRegion(left, {0, 0, 16.01, 16.01}));
    std::vector<RegionDisplay> screens{{7, {0, 0, 1440, 900}, 2, 0}, {31, left, 1, 0},
                                     {55, {300, 900, 1080, 1920}, 2, 90}};
    assert(validRegionDisplays(screens));
    auto reordered = screens;
    std::reverse(reordered.begin(), reordered.end());
    assert(validRegionDisplays(reordered) && sameRegionDisplays(screens, reordered));
    assert(sameRegionRect(*placeRegion(screens[2].frame, {100, 50, 640, 360}), {400, 2410, 640, 360}));
    for (unsigned mutation = 0; mutation < 6; ++mutation) {
        auto changed = screens;
        if (mutation == 0) changed[1].id++;
        if (mutation == 1) changed[1].frame.x++;
        if (mutation == 2) changed[1].frame.height++;
        if (mutation == 3) changed[1].scale = 2;
        if (mutation == 4) changed[1].rotation = 90;
        if (mutation == 5) changed.pop_back();
        assert(validRegionDisplays(changed) && !sameRegionDisplays(screens, changed));
    }
    auto invalid = screens; invalid.push_back(screens[0]); assert(!validRegionDisplays(invalid));
    invalid = screens; invalid[0].scale = 0; assert(!validRegionDisplays(invalid));
    invalid = screens; invalid[0].rotation = std::numeric_limits<double>::quiet_NaN(); assert(!validRegionDisplays(invalid));
    const std::vector<uint32_t> ids{1, 2, 3, 4};
    const std::vector<RegionWindow> observed{{1, 99}, {2, 99}, {3, 99}, {4, 99}, {8, 99}, {9, 100}};
    assert(exactRegionWindows(ids, 99, observed));
    assert(!exactRegionWindows({}, 99, observed));
    assert(!exactRegionWindows(ids, 0, observed));
    assert(!exactRegionWindows({1, 1}, 99, observed));
    assert(!exactRegionWindows({0}, 99, observed));
    assert(!exactRegionWindows({5}, 99, observed));
    for (size_t i = 0; i < ids.size(); ++i) {
        auto changed = observed; changed.erase(changed.begin() + i);
        assert(!exactRegionWindows(ids, 99, changed));
        changed = observed; changed[i].pid = 100;
        assert(!exactRegionWindows(ids, 99, changed));
        changed = observed; changed.push_back(changed[i]);
        assert(!exactRegionWindows(ids, 99, changed));
    }
    auto registry = RegionRegistry::make({1, 2, 3, 4});
    assert(registry && registry->acquire(0, 11));
    const auto firstFilter = registry->exclusions(0, 11);
    assert(firstFilter == ids); // A excludes B's still-hidden panels before B exists.
    assert(registry->acquire(1, 12));
    assert(registry->exclusions(1, 12) == firstFilter);
    assert(!registry->release(0, 12) && registry->owns(0, 11));
    assert(!registry->acquire(0, 13));
    assert(registry->release(1, 12) && registry->owns(0, 11));
    assert(!registry->acquire(1, 12));
    assert(registry->acquire(1, 13));
    assert(registry->exclusions(1, 13) == firstFilter); // Reuse never changes the IDs in A's filter.
    assert(!registry->release(1, 12) && registry->owns(1, 13));
    assert(registry->exclusions(1, 12).empty());
    assert(!registry->acquire(2, 14));
    assert(!RegionRegistry::make({1, 2, 1, 4}));
    std::puts("Region overlay point geometry, topology and exact exclusion policy passed; no native windows or capture.");
}
