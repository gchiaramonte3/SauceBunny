// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <obs.h>
#include "include/sauce-display-audio.h"

namespace sauce_obs {
// Check before source creation: an older module must never silently ignore
// audio:false and start acquiring the application's audio anyway.
inline bool configureCaptureAudio(obs_data_t *settings, obs_data_t *defaults, bool enabled) {
    if (!settings || (!enabled && (!defaults || obs_data_get_int(defaults, "sauce_audio_policy_version") != 1)))
        return false;
    obs_data_set_bool(settings, "capture_audio", enabled);
    return true;
}

// Display audio is a separate versioned contract. Audio-off and application
// capture retain their established filters and do not need a parent identity.
inline bool configureDisplayCaptureAudio(obs_data_t *settings, obs_data_t *defaults, bool enabled) {
    if (!enabled) return settings != nullptr;
    if (!settings || !defaults || obs_data_get_int(defaults, "sauce_display_audio_policy_version") != 1)
        return false;
    NSRunningApplication *parent = sauce_display_audio_parent();
    if (!parent) return false;
    obs_data_set_int(settings, "sauce_display_audio_policy", 1);
    obs_data_set_int(settings, "sauce_audio_parent_pid", parent.processIdentifier);
    return true;
}
}
