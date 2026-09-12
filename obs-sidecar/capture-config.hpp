// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <array>
#include <cstdlib>
#include <optional>
#include <string>

namespace sauce_obs {
struct WindowIdentity {
    uint32_t window = 0;
    int32_t process = 0;
    std::string application;
};
inline bool sameWindow(const WindowIdentity &wanted, const WindowIdentity &observed) {
    return wanted.window != 0 && wanted.process > 0 && !wanted.application.empty() &&
           wanted.window == observed.window && wanted.process == observed.process &&
           wanted.application == observed.application;
}
struct Crop { double x = 0, y = 0, width = 1, height = 1; };
inline std::optional<Crop> parseCrop(const std::array<const char *, 4> &values) {
    std::array<double, 4> parsed{};
    for (size_t i = 0; i < values.size(); i++) {
        if (!values[i] || !*values[i]) return std::nullopt;
        char *end = nullptr;
        parsed[i] = std::strtod(values[i], &end);
        if (end == values[i] || *end || !std::isfinite(parsed[i]) || parsed[i] < 0 || parsed[i] > 1)
            return std::nullopt;
    }
    if (parsed[2] == 0 || parsed[3] == 0 || parsed[0] + parsed[2] > 1 || parsed[1] + parsed[3] > 1)
        return std::nullopt;
    return Crop{parsed[0], parsed[1], parsed[2], parsed[3]};
}
struct Raster {
    uint32_t left, top, right, bottom;
    uint32_t width, height;
};
inline std::optional<Raster> captureRaster(uint32_t width, uint32_t height, Crop crop) {
    if (width < 2 || height < 2 || width > 16384 || height > 16384 ||
        !std::isfinite(crop.x) || !std::isfinite(crop.y) || !std::isfinite(crop.width) ||
        !std::isfinite(crop.height) || crop.x < 0 || crop.y < 0 || crop.width <= 0 ||
        crop.height <= 0 || crop.x + crop.width > 1 || crop.y + crop.height > 1) return std::nullopt;
    // Round inward: pixels outside the selected viewer never enter the crop.
    const auto left = static_cast<uint32_t>(std::ceil(crop.x * width));
    const auto top = static_cast<uint32_t>(std::ceil(crop.y * height));
    const auto edgeX = static_cast<uint32_t>(std::floor((crop.x + crop.width) * width));
    const auto edgeY = static_cast<uint32_t>(std::floor((crop.y + crop.height) * height));
    if (edgeX <= left + 1 || edgeY <= top + 1) return std::nullopt;
    const auto contentWidth = edgeX - left, contentHeight = edgeY - top;
    const auto scale = std::min({1.0, 1920.0 / contentWidth, 1080.0 / contentHeight});
    const auto outputWidth = static_cast<uint32_t>(std::floor(contentWidth * scale)) & ~1u;
    const auto outputHeight = static_cast<uint32_t>(std::floor(contentHeight * scale)) & ~1u;
    if (outputWidth < 2 || outputHeight < 2) return std::nullopt;
    return Raster{left, top, width - edgeX, height - edgeY, outputWidth, outputHeight};
}
} // namespace sauce_obs
