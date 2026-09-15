// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#import <AppKit/AppKit.h>
#include <unistd.h>

// The owner is derived in the native helper, never supplied by the renderer.
// A shell/developer probe is not an approved audio-exclusion identity.
static inline NSRunningApplication *sauce_display_audio_parent(void)
{
    const pid_t parent = getppid();
    if (parent <= 1 || parent == getpid()) return nil;
    NSRunningApplication *application = [NSRunningApplication runningApplicationWithProcessIdentifier:parent];
    if (!application || application.terminated || application.processIdentifier != parent ||
        ![application.bundleIdentifier isEqualToString:@"com.saucebunny.desktop"]) return nil;
    return application;
}
