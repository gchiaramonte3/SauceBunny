// SPDX-License-Identifier: GPL-2.0-or-later
// Metadata policy only; never links capture or enumerates user windows.
#include "window-discovery.hpp"
#include <cassert>
#include <limits>
#include <iostream>

int main() {
    // Exact-window capture retains its broader geometry support.
    assert(sauce_obs::validWindowGeometry(2, 16384));
    assert(sauce_obs::validWindowGeometry(1920.5, 1080.5));
    for (double invalid : {-1.0, 0.0, 1.0, 16385.0,
            std::numeric_limits<double>::quiet_NaN(), std::numeric_limits<double>::infinity()}) {
        assert(!sauce_obs::validWindowGeometry(invalid, 1080));
        assert(!sauce_obs::validWindowGeometry(1920, invalid));
    }
    assert(sauce_obs::eligibleWindowForChooser(0, 120, 90));
    assert(sauce_obs::eligibleWindowForChooser(0, 1840, 872));
    assert(sauce_obs::eligibleWindowForChooser(0, 1920.5, 1080.5));
    assert(sauce_obs::eligibleWindowForChooser(0, 16384, 16384));
    assert(!sauce_obs::eligibleWindowForChooser(0, std::nextafter(120.0, 0.0), 90));
    assert(!sauce_obs::eligibleWindowForChooser(0, 120, std::nextafter(90.0, 0.0)));
    // A title, bundle identifier or application activation policy is not an
    // eligibility criterion. Menu-bar surfaces fail by layer/geometry alone.
    for (int32_t layer : {-1, 1, 24, 25, 101}) {
        assert(!sauce_obs::eligibleWindowForChooser(layer, 32, 30));
        assert(!sauce_obs::eligibleWindowForChooser(layer, 1840, 872));
    }
    assert(!sauce_obs::eligibleWindowForChooser(0, 32, 30));
    for (double invalid : {0.0, 16385.0, std::numeric_limits<double>::quiet_NaN(),
            std::numeric_limits<double>::infinity()}) {
        assert(!sauce_obs::eligibleWindowForChooser(0, invalid, 90));
        assert(!sauce_obs::eligibleWindowForChooser(0, 120, invalid));
    }
    std::cout << "Window metadata geometry tests passed\n";
}
