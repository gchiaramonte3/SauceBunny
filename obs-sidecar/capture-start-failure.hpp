// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <string_view>

namespace sauce_obs {
// Diagnostics only. No vendor error, title, path, PID or other free-form text
// crosses the service wire. Keep the existing fail-closed acquisition gates.
enum class CaptureStartFailure {
    Unknown, Cancelled, DiscoveryFailed, DisplayIdentityChanged, WindowIdentityChanged,
    PermissionRequired, AudioParentUnavailable, InvalidRegion, OverlayWrongThread,
    OverlayDisplayUnavailable, OverlayUnavailable, OverlayBusy, OverlayIdentityUnavailable,
    OverlayActivationAlreadyAccessory, OverlayActivationRejected, OverlayWindowIdsUnavailable, OverlayRegistryUnavailable,
    AudioPolicyUnsupported, DisplayPolicyUnsupported, SourceCreationFailed,
    SourceInitializationFailed, FirstFrameUnavailable, SourceRasterMismatch,
    OutputPipeFailed, OutputPreparationFailed, OutputStartFailed, SourceVisibilityChanged,
    DisplayTopologyChanged, Count,
};

constexpr const char *captureStartFailureCode(CaptureStartFailure reason) {
    switch (reason) {
        case CaptureStartFailure::Unknown: return "start_failed";
        case CaptureStartFailure::Cancelled: return "start_cancelled";
        case CaptureStartFailure::DiscoveryFailed: return "start_discovery_failed";
        case CaptureStartFailure::DisplayIdentityChanged: return "start_display_identity_changed";
        case CaptureStartFailure::WindowIdentityChanged: return "start_window_identity_changed";
        case CaptureStartFailure::PermissionRequired: return "start_screen_permission_required";
        case CaptureStartFailure::AudioParentUnavailable: return "start_audio_parent_unavailable";
        case CaptureStartFailure::InvalidRegion: return "start_invalid_region";
        case CaptureStartFailure::OverlayWrongThread: return "start_overlay_wrong_thread";
        case CaptureStartFailure::OverlayDisplayUnavailable: return "start_overlay_display_unavailable";
        case CaptureStartFailure::OverlayUnavailable: return "start_overlay_unavailable";
        case CaptureStartFailure::OverlayBusy: return "start_overlay_busy";
        case CaptureStartFailure::OverlayIdentityUnavailable: return "start_overlay_identity_unavailable";
        case CaptureStartFailure::OverlayActivationAlreadyAccessory: return "start_overlay_activation_already_accessory";
        case CaptureStartFailure::OverlayActivationRejected: return "start_overlay_activation_rejected";
        case CaptureStartFailure::OverlayWindowIdsUnavailable: return "start_overlay_window_ids_unavailable";
        case CaptureStartFailure::OverlayRegistryUnavailable: return "start_overlay_registry_unavailable";
        case CaptureStartFailure::AudioPolicyUnsupported: return "start_audio_policy_unsupported";
        case CaptureStartFailure::DisplayPolicyUnsupported: return "start_display_policy_unsupported";
        case CaptureStartFailure::SourceCreationFailed: return "start_source_creation_failed";
        case CaptureStartFailure::SourceInitializationFailed: return "start_source_initialization_failed";
        case CaptureStartFailure::FirstFrameUnavailable: return "start_first_frame_unavailable";
        case CaptureStartFailure::SourceRasterMismatch: return "start_source_raster_mismatch";
        case CaptureStartFailure::OutputPipeFailed: return "start_output_pipe_failed";
        case CaptureStartFailure::OutputPreparationFailed: return "start_output_preparation_failed";
        case CaptureStartFailure::OutputStartFailed: return "start_output_failed";
        case CaptureStartFailure::SourceVisibilityChanged: return "start_source_visibility_changed";
        case CaptureStartFailure::DisplayTopologyChanged: return "start_display_topology_changed";
        case CaptureStartFailure::Count: break;
    }
    return "start_failed";
}

constexpr CaptureStartFailure captureOverlayFailure(std::string_view reason) {
    if (reason == "invalid_region") return CaptureStartFailure::InvalidRegion;
    if (reason == "overlay_wrong_thread") return CaptureStartFailure::OverlayWrongThread;
    if (reason == "display_unavailable") return CaptureStartFailure::OverlayDisplayUnavailable;
    if (reason == "overlay_slot_busy_or_stale") return CaptureStartFailure::OverlayBusy;
    if (reason == "overlay_identity_unavailable") return CaptureStartFailure::OverlayIdentityUnavailable;
    if (reason == "overlay_activation_already_accessory") return CaptureStartFailure::OverlayActivationAlreadyAccessory;
    if (reason == "overlay_activation_rejected") return CaptureStartFailure::OverlayActivationRejected;
    if (reason == "overlay_window_ids_unavailable") return CaptureStartFailure::OverlayWindowIdsUnavailable;
    if (reason == "overlay_registry_unavailable") return CaptureStartFailure::OverlayRegistryUnavailable;
    return CaptureStartFailure::OverlayUnavailable;
}

constexpr CaptureStartFailure captureStartupHealthFailure(std::string_view reason) {
    if (reason == "screen_capture_permission_lost") return CaptureStartFailure::PermissionRequired;
    if (reason == "audio_parent_changed") return CaptureStartFailure::AudioParentUnavailable;
    if (reason == "display_identity_changed") return CaptureStartFailure::DisplayIdentityChanged;
    if (reason == "display_topology_changed") return CaptureStartFailure::DisplayTopologyChanged;
    if (reason == "application_changed" || reason == "window_missing" || reason == "window_identity_changed")
        return CaptureStartFailure::WindowIdentityChanged;
    if (reason == "window_not_on_screen") return CaptureStartFailure::SourceVisibilityChanged;
    if (reason == "source_missing") return CaptureStartFailure::SourceCreationFailed;
    if (reason == "source_raster_changed") return CaptureStartFailure::SourceRasterMismatch;
    if (reason == "overlay_stop_requested") return CaptureStartFailure::Cancelled;
    return CaptureStartFailure::SourceInitializationFailed;
}
}
