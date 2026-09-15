// SPDX-License-Identifier: GPL-2.0-or-later
// Actual control parser, anonymous pipes only. No OBS or capture APIs.
#include "service-control.hpp"
#include <cassert>
#include <chrono>
#include <cstdio>
#include <unistd.h>

static std::optional<sauce_obs::StartCapture> parseRecord(const std::string &record, bool accepted) {
    int descriptors[2];
    assert(pipe(descriptors) == 0);
    const int original = dup(STDIN_FILENO);
    assert(original >= 0 && dup2(descriptors[0], STDIN_FILENO) == STDIN_FILENO);
    close(descriptors[0]);
    std::optional<sauce_obs::StartCapture> result;
    {
        sauce_obs::ServiceControl control;
        assert(write(descriptors[1], record.data(), record.size()) == static_cast<ssize_t>(record.size()));
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
        while (!result && !control.stopping() && std::chrono::steady_clock::now() < deadline) {
            result = control.next();
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        assert(accepted ? result.has_value() && !control.stopping() : !result && control.stopping());
    }
    assert(dup2(original, STDIN_FILENO) == STDIN_FILENO);
    close(original); close(descriptors[1]);
    return result;
}
static std::optional<sauce_obs::StartCapture> parse(const std::string &audio, bool accepted) {
    return parseRecord("{\"op\":\"start\",\"slot\":1,\"generation\":123,"
        "\"application\":\"com.example.fixture\",\"process\":42,\"window\":24,\"crop\":[0,0,1,1]" + audio + "}\n",accepted);
}

int main() {
    for (const auto &suffix : {std::string(), std::string(",\"audio\":true"), std::string(",\"audio\":false")}) {
        const auto request = parse(suffix, true);
        assert(request->audio == (suffix != ",\"audio\":false"));
        assert(request->slot == 1 && request->generation == 123);
        const auto &identity = std::get<sauce_obs::WindowIdentity>(request->target);
        assert(identity.application == "com.example.fixture" && identity.process == 42 && identity.window == 24);
        assert(request->crop.x == 0 && request->crop.y == 0 && request->crop.width == 1 && request->crop.height == 1);
    }
    for (const auto *value : {"null", "0", "1", "\"false\"", "[]", "{}"})
        parse(std::string(",\"audio\":") + value, false);
    parse(",\"unknown\":false", false);
    parse(",\"audio\":false,\"unknown\":true", false);
    const std::string display = "{\"op\":\"start\",\"slot\":1,\"generation\":123,\"kind\":\"display\","
        "\"displayUuid\":\"12345678-1234-1234-1234-123456789ABC\",\"displayId\":42,"
        "\"geometry\":{\"x\":-1920,\"y\":0,\"width\":1920,\"height\":1080,\"pixelWidth\":3840,\"pixelHeight\":2160},"
        "\"crop\":[0.25,0.25,0.5,0.5],\"audio\":false}\n";
    auto selected = parseRecord(display,true);
    const auto &identity = std::get<sauce_obs::DisplayIdentity>(selected->target);
    assert(identity.id == 42 && identity.geometry.x == -1920 && identity.geometry.pixelWidth == 3840 && !selected->audio);
    assert(selected->audioPolicy == 0);
    auto audioDisplay = display;
    audioDisplay.replace(audioDisplay.find("\"audio\":false"), std::string("\"audio\":false").size(),
        "\"audio\":true,\"audioPolicy\":1");
    const auto audioSelected = parseRecord(audioDisplay, true);
    assert(audioSelected->audio && audioSelected->audioPolicy == 1);
    for (const auto *policy : {"0", "2", "true", "null", "\"1\"", "[]", "{}"}) {
        auto invalid = audioDisplay;
        invalid.replace(invalid.find("\"audioPolicy\":1"), std::string("\"audioPolicy\":1").size(),
            std::string("\"audioPolicy\":") + policy);
        parseRecord(invalid, false);
    }
    parse(",\"audio\":true,\"audioPolicy\":1", false);
    parse(",\"audioPolicy\":1", false);
    const auto replace = [&](const std::string &from, const std::string &to) {
        std::string changed = display; const auto at = changed.find(from); assert(at != std::string::npos);
        changed.replace(at,from.size(),to); parseRecord(changed,false);
    };
    replace("\"kind\":\"display\"","\"kind\":\"window\"");
    replace("\"audio\":false","\"audio\":true");
    replace("\"audio\":false","\"audio\":false,\"audioPolicy\":1");
    replace("\"audio\":false","\"audio\":true,\"parentProcess\":42");
    replace(",\"audio\":false","");
    replace("\"displayId\":42","\"displayId\":0");
    replace("\"displayId\":42","\"displayId\":42,\"window\":2");
    replace("\"pixelWidth\":3840","\"pixelWidth\":0");
    replace("\"width\":1920","\"width\":1920.5");
    replace("\"x\":-1920","\"x\":-1000001");
    replace("\"crop\":[0.25,0.25,0.5,0.5]","\"crop\":[0,0,0.001,1]");
    replace("12345678-1234-1234-1234-123456789ABC","12345678-1234-1234-1234-123456789ABZ");
    std::puts("Service control audio policy tests passed (anonymous pipes; no capture)");
}
