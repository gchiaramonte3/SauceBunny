// SPDX-License-Identifier: GPL-2.0-or-later
#import <AppKit/AppKit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include "window-discovery.hpp"
#include "application-discovery.hpp"
#include "engine.hpp"
#include <atomic>
#include <chrono>
#include <memory>
#include <cstring>
#include <unistd.h>

namespace sauce_obs {
namespace {
WindowDiscovery failedDiscovery(const char *error) {
    WindowDiscovery result; result.error = error; return result;
}
WindowDiscovery discoverWindows(const std::string &application, int32_t diagnosticProcess, int32_t excludedProcess) {
    if (!CGPreflightScreenCaptureAccess()) return failedDiscovery("screen_capture_permission_required");
    struct Result {
        std::atomic<bool> done{false};
        WindowDiscovery discovery;
    };
    // A timed-out OS callback may arrive later; never capture stack references.
    auto result = std::make_shared<Result>();
    const std::string requestedApplication = application;
    [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:YES
        completionHandler:^(SCShareableContent *content, NSError *error) {
            if (error || !content) result->discovery.error = "window_discovery_failed";
            else {
              result->discovery.visibleWindows = content.windows.count;
              for (SCRunningApplication *app in content.applications) {
                  if (diagnosticProcess > 0 && app.processID == diagnosticProcess && app.bundleIdentifier)
                      result->discovery.diagnosticBundle = app.bundleIdentifier.UTF8String;
                  if (app.bundleIdentifier && requestedApplication == app.bundleIdentifier.UTF8String)
                      result->discovery.matchingApplications++;
              }
              for (SCWindow *window in content.windows) {
                auto *owner = window.owningApplication;
                const char *bundle = owner.bundleIdentifier.UTF8String;
                if (diagnosticProcess > 0 && owner.processID == diagnosticProcess)
                    result->discovery.diagnosticWindows++;
                if (bundle && requestedApplication == bundle) result->discovery.matchingWindows++;
                if (!bundle || (!requestedApplication.empty() && requestedApplication != bundle) ||
                    !validApplicationIdentifier(bundle) || owner.processID <= 0 || window.windowID == 0 ||
                    (requestedApplication.empty() && (owner.processID == excludedProcess || owner.processID == getpid())) ||
                    !window.onScreen || !validWindowGeometry(window.frame.size.width, window.frame.size.height) ||
                    (requestedApplication.empty() && !eligibleWindowForChooser(window.windowLayer, window.frame.size.width, window.frame.size.height)) ||
                    window.title.length > 4096 || owner.applicationName.length > 4096) continue;
                const char *title = window.title.UTF8String ?: "";
                const char *name = owner.applicationName.length ? owner.applicationName.UTF8String : bundle;
                if (!name || std::strlen(title) > 4096 || std::strlen(name) > 4096) continue;
                result->discovery.windows.push_back({
                    {window.windowID, owner.processID, bundle}, title,
                    static_cast<uint32_t>(window.frame.size.width), static_cast<uint32_t>(window.frame.size.height),
                    name
                });
                if (result->discovery.windows.size() > 1024) {
                    result->discovery.windows.clear(); result->discovery.error = "window_list_too_large"; break;
                }
              }
            }
            result->done.store(true);
        }];
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    while (!result->done.load() && std::chrono::steady_clock::now() < deadline) pumpEvents(0.01);
    if (!result->done.load()) return failedDiscovery("window_discovery_timeout");
    return result->discovery;
}
} // namespace
WindowDiscovery windowsForApplication(const std::string &application, int32_t diagnosticProcess) {
    if (application.empty()) return failedDiscovery("application_required");
    return discoverWindows(application, diagnosticProcess, 0);
}
WindowDiscovery allWindowsForCapture(int32_t excludedProcess) {
    if (excludedProcess <= 1) return failedDiscovery("window_discovery_failed");
    return discoverWindows("", 0, excludedProcess);
}
DisplayDiscovery displaysForCapture() {
    // CoreGraphics display metadata is passive: no SCStream, screenshots,
    // ScreenCaptureKit content query, or recording permission request.
    DisplayDiscovery result;
    CGDirectDisplayID ids[33]{};
    uint32_t count = 0;
    if (CGGetActiveDisplayList(33, ids, &count) != kCGErrorSuccess || count > 32) {
        result.error = "display_discovery_failed"; return result;
    }
    for (uint32_t index = 0; index < count; index++) {
        const auto id = ids[index];
        if (!id || !CGDisplayIsActive(id)) { result.error = "display_discovery_failed"; break; }
        CFUUIDRef uuid = CGDisplayCreateUUIDFromDisplayID(id);
        CFStringRef uuidText = uuid ? CFUUIDCreateString(kCFAllocatorDefault, uuid) : nullptr;
        NSString *text = CFBridgingRelease(uuidText);
        if (uuid) CFRelease(uuid);
        const auto bounds = CGDisplayBounds(id);
        CGDisplayModeRef mode = CGDisplayCopyDisplayMode(id);
        if (!mode || !text || text.length != 36 ||
            !validWindowGeometry(bounds.size.width, bounds.size.height) ||
            std::floor(bounds.size.width) != bounds.size.width || std::floor(bounds.size.height) != bounds.size.height) {
            if (mode) CGDisplayModeRelease(mode);
            result.error = "display_discovery_failed"; break;
        }
        const auto pixelWidth = CGDisplayModeGetPixelWidth(mode), pixelHeight = CGDisplayModeGetPixelHeight(mode);
        CGDisplayModeRelease(mode);
        if (pixelWidth < 2 || pixelWidth > 16384 || pixelHeight < 2 || pixelHeight > 16384) {
            result.error = "display_discovery_failed"; break;
        }
        DisplayIdentity identity{id, text.UTF8String,
            {bounds.origin.x, bounds.origin.y, static_cast<uint32_t>(bounds.size.width), static_cast<uint32_t>(bounds.size.height),
             static_cast<uint32_t>(pixelWidth), static_cast<uint32_t>(pixelHeight)}};
        if (!validDisplayUuid(identity.uuid) || !validDisplayGeometry(identity.geometry)) {
            result.error = "display_discovery_failed"; break;
        }
        result.displays.push_back({identity, "Screen " + std::to_string(index + 1) + (id == CGMainDisplayID() ? " (main)" : "")});
    }
    if (!result.error.empty()) result.displays.clear();
    return result;
}
} // namespace sauce_obs
