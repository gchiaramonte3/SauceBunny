// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include "capture-config.hpp"
#include <vector>
namespace sauce_obs {
inline bool validWindowGeometry(double width, double height) {
    return std::isfinite(width) && std::isfinite(height) && width >= 2 && height >= 2 && width <= 16384 && height <= 16384;
}
// Chooser eligibility matches the existing ScreenCaptureKit room picker:
// normal application windows, not menu-bar items or tiny utility surfaces.
// This is not an exact-window capture restriction.
inline bool eligibleWindowForChooser(int32_t layer, double width, double height) {
    return layer == 0 && validWindowGeometry(width, height) && width >= 120 && height >= 90;
}
struct Window {
    WindowIdentity identity;
    std::string title;
    uint32_t width, height;
    std::string applicationName;
};
struct WindowDiscovery {
    std::vector<Window> windows;
    std::string error;
    size_t visibleWindows = 0, matchingWindows = 0, matchingApplications = 0;
    std::string diagnosticBundle;
    size_t diagnosticWindows = 0;
};
// Enumeration only. Never requests permission or starts an OBS capture source.
WindowDiscovery windowsForApplication(const std::string &application, int32_t diagnosticProcess = 0);
WindowDiscovery allWindowsForCapture(int32_t excludedProcess);
struct Display { DisplayIdentity identity; std::string label; };
struct DisplayDiscovery { std::vector<Display> displays; std::string error; };
DisplayDiscovery displaysForCapture();
} // namespace sauce_obs
