// SPDX-License-Identifier: GPL-2.0-or-later
#include "capture-config.hpp"
#include "include/sauce-display-crop.h"
#include <cassert>
#include <limits>
#include <iostream>
using namespace sauce_obs;

int main() {
    const WindowIdentity target{100, 50, "com.avid.mediacomposer"};
    assert(sameWindow(target, target));
    assert(!sameWindow(target, {101, 50, target.application}));
    assert(!sameWindow(target, {100, 51, target.application}));
    assert(!sameWindow(target, {100, 50, "other.app"}));
    assert(!sameWindow({}, {}));
    assert(!sameWindow({100, 0, target.application}, {100, 0, target.application}));
    assert(!sameWindow({100, 50, ""}, {100, 50, ""}));
    const DisplayIdentity display{42, "12345678-1234-1234-1234-123456789ABC", {-1920, 10, 1920, 1080, 3840, 2160}};
    assert(sameDisplay(display, display));
    auto changed = display; changed.id++; assert(!sameDisplay(display, changed));
    changed = display; changed.uuid[0] = 'A'; assert(!sameDisplay(display, changed));
    changed = display; changed.geometry.x++; assert(!sameDisplay(display, changed));
    changed = display; changed.geometry.pixelWidth++; assert(!sameDisplay(display, changed));
    changed = display; changed.geometry.width = 0; assert(!sameDisplay(changed, changed));
    assert(!validDisplayUuid("not-a-uuid") && !validDisplayUuid("12345678-1234-1234-1234-123456789ABZ"));
    sauce_display_crop region{};
    assert(sauce_display_crop_make(1920, 1080, 3840, 2160, 0, 0, 1, 1, &region));
    assert(region.x == 0 && region.y == 0 && region.width == 1920 && region.pixels_wide == 3840);
    assert(sauce_display_crop_make(1000, 1000, 2000, 2000, .0011, .0011, .5, .5, &region));
    assert(region.x == 1.5 && region.y == 1.5 && region.width == 499.5 && region.pixels_wide == 999);
    assert(!sauce_display_crop_make(1000, 1000, 2000, 2000, 0, 0, .016, 1, &region));
    assert(!sauce_display_crop_make(1000, 1000, 2000, 2000, 0, 0, .0161, 1, &region));
    assert(sauce_display_crop_make(1000, 1000, 2000, 2000, 0, 0, .0165, 1, &region));
    assert(!sauce_display_crop_make(1000, 1000, 2000, 2000, -.1, 0, .5, 1, &region));
    assert(!sauce_display_crop_make(1000, 1000, 2000, 2000, .9, 0, .5, 1, &region));
    assert(!sauce_display_crop_make(1000, 1000, 2000.5, 2000, 0, 0, 1, 1, &region));
    assert(!sauce_display_crop_make(1000, 1000, INFINITY, 2000, 0, 0, 1, 1, &region));
    assert(!sauce_display_crop_make(1000, 1000, 2000, 2000, NAN, 0, 1, 1, &region));
    assert(parseCrop({"0", "0.25", "1", "0.5"}));
    assert(!parseCrop({"", "0", "1", "1"}));
    assert(!parseCrop({"no", "0", "1", "1"}));
    assert(!parseCrop({"0x", "0", "1", "1"}));
    assert(!parseCrop({"NaN", "0", "1", "1"}));
    assert(!parseCrop({"0", "0", "Inf", "1"}));
    assert(!parseCrop({"0", "0", "0", "1"}));
    assert(!parseCrop({"0.8", "0", "0.3", "1"}));
    assert(!parseCrop({"0", "0.8", "1", "0.3"}));
    auto full = captureRaster(3840, 2160, {});
    assert(full && full->width == 1920 && full->height == 1080);
    assert(full->left == 0 && full->right == 0 && full->top == 0 && full->bottom == 0);
    auto portrait = captureRaster(1080, 1920, {});
    assert(portrait && portrait->width == 606 && portrait->height == 1080);
    auto viewer = captureRaster(2560, 1440, {0.25, 0.25, 0.5, 0.5});
    assert(viewer && viewer->width == 1280 && viewer->height == 720);
    assert(viewer->left == 640 && viewer->right == 640 && viewer->top == 360 && viewer->bottom == 360);
    auto composer = captureRaster(2566, 994, {655.0 / 1283, 67.0 / 497, 620.0 / 1283, 352.0 / 497});
    assert(composer && composer->width == 1240 && composer->height == 704);
    auto odd = captureRaster(1279, 719, {});
    assert(odd && odd->width == 1278 && odd->height == 718);
    auto inward = captureRaster(1000, 1000, {0.0011, 0.0011, 0.5, 0.5});
    assert(inward && inward->left == 2 && inward->top == 2 && inward->right == 499 && inward->bottom == 499);
    assert(!captureRaster(0, 1080, {}));
    assert(!captureRaster(1920, 1, {}));
    assert(!captureRaster(20000, 1080, {}));
    assert(!captureRaster(1920, 1080, {0, 0, 0, 1}));
    assert(!captureRaster(1920, 1080, {-0.1, 0, 1, 1}));
    assert(!captureRaster(1920, 1080, {0.5, 0, 1, 1}));
    assert(!captureRaster(1920, 1080, {0, 0.5, 1, 1}));
    assert(!captureRaster(1920, 1080, {0, 0, 0.00001, 1}));
    for (double invalid : {std::numeric_limits<double>::quiet_NaN(),
                           std::numeric_limits<double>::infinity()}) {
        assert(!captureRaster(1920, 1080, {invalid, 0, 1, 1}));
        assert(!captureRaster(1920, 1080, {0, invalid, 1, 1}));
        assert(!captureRaster(1920, 1080, {0, 0, invalid, 1}));
        assert(!captureRaster(1920, 1080, {0, 0, 1, invalid}));
    }
    std::cout << "OBS capture identity and crop tests passed\n";
}
