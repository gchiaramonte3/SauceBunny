// SPDX-License-Identifier: GPL-2.0-or-later
// One owned libobs engine, two exact-window programs. No network listeners,
// arbitrary plugins, output paths, microphone, room or NDI publication.
#import <AppKit/AppKit.h>
#include "service-control.hpp"
#include "service-output.hpp"
#include "window-discovery.hpp"
#include "proof-output.hpp"
#include "capture-health.hpp"
#include "audio-trace.hpp"
#include "raw-control.hpp"
#include <chrono>
#include <cstdio>
#include <cstring>
#include <memory>

namespace sauce_obs {
namespace {
using Clock = std::chrono::steady_clock;
struct Capture {
    StartCapture request;
    RawControl &rawControl;
    obs_source_t *source = nullptr;
    ProgramOutput output;
    std::unique_ptr<AudioTrace> audioTrace;
    int writer = -1;
    std::thread drain;
    unsigned width = 0, height = 0;
    std::optional<Raster> raster;
    uint64_t rawGeneration = 0, rawCancelledThrough = 0;
    bool rawLive = false;
    std::function<void()> serviceRaw;
    Capture(StartCapture value, RawControl &raw) : request(std::move(value)), rawControl(raw) {}
    void stopRaw(RawReason reason = RawReason::None) {
        if (!rawLive) return;
        output.stopRaw(); // Disconnect, finish/drop the final record, join, close.
        // The final record can reach its deadline during stop itself. Inspect
        // the latched result only after the writer has joined.
        const bool writerFailed = output.rawFailed();
        const bool failed = writerFailed || reason == RawReason::WriterFailed || reason == RawReason::SourceStopped;
        rawLive = false;
        rawControl.reply({failed ? RawOp::Failed : RawOp::Stopped, request.slot, request.generation, rawGeneration,
            writerFailed ? RawReason::WriterFailed : reason});
    }
    void rawRequest(RawRequest command, const ServiceControl &control) {
        const auto &message = command.message;
        const auto reject = [&](RawReason reason) {
            command.descriptor.reset();
            rawControl.reply({RawOp::Rejected, message.slot, message.capture, message.broadcast, reason});
        };
        if (message.capture != request.generation) { reject(RawReason::Stale); return; }
        if (message.op == RawOp::Stop) {
            if (rawLive && message.broadcast == rawGeneration) {
                rawCancelledThrough = std::max(rawCancelledThrough, message.broadcast);
                stopRaw();
            } else if (message.broadcast > rawGeneration) {
                // Stop can win the race with its start. This tombstone is scoped
                // to this capture and cannot stop another live raw generation.
                rawCancelledThrough = std::max(rawCancelledThrough, message.broadcast);
                rawControl.reply({RawOp::Stopped, message.slot, message.capture, message.broadcast, RawReason::Cancelled});
            } else reject(RawReason::Stale);
            return;
        }
        if (message.broadcast <= rawCancelledThrough) { reject(RawReason::Cancelled); return; }
        if (message.broadcast <= rawGeneration) { reject(RawReason::Stale); return; }
        if (rawLive) { reject(RawReason::Busy); return; }
        if (control.cancelled(request.slot, request.generation) || !output.started() || output.stopped() || !healthy()) {
            reject(RawReason::Unavailable); return;
        }
        rawGeneration = message.broadcast;
        const bool started = output.startRaw(command.descriptor.get(), request.generation, rawGeneration);
        // RawOutput owns its duplicate. Every reply follows release of the
        // SCM_RIGHTS copy, including rejected/failed native attachments.
        command.descriptor.reset();
        if (!started) {
            output.stopRaw();
            rawControl.reply({RawOp::Rejected, message.slot, message.capture, message.broadcast, RawReason::AttachFailed});
            return;
        }
        rawLive = true;
        rawControl.reply({RawOp::Started, message.slot, message.capture, message.broadcast, RawReason::None});
    }
    const char *visibilityError() const {
        auto *app = [NSRunningApplication runningApplicationWithProcessIdentifier:request.identity.process];
        if (!app.bundleIdentifier || request.identity.application != app.bundleIdentifier.UTF8String) return "application_changed";
        NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, request.identity.window));
        if (windows.count != 1) return "window_missing";
        NSDictionary *window = windows.firstObject;
        if ([window[(id)kCGWindowNumber] unsignedIntValue] != request.identity.window ||
            [window[(id)kCGWindowOwnerPID] intValue] != request.identity.process) return "window_identity_changed";
        if (![window[(id)kCGWindowIsOnscreen] boolValue]) return "window_not_on_screen";
        return CGPreflightScreenCaptureAccess() ? nullptr : "screen_capture_permission_lost";
    }
    bool visible() const { return !visibilityError(); }
    const char *healthError() const {
        if (!source) return "source_missing";
        if (const char *error = visibilityError()) return error;
        if (!captureHealthy(obs_source_get_proc_handler(source))) return "capture_stream_stopped";
        return obs_source_get_width(source) == width && obs_source_get_height(source) == height ? nullptr : "source_raster_changed";
    }
    bool healthy() const { return !healthError(); }
    void traceStop(const char *reason) const {
        // Bounded enum-only diagnostics, never the selected title, path or PID.
        std::fprintf(stderr, "[obs-source-stop] slot=%u generation=%llu reason=%s\n",
            request.slot, (unsigned long long)request.generation, reason);
        if (std::strcmp(reason, "source_raster_changed") == 0)
            std::fprintf(stderr, "[obs-raster] expected=%ux%u observed=%ux%u\n", width, height,
                obs_source_get_width(source), obs_source_get_height(source));
    }
    void state(const char *error = "") const {
        char text[256];
        const int size = std::snprintf(text, sizeof(text),
            "{\"width\":%u,\"height\":%u,\"frames\":%u,\"error\":\"%s\"}",
            raster ? raster->width : 0, raster ? raster->height : 0, output.frames(), error);
        serviceRecord(2, request.slot, request.generation, text, static_cast<size_t>(size));
    }
    bool start(const ServiceControl &control, const std::function<void()> &pollRaw) {
        serviceRaw = pollRaw;
        const auto available = windowsForApplication(request.identity.application);
        unsigned matches = 0;
        for (const auto &window : available.windows) if (sameWindow(window.identity, request.identity)) matches++;
        if (!available.error.empty() || matches != 1 || !visible() || control.cancelled(request.slot, request.generation)) return false;
        obs_data_t *settings = obs_data_create();
        obs_data_set_int(settings, "type", 1);
        obs_data_set_int(settings, "window", request.identity.window);
        obs_data_set_bool(settings, "show_cursor", false);
        obs_data_set_bool(settings, "show_hidden_windows", false);
        source = obs_source_create_private("screen_capture", "selected-window", settings);
        obs_data_release(settings);
        if (!source) return false;
        const auto deadline = Clock::now() + std::chrono::seconds(3);
        while (obs_source_get_width(source) == 0 && captureHealthy(obs_source_get_proc_handler(source)) &&
            !control.cancelled(request.slot, request.generation) && Clock::now() < deadline) {
            pollRaw(); pumpEvents(.01);
        }
        width = obs_source_get_width(source); height = obs_source_get_height(source);
        raster = captureRaster(width, height, request.crop);
        if (!raster || !healthy() || control.cancelled(request.slot, request.generation)) return false;
        int pipeEnds[2];
        if (pipe(pipeEnds) != 0) return false;
        writer = pipeEnds[1];
        drain = std::thread([reader = pipeEnds[0], slot = request.slot, generation = request.generation] {
            std::array<uint8_t,16384> bytes{};
            while (true) {
                const auto count = read(reader, bytes.data(), bytes.size());
                if (count <= 0) break;
                serviceRecord(1, slot, generation, bytes.data(), count);
            }
            close(reader);
        });
        if (!output.prepare(source, *raster, request.slot, writer)) return false;
        const auto settling = Clock::now() + std::chrono::milliseconds(500);
        while (Clock::now() < settling && !control.cancelled(request.slot, request.generation)) {
            pollRaw(); pumpEvents(.01);
        }
        const bool started = healthy() && !control.cancelled(request.slot, request.generation) && output.start();
        const char *trace = std::getenv("SAUCE_OBS_AUDIO_DIAGNOSTICS");
        if (started && trace && std::string(trace) == "1" && request.identity.application.find("com.saucebunny.capture-test-") == 0)
            audioTrace = std::make_unique<AudioTrace>(source, request.slot, request.generation);
        return started;
    }
    ~Capture() {
        stopRaw(RawReason::SourceStopped);
        audioTrace.reset();
        output.stop(serviceRaw);
        if (writer >= 0) close(writer);
        if (drain.joinable()) drain.join();
        if (source) obs_source_release(source);
        obs_wait_for_destroy_queue();
        // All media from this generation precedes its terminal acknowledgement.
        serviceRecord(3, request.slot, request.generation, nullptr, 0);
    }
};
}
} // namespace sauce_obs

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    @autoreleasepool {
        sauce_obs::ServiceControl control;
        sauce_obs::RawControl rawControl;
        sauce_obs::Engine engine;
        if (!engine.initialize(argv[1], 1280, 720)) return 3;
        std::unique_ptr<sauce_obs::Capture> slots[2];
        const auto pollRaw = [&] {
            auto requests = rawControl.poll();
            for (auto &command : requests) {
                if (!rawControl.enabled()) break;
                const auto message = command.message;
                if (message.op == sauce_obs::RawOp::Stop) {
                    if (auto terminal = rawControl.terminal(message.slot, message.capture, message.broadcast)) {
                        rawControl.reply(*terminal); continue;
                    }
                }
                if (auto &capture = slots[message.slot]) capture->rawRequest(std::move(command), control);
                else {
                    command.descriptor.reset();
                    rawControl.reply({sauce_obs::RawOp::Rejected, message.slot, message.capture, message.broadcast,
                        sauce_obs::RawReason::Unavailable});
                }
            }
            for (auto &capture : slots) {
                if (capture && capture->rawLive && (rawControl.failed() || capture->output.rawFailed()))
                    capture->stopRaw(sauce_obs::RawReason::WriterFailed);
            }
        };
        auto nextReport = std::chrono::steady_clock::now();
        int result = 0;
        while (!control.stopping()) {
            pollRaw();
            if (auto command = control.next()) {
                if (slots[command->slot]) { result = 4; break; } // never replace a live slot implicitly
                slots[command->slot] = std::make_unique<sauce_obs::Capture>(*command, rawControl);
                if (!slots[command->slot]->start(control, pollRaw)) {
                    if (!control.cancelled(command->slot, command->generation)) slots[command->slot]->state("start_failed");
                    auto finished = std::move(slots[command->slot]);
                    finished.reset();
                }
            }
            for (auto &capture : slots) {
                if (!capture) continue;
                if (control.cancelled(capture->request.slot, capture->request.generation)) {
                    capture->stopRaw(sauce_obs::RawReason::Cancelled);
                    auto finished = std::move(capture); finished.reset(); continue;
                }
                const char *healthError = capture->healthError();
                if (healthError || capture->output.stopped()) {
                    capture->traceStop(healthError ? healthError : "encoder_stopped");
                    capture->state("source_stopped");
                    auto finished = std::move(capture); finished.reset(); continue;
                }
                if (std::chrono::steady_clock::now() >= nextReport) capture->state();
            }
            if (std::chrono::steady_clock::now() >= nextReport) nextReport = std::chrono::steady_clock::now() + std::chrono::seconds(1);
            sauce_obs::pumpEvents(.02);
        }
        // The stop callback may service the surviving slot. Detach each dying
        // slot first, including final shutdown, so it cannot reenter itself.
        for (auto &capture : slots) {
            auto finished = std::move(capture);
            finished.reset();
        }
        return result;
    }
}
