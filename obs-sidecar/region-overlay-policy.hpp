// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <optional>
#include <vector>

namespace sauce_obs {
// Logical points, never thumbnail/encoded pixels. A screen frame is global
// AppKit bottom-left; a selected crop is display-local top-left. This helper
// executes in a separate process from the matching Rust region_overlay policy.
struct RegionRect { double x = 0, y = 0, width = 0, height = 0; };
inline bool validRegionRect(RegionRect r) {
    return std::isfinite(r.x) && std::isfinite(r.y) && std::isfinite(r.width) && std::isfinite(r.height) &&
        r.width > 0 && r.height > 0 && std::isfinite(r.x + r.width) && std::isfinite(r.y + r.height) &&
        r.x + r.width > r.x && r.y + r.height > r.y;
}
inline bool sameRegionRect(RegionRect a, RegionRect b) {
    return a.x == b.x && a.y == b.y && a.width == b.width && a.height == b.height;
}
inline std::optional<RegionRect> placeRegion(RegionRect screen, RegionRect crop) {
    if (!validRegionRect(screen) || !validRegionRect(crop) || crop.x < 0 || crop.y < 0 ||
        crop.width <= 16 || crop.height <= 16 || crop.x > screen.width || crop.y > screen.height ||
        crop.width > screen.width - crop.x || crop.height > screen.height - crop.y) return std::nullopt;
    RegionRect result{screen.x + crop.x, screen.y + (screen.height - crop.y - crop.height), crop.width, crop.height};
    return validRegionRect(result) ? std::optional<RegionRect>(result) : std::nullopt;
}
struct RegionDisplay {
    uint32_t id = 0;
    RegionRect frame;
    double scale = 0, rotation = 0;
};
inline bool validRegionDisplays(std::vector<RegionDisplay> &screens) {
    if (screens.empty()) return false;
    std::sort(screens.begin(), screens.end(), [](auto a, auto b) { return a.id < b.id; });
    uint32_t previous = 0;
    for (const auto &screen : screens) {
        if (!screen.id || screen.id == previous || !validRegionRect(screen.frame) ||
            !std::isfinite(screen.scale) || screen.scale <= 0 || !std::isfinite(screen.rotation) ||
            screen.rotation < 0 || screen.rotation >= 360) return false;
        previous = screen.id;
    }
    return true;
}
inline bool sameRegionDisplays(const std::vector<RegionDisplay> &before, const std::vector<RegionDisplay> &after) {
    if (before.size() != after.size()) return false;
    for (size_t i = 0; i < before.size(); ++i) {
        const auto &a = before[i], &b = after[i];
        if (a.id != b.id || !sameRegionRect(a.frame, b.frame) || a.scale != b.scale || a.rotation != b.rotation) return false;
    }
    return true;
}
struct RegionWindow { uint32_t id = 0; int32_t pid = 0; };
inline bool exactRegionWindows(const std::vector<uint32_t> &ids, int32_t pid, const std::vector<RegionWindow> &observed) {
    if (pid <= 0 || ids.empty() || ids.size() > 8) return false;
    for (size_t i = 0; i < ids.size(); ++i) {
        if (!ids[i] || std::find(ids.begin(), ids.begin() + i, ids[i]) != ids.begin() + i) return false;
        unsigned matches = 0;
        for (const auto &window : observed) if (window.id == ids[i]) {
            if (window.pid != pid || ++matches > 1) return false;
        }
        if (matches != 1) return false;
    }
    return true;
}
// Four windows are allocated once, BEFORE the first display source. Every
// display excludes all four, including the currently hidden candidate slot.
// Releasing a lease must not destroy/recreate those windows while a survivor
// still uses its original filter. The native owner retains the panel objects.
class RegionRegistry final {
public:
    static std::optional<RegionRegistry> make(std::array<uint32_t, 4> ids) {
        for (size_t i = 0; i < ids.size(); ++i)
            if (!ids[i] || std::find(ids.begin(), ids.begin() + i, ids[i]) != ids.begin() + i) return std::nullopt;
        return RegionRegistry(ids);
    }
    bool acquire(unsigned slot, uint64_t attempt) {
        if (slot >= 2 || !attempt || active_[slot] || attempt <= last_[slot]) return false;
        active_[slot] = last_[slot] = attempt; return true;
    }
    bool owns(unsigned slot, uint64_t attempt) const {
        return slot < 2 && attempt && active_[slot] == attempt;
    }
    bool release(unsigned slot, uint64_t attempt) {
        if (!owns(slot, attempt)) return false;
        active_[slot] = 0; return true;
    }
    std::vector<uint32_t> exclusions(unsigned slot, uint64_t attempt) const {
        return owns(slot, attempt) ? std::vector<uint32_t>(ids_.begin(), ids_.end()) : std::vector<uint32_t>{};
    }
private:
    explicit RegionRegistry(std::array<uint32_t, 4> ids) : ids_(ids) {}
    std::array<uint32_t, 4> ids_;
    std::array<uint64_t, 2> active_{}, last_{};
};
} // namespace sauce_obs
