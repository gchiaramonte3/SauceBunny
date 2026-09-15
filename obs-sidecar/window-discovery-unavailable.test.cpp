// SPDX-License-Identifier: GPL-2.0-or-later
// The discovery CLI's applications branch must not enumerate any windows.
// Linked only by its test, never by the embedded runtime.
#include "window-discovery.hpp"
#include <cstdlib>

namespace sauce_obs {
WindowDiscovery windowsForApplication(const std::string &, int32_t) {
    std::exit(90);
}
WindowDiscovery allWindowsForCapture(int32_t) {
    std::exit(91);
}
DisplayDiscovery displaysForCapture() { std::exit(92); }
} // namespace sauce_obs
