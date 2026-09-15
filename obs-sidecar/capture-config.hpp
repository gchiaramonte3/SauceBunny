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
struct DisplayGeometry {
    double x = 0, y = 0;
    uint32_t width = 0, height = 0, pixelWidth = 0, pixelHeight = 0;
};
inline bool validDisplayGeometry(const DisplayGeometry &value) {
    return std::isfinite(value.x) && std::isfinite(value.y) && std::abs(value.x) <= 1000000 &&
        std::abs(value.y) <= 1000000 && value.width >= 2 && value.width <= 16384 &&
        value.height >= 2 && value.height <= 16384 && value.pixelWidth >= 2 && value.pixelWidth <= 16384 &&
        value.pixelHeight >= 2 && value.pixelHeight <= 16384;
}
inline bool validDisplayUuid(const std::string &uuid) {
    if (uuid.size() != 36) return false;
    for (size_t i = 0; i < uuid.size(); i++) {
        const char c = uuid[i];
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (c != '-') return false; }
        else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return false;
    }
    return true;
}
struct DisplayIdentity { uint32_t id = 0; std::string uuid; DisplayGeometry geometry; };
inline bool sameDisplay(const DisplayIdentity &wanted, const DisplayIdentity &observed) {
    const auto &a = wanted.geometry, &b = observed.geometry;
    return wanted.id != 0 && validDisplayUuid(wanted.uuid) && validDisplayGeometry(a) &&
        wanted.id == observed.id && wanted.uuid == observed.uuid && a.x == b.x && a.y == b.y &&
        a.width == b.width && a.height == b.height && a.pixelWidth == b.pixelWidth && a.pixelHeight == b.pixelHeight;
}
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
