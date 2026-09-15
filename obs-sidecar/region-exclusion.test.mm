// SPDX-License-Identifier: GPL-2.0-or-later
// Calls the actual patched module resolver with generated NSObject metadata.
// No NSApplication/NSWindow/SCStream is created and no OS discovery is called.
#import <Foundation/Foundation.h>
#include <obs-data.h>
#include <cassert>
#include <cstdio>
#include <dlfcn.h>
#include <filesystem>
#include <initializer_list>
#include <unistd.h>

using OverlayResolver = NSArray *(*)(obs_data_t *, NSArray *);
using AudioResolver = NSArray *(*)(obs_data_t *, NSArray *, NSArray *, pid_t, NSString *);
static OverlayResolver sauce_capture_overlay_windows = nullptr;
static AudioResolver sauce_capture_display_audio_applications = nullptr;

@interface RegionFixtureApplication : NSObject
@property(nonatomic) int32_t processID;
@property(nonatomic, copy) NSString *bundleIdentifier;
@end
@implementation RegionFixtureApplication
@end
@interface RegionFixtureWindow : NSObject
@property(nonatomic) uint32_t windowID;
@property(nonatomic, strong) RegionFixtureApplication *owningApplication;
@end
@implementation RegionFixtureWindow
@end

static RegionFixtureWindow *window(uint32_t identity, int32_t process) {
    auto *result = [RegionFixtureWindow new]; result.windowID = identity;
    result.owningApplication = [RegionFixtureApplication new]; result.owningApplication.processID = process;
    return result;
}
static void setIds(obs_data_t *settings, NSArray<NSNumber *> *ids, bool floating = false) {
    auto *array = obs_data_array_create();
    for (NSNumber *identity in ids) {
        auto *entry = obs_data_create();
        if (floating) obs_data_set_double(entry, "id", identity.doubleValue);
        else obs_data_set_int(entry, "id", identity.longLongValue);
        obs_data_array_push_back(array, entry); obs_data_release(entry);
    }
    obs_data_set_array(settings, "sauce_overlay_window_ids", array); obs_data_array_release(array);
}
static RegionFixtureApplication *application(int32_t process, NSString *bundle) {
    auto *result = [RegionFixtureApplication new]; result.processID = process; result.bundleIdentifier = bundle;
    return result;
}
static void checkDisplayAudio(obs_data_t *settings, NSArray *overlays) {
    const pid_t parent = getpid() + 1;
    NSString *bundle = @"com.saucebunny.desktop";
    NSArray *applications = @[application(parent, bundle), application(parent + 1, bundle),
        application(getpid(), @"com.saucebunny.obs.capture")];
    const auto resolve = [&](NSArray *apps, NSArray *windows, pid_t process, NSString *identifier) {
        return sauce_capture_display_audio_applications(settings, apps, windows, process, identifier);
    };
    assert(!resolve(applications, overlays, parent, bundle));
    obs_data_set_bool(settings, "capture_audio", true);
    assert(!resolve(applications, overlays, parent, bundle));
    obs_data_set_int(settings, "sauce_display_audio_policy", 1);
    assert(!resolve(applications, overlays, parent, bundle));
    obs_data_set_int(settings, "sauce_audio_parent_pid", parent);
    NSArray *excluded = resolve(applications, overlays, parent, bundle);
    assert(excluded.count == 1 && excluded[0] == applications[0]);
    // Apple's application-then-window rule: helper-owned exceptions remove
    // windows because helper is NOT excluded; parent-owned exceptions would
    // re-include the parent. The production resolver must reject that shape.
    for (RegionFixtureWindow *overlay in overlays)
        assert(overlay.owningApplication.processID != [(RegionFixtureApplication *)excluded[0] processID]);
    for (const auto process : {pid_t(0), pid_t(1), getpid(), parent + 1})
        assert(!resolve(applications, overlays, process, bundle));
    assert(!resolve(applications, overlays, parent, nil));
    assert(!resolve(applications, overlays, parent, @"com.example.impostor"));
    assert(!resolve(@[], overlays, parent, bundle));
    assert(!resolve(@[applications[1], applications[2]], overlays, parent, bundle));
    assert(!resolve(@[application(parent, @"com.example.impostor")], overlays, parent, bundle));
    assert(!resolve(@[applications[0], applications[0]], overlays, parent, bundle));
    assert(!resolve(@[applications[0], application(parent, @"com.example.impostor")], overlays, parent, bundle));
    assert(!resolve(applications, @[], parent, bundle));
    for (NSUInteger i = 0; i < 4; ++i) {
        NSMutableArray *changed = [overlays mutableCopy];
        changed[i] = window((uint32_t)i + 1, parent);
        assert(!resolve(applications, changed, parent, bundle));
        changed[i] = window((uint32_t)i + 1, parent + 1);
        assert(!resolve(applications, changed, parent, bundle));
        changed[i] = window(0, getpid());
        assert(!resolve(applications, changed, parent, bundle));
        changed[i] = overlays[(i + 1) % 4];
        assert(!resolve(applications, changed, parent, bundle));
    }
    for (const char *key : {"sauce_display_audio_policy", "sauce_audio_parent_pid"}) {
        const auto expected = obs_data_get_int(settings, key);
        for (const auto invalid : {int64_t(0), int64_t(-1), expected + 1}) {
            obs_data_set_int(settings, key, invalid);
            assert(!resolve(applications, overlays, parent, bundle));
        }
        obs_data_set_double(settings, key, expected);
        assert(!resolve(applications, overlays, parent, bundle));
        obs_data_set_string(settings, key, "1");
        assert(!resolve(applications, overlays, parent, bundle));
        obs_data_set_int(settings, key, expected);
    }
    obs_data_set_bool(settings, "capture_audio", false);
    assert(!resolve(applications, overlays, parent, bundle));
    obs_data_set_bool(settings, "capture_audio", true);
    assert(resolve(applications, overlays, parent, bundle).count == 1);
    assert(!sauce_capture_display_audio_applications(nullptr, applications, overlays, parent, bundle));
}
int main(int argc, char **argv) {
    assert(argc == 2);
    const auto binary = std::filesystem::path(argv[1]) / "PlugIns/sauce-obs-capture.plugin/Contents/MacOS/sauce-obs-capture";
    void *module = dlopen(binary.c_str(), RTLD_NOW | RTLD_LOCAL);
    assert(module);
    sauce_capture_overlay_windows = reinterpret_cast<OverlayResolver>(dlsym(module, "sauce_capture_overlay_windows"));
    sauce_capture_display_audio_applications = reinterpret_cast<AudioResolver>(dlsym(module, "sauce_capture_display_audio_applications"));
    assert(sauce_capture_overlay_windows && sauce_capture_display_audio_applications);
    @autoreleasepool {
        auto *settings = obs_data_create();
        const auto owner = getpid();
        NSArray *all = @[window(1, owner), window(2, owner), window(3, owner), window(4, owner),
                         window(5, owner), window(6, owner + 1)];
        assert(!sauce_capture_overlay_windows(settings, all));
        obs_data_set_int(settings, "sauce_overlay_owner_pid", owner);
        setIds(settings, @[@1, @2, @3, @4]);
        NSArray *exact = sauce_capture_overlay_windows(settings, all);
        assert(exact.count == 4);
        for (NSUInteger i = 0; i < 4; ++i) assert(exact[i] == all[i]);
        checkDisplayAudio(settings, exact);
        // Both hidden candidate IDs are mandatory in the FIRST source filter.
        for (NSArray *ids in @[@[], @[@1, @2], @[@1, @2, @3, @4, @5], @[@1, @2, @3, @3],
                              @[@1, @2, @3, @0], @[@1, @2, @3, @(-1)], @[@1, @2, @3, @(UINT64_C(4294967296))]]) {
            setIds(settings, ids); assert(!sauce_capture_overlay_windows(settings, all));
        }
        setIds(settings, @[@1, @2, @3, @4], true);
        assert(!sauce_capture_overlay_windows(settings, all));
        setIds(settings, @[@1, @2, @3, @4]);
        for (const auto invalid : {0, -1, owner + 1}) {
            obs_data_set_int(settings, "sauce_overlay_owner_pid", invalid);
            assert(!sauce_capture_overlay_windows(settings, all));
        }
        obs_data_set_double(settings, "sauce_overlay_owner_pid", owner);
        assert(!sauce_capture_overlay_windows(settings, all));
        obs_data_set_int(settings, "sauce_overlay_owner_pid", owner);
        for (NSUInteger i = 0; i < 4; ++i) {
            NSMutableArray *missing = [all mutableCopy]; [missing removeObjectAtIndex:i];
            assert(!sauce_capture_overlay_windows(settings, missing));
            NSMutableArray *foreign = [all mutableCopy]; foreign[i] = window((uint32_t)i + 1, owner + 1);
            assert(!sauce_capture_overlay_windows(settings, foreign));
            NSMutableArray *duplicate = [all mutableCopy]; [duplicate addObject:all[i]];
            assert(!sauce_capture_overlay_windows(settings, duplicate));
            duplicate[duplicate.count - 1] = window((uint32_t)i + 1, owner + 1);
            assert(!sauce_capture_overlay_windows(settings, duplicate));
        }
        assert(!sauce_capture_overlay_windows(settings, nil));
        assert(sauce_capture_overlay_windows(settings, [[all reverseObjectEnumerator] allObjects]).count == 4);
        obs_data_release(settings);
        std::puts("Actual module four-window and parent-audio exclusion resolvers passed; generated metadata only, no capture.");
    }
    dlclose(module);
}
