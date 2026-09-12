// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <algorithm>
#include <cstdint>
#include <optional>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

namespace sauce_obs {
struct Application {
    int32_t process;
    std::string identifier, name;
};
struct ApplicationDiscovery {
    std::vector<Application> applications;
    std::string error;
};

inline bool applicationResponseFits(size_t jsonBytes) {
    // The CLI appends one newline; the Rust cap applies to the entire stream.
    return jsonBytes < 64 * 1024;
}

// Match the native capture boundary's bundle-ID policy. No executable paths,
// icon data, window titles or user documents are part of application discovery.
inline bool validApplicationIdentifier(const std::string &value) {
    return value.size() >= 3 && value.size() <= 256 && value.find('.') != std::string::npos &&
        std::all_of(value.begin(), value.end(), [](unsigned char c) {
            return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_';
        });
}

inline std::optional<Application> applicationChoice(int32_t process, const std::string &identifier,
        const std::string &name, bool terminated, bool canActivate, int32_t ownProcess) {
    if (terminated || !canActivate || process <= 0 || process == ownProcess ||
        !validApplicationIdentifier(identifier) || name.size() > 4096 ||
        name.find('\0') != std::string::npos) return std::nullopt;
    return Application{process, identifier, name.empty() ? identifier : name};
}

inline ApplicationDiscovery applicationChoices(std::vector<Application> applications) {
    if (applications.size() > 1024) return {{}, "application_list_too_large"};
    std::sort(applications.begin(), applications.end(), [](const auto &a, const auto &b) {
        return std::tie(a.process, a.identifier, a.name) < std::tie(b.process, b.identifier, b.name);
    });
    for (size_t i = 1; i < applications.size(); ++i) {
        const auto &previous = applications[i - 1], &current = applications[i];
        if (previous.process == current.process &&
            (previous.identifier != current.identifier || previous.name != current.name))
            return {{}, "application_discovery_failed"};
    }
    applications.erase(std::unique(applications.begin(), applications.end(), [](const auto &a, const auto &b) {
        return a.process == b.process;
    }), applications.end());
    std::sort(applications.begin(), applications.end(), [](const auto &a, const auto &b) {
        return std::tie(a.name, a.identifier, a.process) < std::tie(b.name, b.identifier, b.process);
    });
    return {std::move(applications), ""};
}

// Snapshot only: no ScreenCaptureKit call, permission prompt, capture or launch.
ApplicationDiscovery applicationsForCapture();
} // namespace sauce_obs
