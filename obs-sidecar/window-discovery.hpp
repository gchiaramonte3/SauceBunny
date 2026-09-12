// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include "capture-config.hpp"
#include <vector>
namespace sauce_obs {
struct Window {
    WindowIdentity identity;
    std::string title;
    uint32_t width, height;
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
} // namespace sauce_obs
