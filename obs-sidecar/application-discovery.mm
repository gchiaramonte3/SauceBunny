// SPDX-License-Identifier: GPL-2.0-or-later
#import <AppKit/AppKit.h>
#include "application-discovery.hpp"

namespace sauce_obs {
ApplicationDiscovery applicationsForCapture() {
    @try {
        std::vector<Application> choices;
        const int32_t ownProcess = NSProcessInfo.processInfo.processIdentifier;
        for (NSRunningApplication *app in NSWorkspace.sharedWorkspace.runningApplications) {
            const bool canActivate = app.activationPolicy == NSApplicationActivationPolicyRegular ||
                app.activationPolicy == NSApplicationActivationPolicyAccessory;
            auto choice = applicationChoice(app.processIdentifier, app.bundleIdentifier.UTF8String ?: "",
                app.localizedName.UTF8String ?: "", app.terminated, canActivate, ownProcess);
            if (choice) choices.push_back(std::move(*choice));
            if (choices.size() > 1024) return {{}, "application_list_too_large"};
        }
        return applicationChoices(std::move(choices));
    } @catch (NSException *) {
        return {{}, "application_discovery_failed"};
    }
}
} // namespace sauce_obs
