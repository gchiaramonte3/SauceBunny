// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include "region-overlay-policy.hpp"
#include <memory>
#include <string>

namespace sauce_obs {
enum class RegionAction { None, Edit, Stop, Invalidated };

// Main-thread-only AppKit owner. Create only for an explicit, exact region
// capture. One instance belongs to one capture slot/generation, never global.
// First creation reserves both slots' panel IDs until helper exit. Creation
// presents only this lease's NEUTRAL preparing outline. Every source excludes
// ALL registered IDs, including hidden ones, before starting capture.
class RegionOverlay final {
public:
    static std::unique_ptr<RegionOverlay> create(unsigned slot, uint64_t attempt, uint32_t display,
        RegionRect cropPoints, std::string &error);
    ~RegionOverlay();
    RegionOverlay(const RegionOverlay &) = delete;
    RegionOverlay &operator=(const RegionOverlay &) = delete;
    int32_t ownerPid() const;
    const std::vector<uint32_t> &windowIds() const;
    // Caller proves actual source frame + encoder readiness, not just source
    // creation/metadata. Does not itself certify SCK exclusion or capture.
    bool markLive(uint64_t attempt);
    // Bounded NSApp event dispatch (no global event tap). Edit is an intent;
    // the caller routes it to the still-owned chooser, never silently recrops.
    RegionAction poll(uint64_t attempt);
    bool valid(uint64_t attempt) const;
    // Call after that capture's outputs/source are stopped, before terminal ACK.
    // A stale attempt or non-main-thread call cannot close this owner's windows.
    // Orders out the slot, retaining its stable IDs for the surviving source.
    bool close(uint64_t attempt);
private:
    struct Impl;
    explicit RegionOverlay(std::unique_ptr<Impl> impl);
    std::unique_ptr<Impl> impl_;
};
} // namespace sauce_obs
