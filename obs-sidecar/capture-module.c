// SPDX-License-Identifier: GPL-2.0-or-later
// Register only the pinned OBS window source. No microphone, legacy display,
// desktop audio, third-party plugins, or OBS user settings are loaded here.
#include <obs-module.h>
OBS_DECLARE_MODULE()
OBS_MODULE_USE_DEFAULT_LOCALE("sauce-obs-capture", "en-US")
MODULE_EXPORT const char *obs_module_description(void) {
    return "Sauce Bunny's pinned OBS window capture";
}
extern struct obs_source_info sck_video_capture_info;
bool obs_module_load(void) {
    obs_register_source(&sck_video_capture_info);
    return true;
}
