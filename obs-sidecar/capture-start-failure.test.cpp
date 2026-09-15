// SPDX-License-Identifier: GPL-2.0-or-later
// Pure diagnostics tests: no AppKit, OBS startup, capture or permission access.
#include "capture-start-failure.hpp"
#include <cassert>
#include <cstdio>
#include <set>
#include <string_view>
using namespace sauce_obs;
int main() {
    std::set<std::string_view> codes;
    for (int value = 0; value < static_cast<int>(CaptureStartFailure::Count); ++value) {
        const std::string_view code = captureStartFailureCode(static_cast<CaptureStartFailure>(value));
        assert(!code.empty() && code.size() <= 48);
        for (char c : code) assert((c >= 'a' && c <= 'z') || c == '_');
        assert(codes.insert(code).second);
    }
    assert(std::string_view(captureStartFailureCode(CaptureStartFailure::Count)) == "start_failed");
    assert(std::string_view(captureStartFailureCode(static_cast<CaptureStartFailure>(999))) == "start_failed");
    assert(captureOverlayFailure("invalid_region") == CaptureStartFailure::InvalidRegion);
    assert(captureOverlayFailure("overlay_wrong_thread") == CaptureStartFailure::OverlayWrongThread);
    assert(captureOverlayFailure("display_unavailable") == CaptureStartFailure::OverlayDisplayUnavailable);
    assert(captureOverlayFailure("overlay_slot_busy_or_stale") == CaptureStartFailure::OverlayBusy);
    assert(captureOverlayFailure("overlay_identity_unavailable") == CaptureStartFailure::OverlayIdentityUnavailable);
    assert(captureOverlayFailure("overlay_activation_already_accessory") == CaptureStartFailure::OverlayActivationAlreadyAccessory);
    assert(captureOverlayFailure("overlay_activation_rejected") == CaptureStartFailure::OverlayActivationRejected);
    assert(captureOverlayFailure("overlay_window_ids_unavailable") == CaptureStartFailure::OverlayWindowIdsUnavailable);
    assert(captureOverlayFailure("overlay_registry_unavailable") == CaptureStartFailure::OverlayRegistryUnavailable);
    for (auto raw : {"overlay_unavailable", "/private/secret/project.mov", "window title\nsecret", ""})
        assert(captureOverlayFailure(raw) == CaptureStartFailure::OverlayUnavailable);
    assert(captureStartupHealthFailure("screen_capture_permission_lost") == CaptureStartFailure::PermissionRequired);
    assert(captureStartupHealthFailure("audio_parent_changed") == CaptureStartFailure::AudioParentUnavailable);
    assert(captureStartupHealthFailure("display_identity_changed") == CaptureStartFailure::DisplayIdentityChanged);
    assert(captureStartupHealthFailure("display_topology_changed") == CaptureStartFailure::DisplayTopologyChanged);
    for (auto reason : {"application_changed", "window_missing", "window_identity_changed"})
        assert(captureStartupHealthFailure(reason) == CaptureStartFailure::WindowIdentityChanged);
    assert(captureStartupHealthFailure("window_not_on_screen") == CaptureStartFailure::SourceVisibilityChanged);
    assert(captureStartupHealthFailure("source_missing") == CaptureStartFailure::SourceCreationFailed);
    assert(captureStartupHealthFailure("source_raster_changed") == CaptureStartFailure::SourceRasterMismatch);
    assert(captureStartupHealthFailure("overlay_stop_requested") == CaptureStartFailure::Cancelled);
    for (auto raw : {"capture_stream_stopped", "vendor error: /private/secret", ""})
        assert(captureStartupHealthFailure(raw) == CaptureStartFailure::SourceInitializationFailed);
    std::puts("Capture startup reason allowlist passed; no native capture or permissions.");
}
