// SPDX-License-Identifier: GPL-2.0-or-later
// Enumerates app identities, or windows only for the explicitly requested app.
// Neither operation captures picture/audio or asks for permission.
#import <Foundation/Foundation.h>
#include "application-discovery.hpp"
#include "window-discovery.hpp"
#include <cstdio>
#include <charconv>
#include <cstring>

int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc != 2 && argc != 3) {
            std::fputs("usage: saucebunny-obs-window-probe --applications | <application-bundle-id> [diagnostic-pid]\n", stderr); return 2;
        }
        if (std::strcmp(argv[1], "--applications") == 0) {
            if (argc != 2) return 2;
            auto result = sauce_obs::applicationsForCapture();
            NSMutableArray *applications = [NSMutableArray array];
            for (const auto &app : result.applications) {
                [applications addObject:@{@"pid": @(app.process), @"app": @(app.identifier.c_str()),
                    @"name": @(app.name.c_str())}];
            }
            NSDictionary *response = @{@"applications": applications, @"error": @(result.error.c_str()),
                @"capturedUserContent": @NO};
            NSData *json = [NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
            if (!json) return 3;
            if (!sauce_obs::applicationResponseFits(json.length)) {
                std::fputs("{\"applications\":[],\"error\":\"application_list_too_large\",\"capturedUserContent\":false}\n", stdout);
                return 4;
            }
            std::fwrite(json.bytes, 1, json.length, stdout);
            std::fputc('\n', stdout);
            return result.error.empty() ? 0 : 4;
        }
        if (!sauce_obs::validApplicationIdentifier(argv[1])) return 2;
        int32_t process = 0;
        if (argc == 3) {
            const auto end = argv[2] + std::strlen(argv[2]);
            const auto value = std::from_chars(argv[2], end, process);
            if (value.ec != std::errc() || value.ptr != end || process <= 0) return 2;
        }
        auto result = sauce_obs::windowsForApplication(argv[1], process);
        NSMutableArray *windows = [NSMutableArray array];
        for (const auto &window : result.windows) {
            [windows addObject:@{@"id": @(window.identity.window), @"pid": @(window.identity.process),
                @"app": @(window.identity.application.c_str()), @"title": @(window.title.c_str()),
                @"width": @(window.width), @"height": @(window.height)}];
        }
        NSDictionary *response = @{@"windows": windows, @"error": @(result.error.c_str()),
                                    @"visibleWindowCount": @(result.visibleWindows),
                                    @"matchingWindowCount": @(result.matchingWindows),
                                    @"matchingApplicationCount": @(result.matchingApplications),
                                    @"diagnosticBundle": @(result.diagnosticBundle.c_str()),
                                    @"diagnosticWindowCount": @(result.diagnosticWindows),
                                    @"capturedUserContent": @NO};
        NSData *json = [NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
        if (!json) return 3;
        std::fwrite(json.bytes, 1, json.length, stdout);
        std::fputc('\n', stdout);
        return result.error.empty() ? 0 : 4;
    }
}
