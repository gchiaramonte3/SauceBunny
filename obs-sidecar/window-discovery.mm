// SPDX-License-Identifier: GPL-2.0-or-later
#import <AppKit/AppKit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include "window-discovery.hpp"
#include "engine.hpp"
#include <atomic>
#include <chrono>
#include <memory>

namespace sauce_obs {
WindowDiscovery windowsForApplication(const std::string &application, int32_t diagnosticProcess) {
    if (application.empty()) return {{}, "application_required"};
    if (!CGPreflightScreenCaptureAccess()) return {{}, "screen_capture_permission_required"};
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
                if (!bundle || requestedApplication != bundle || owner.processID <= 0 || window.windowID == 0 ||
                    !window.onScreen || window.frame.size.width < 2 || window.frame.size.height < 2 ||
                    window.frame.size.width > 16384 || window.frame.size.height > 16384) continue;
                result->discovery.windows.push_back({
                    {window.windowID, owner.processID, bundle}, window.title.UTF8String ?: "",
                    static_cast<uint32_t>(window.frame.size.width), static_cast<uint32_t>(window.frame.size.height)
                });
              }
            }
            result->done.store(true);
        }];
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    while (!result->done.load() && std::chrono::steady_clock::now() < deadline) pumpEvents(0.01);
    if (!result->done.load()) return {{}, "window_discovery_timeout"};
    return result->discovery;
}
} // namespace sauce_obs
