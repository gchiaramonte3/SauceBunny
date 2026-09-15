// SPDX-License-Identifier: GPL-2.0-or-later
// One owned libobs engine, two exact-window programs. No network listeners,
// arbitrary plugins, output paths, microphone, room or NDI publication.
#import <AppKit/AppKit.h>
#include "service-control.hpp"
#include "service-output.hpp"
#include "window-discovery.hpp"
#include "proof-output.hpp"
#include "capture-health.hpp"
#include "capture-start-failure.hpp"
#include "capture-audio.hpp"
#include "audio-trace.hpp"
#include "raw-control.hpp"
#include "region-overlay.hpp"
#include "include/sauce-display-crop.h"
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
    std::unique_ptr<RegionOverlay> overlay;
    bool overlayLive = false;
    pid_t audioParent = 0;
    bool overlayStopRequested = false, overlayEditPending = false;
    std::optional<sauce_display_crop> displayCrop;
    int writer = -1;
    std::thread drain;
    unsigned width = 0, height = 0;
    std::optional<Raster> raster;
    uint64_t rawGeneration = 0, rawCancelledThrough = 0;
    bool rawLive = false;
    std::function<void()> serviceRaw;
    CaptureStartFailure startFailure = CaptureStartFailure::Unknown;
    bool failedStart(CaptureStartFailure reason) { startFailure = reason; return false; }
    Capture(StartCapture value, RawControl &raw) : request(std::move(value)), rawControl(raw) {}
    void pollOverlay() {
        if (!overlay) return;
        const auto action = overlay->poll(request.generation);
        if (action == RegionAction::Stop || action == RegionAction::Invalidated) overlayStopRequested = true;
        if (action == RegionAction::Edit) overlayEditPending = true;
    }
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
        if (const auto *display = std::get_if<DisplayIdentity>(&request.target)) {
            if (request.audio) {
                NSRunningApplication *parent = sauce_display_audio_parent();
                if (!parent || parent.processIdentifier != audioParent) return "audio_parent_changed";
            }
            if (!overlay || !overlay->valid(request.generation)) return "display_topology_changed";
            const auto available = displaysForCapture();
            unsigned matches = 0;
            for (const auto &observed : available.displays) if (sameDisplay(*display, observed.identity)) matches++;
            if (!available.error.empty() || matches != 1) return "display_identity_changed";
            return CGPreflightScreenCaptureAccess() ? nullptr : "screen_capture_permission_lost";
        }
        const auto &identity = std::get<WindowIdentity>(request.target);
        auto *app = [NSRunningApplication runningApplicationWithProcessIdentifier:identity.process];
        if (!app.bundleIdentifier || identity.application != app.bundleIdentifier.UTF8String) return "application_changed";
        NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, identity.window));
        if (windows.count != 1) return "window_missing";
        NSDictionary *window = windows.firstObject;
        if ([window[(id)kCGWindowNumber] unsignedIntValue] != identity.window ||
            [window[(id)kCGWindowOwnerPID] intValue] != identity.process) return "window_identity_changed";
        if (![window[(id)kCGWindowIsOnscreen] boolValue]) return "window_not_on_screen";
        return CGPreflightScreenCaptureAccess() ? nullptr : "screen_capture_permission_lost";
    }
    bool visible() const { return !visibilityError(); }
    const char *healthError() const {
        if (overlayStopRequested) return "overlay_stop_requested";
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
    void state(const char *error = "", const char *action = "none") const {
        char text[256];
        const int size = std::snprintf(text, sizeof(text),
            "{\"width\":%u,\"height\":%u,\"frames\":%u,\"error\":\"%s\",\"action\":\"%s\"}",
            raster ? raster->width : 0, raster ? raster->height : 0, output.frames(), error, action);
        serviceRecord(2, request.slot, request.generation, text, static_cast<size_t>(size));
    }
    bool start(const ServiceControl &control, const std::function<void()> &pollRaw) {
        serviceRaw = pollRaw;
        if (const auto *display = std::get_if<DisplayIdentity>(&request.target)) {
            const auto available = displaysForCapture();
            unsigned matches = 0;
            for (const auto &observed : available.displays) if (sameDisplay(*display, observed.identity)) matches++;
            if (!available.error.empty()) return failedStart(CaptureStartFailure::DiscoveryFailed);
            if (matches != 1) return failedStart(CaptureStartFailure::DisplayIdentityChanged);
            if (request.audio && request.audioPolicy != 1) return failedStart(CaptureStartFailure::AudioPolicyUnsupported);
            if (!CGPreflightScreenCaptureAccess()) return failedStart(CaptureStartFailure::PermissionRequired);
            if (control.cancelled(request.slot, request.generation)) return failedStart(CaptureStartFailure::Cancelled);
            if (request.audio) {
                NSRunningApplication *parent = sauce_display_audio_parent();
                if (!parent || parent.processIdentifier != control.ownerProcess()) return failedStart(CaptureStartFailure::AudioParentUnavailable);
                audioParent = parent.processIdentifier;
            }
            const auto &g = display->geometry;
            sauce_display_crop accepted{};
            if (!sauce_display_crop_make(g.width, g.height, g.pixelWidth, g.pixelHeight,
                request.crop.x, request.crop.y, request.crop.width, request.crop.height, &accepted)) return failedStart(CaptureStartFailure::InvalidRegion);
            displayCrop = accepted;
            std::string error;
            overlay = RegionOverlay::create(request.slot, request.generation, display->id,
                {accepted.x, accepted.y, accepted.width, accepted.height}, error);
            if (!overlay) return failedStart(captureOverlayFailure(error));
        } else {
            const auto &identity = std::get<WindowIdentity>(request.target);
            const auto available = windowsForApplication(identity.application);
            unsigned matches = 0;
            for (const auto &window : available.windows) if (sameWindow(window.identity, identity)) matches++;
            if (!available.error.empty()) return failedStart(CaptureStartFailure::DiscoveryFailed);
            if (matches != 1) return failedStart(CaptureStartFailure::WindowIdentityChanged);
        }
        if (const char *error = visibilityError()) return failedStart(captureStartupHealthFailure(error));
        if (control.cancelled(request.slot, request.generation)) return failedStart(CaptureStartFailure::Cancelled);
        obs_data_t *settings = obs_data_create();
        obs_data_t *defaults = obs_get_source_defaults("screen_capture");
        const bool audioConfigured = configureCaptureAudio(settings, defaults, request.audio);
        const bool displaySupported = !overlay || (obs_data_get_int(defaults, "sauce_overlay_policy_version") == 1 &&
            obs_data_get_int(defaults, "sauce_display_region_policy_version") == 1 &&
            configureDisplayCaptureAudio(settings, defaults, request.audio));
        obs_data_release(defaults);
        if (!audioConfigured || !displaySupported) {
            obs_data_release(settings);
            return failedStart(!audioConfigured ? CaptureStartFailure::AudioPolicyUnsupported : CaptureStartFailure::DisplayPolicyUnsupported);
        }
        if (const auto *display = std::get_if<DisplayIdentity>(&request.target)) {
            obs_data_set_int(settings, "type", 0);
            obs_data_set_string(settings, "display_uuid", display->uuid.c_str());
            obs_data_set_double(settings, "sauce_display_x", display->geometry.x);
            obs_data_set_double(settings, "sauce_display_y", display->geometry.y);
            obs_data_set_int(settings, "sauce_display_width", display->geometry.width);
            obs_data_set_int(settings, "sauce_display_height", display->geometry.height);
            obs_data_set_int(settings, "sauce_display_pixel_width", display->geometry.pixelWidth);
            obs_data_set_int(settings, "sauce_display_pixel_height", display->geometry.pixelHeight);
            obs_data_set_int(settings, "sauce_overlay_owner_pid", overlay->ownerPid());
            obs_data_array_t *ids = obs_data_array_create();
            for (const auto id : overlay->windowIds()) {
                obs_data_t *entry = obs_data_create(); obs_data_set_int(entry, "id", id);
                obs_data_array_push_back(ids, entry); obs_data_release(entry);
            }
            obs_data_set_array(settings, "sauce_overlay_window_ids", ids); obs_data_array_release(ids);
            obs_data_set_double(settings, "sauce_region_x", request.crop.x);
            obs_data_set_double(settings, "sauce_region_y", request.crop.y);
            obs_data_set_double(settings, "sauce_region_width", request.crop.width);
            obs_data_set_double(settings, "sauce_region_height", request.crop.height);
        } else {
            obs_data_set_int(settings, "type", 1);
            obs_data_set_int(settings, "window", std::get<WindowIdentity>(request.target).window);
        }
        obs_data_set_bool(settings, "show_cursor", false);
        obs_data_set_bool(settings, "show_hidden_windows", false);
        source = obs_source_create_private("screen_capture", "selected-source", settings);
        obs_data_release(settings);
        if (!source) return failedStart(CaptureStartFailure::SourceCreationFailed);
        const auto deadline = Clock::now() + std::chrono::seconds(3);
        while (obs_source_get_width(source) == 0 && captureHealthy(obs_source_get_proc_handler(source)) &&
            !control.cancelled(request.slot, request.generation) && !overlayStopRequested && Clock::now() < deadline) {
            pollRaw(); pumpEvents(.01);
        }
        width = obs_source_get_width(source); height = obs_source_get_height(source);
        // OBS can retain a source object even when module initialization failed.
        // Name that boundary before comparing a missing raster to the crop.
        if (!captureHealthy(obs_source_get_proc_handler(source))) return failedStart(CaptureStartFailure::SourceInitializationFailed);
        if (!width || !height) return failedStart(CaptureStartFailure::FirstFrameUnavailable);
        if (displayCrop && (width != displayCrop->pixels_wide || height != displayCrop->pixels_high)) return failedStart(CaptureStartFailure::SourceRasterMismatch);
        // ScreenCaptureKit applies the display crop before delivery. Windows
        // retain their established private-canvas crop path unchanged.
        raster = captureRaster(width, height, overlay ? Crop{} : request.crop);
        if (!raster) return failedStart(CaptureStartFailure::InvalidRegion);
        if (const char *error = healthError()) return failedStart(captureStartupHealthFailure(error));
        if (control.cancelled(request.slot, request.generation)) return failedStart(CaptureStartFailure::Cancelled);
        int pipeEnds[2];
        if (pipe(pipeEnds) != 0) return failedStart(CaptureStartFailure::OutputPipeFailed);
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
        if (!output.prepare(source, *raster, request.slot, writer)) return failedStart(CaptureStartFailure::OutputPreparationFailed);
        const auto settling = Clock::now() + std::chrono::milliseconds(500);
        while (Clock::now() < settling && !control.cancelled(request.slot, request.generation) && !overlayStopRequested) {
            pollRaw(); pumpEvents(.01);
        }
        if (const char *error = healthError()) return failedStart(captureStartupHealthFailure(error));
        if (control.cancelled(request.slot, request.generation)) return failedStart(CaptureStartFailure::Cancelled);
        if (!output.start()) return failedStart(CaptureStartFailure::OutputStartFailed);
        const char *trace = std::getenv("SAUCE_OBS_AUDIO_DIAGNOSTICS");
        const auto *window = std::get_if<WindowIdentity>(&request.target);
        if (window && trace && std::string(trace) == "1" && window->application.find("com.saucebunny.capture-test-") == 0)
            audioTrace = std::make_unique<AudioTrace>(source, request.slot, request.generation);
        return true;
    }
    ~Capture() {
        stopRaw(RawReason::SourceStopped);
        audioTrace.reset();
        output.stop(serviceRaw);
        if (writer >= 0) close(writer);
        if (drain.joinable()) drain.join();
        if (source) obs_source_release(source);
        obs_wait_for_destroy_queue();
        if (overlay) overlay->close(request.generation);
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
            // Dispatch own AppKit controls during another slot's startup or
            // drain too. Only latch actions here: never destroy/reenter a slot
            // from the callback used by ProgramOutput::stop.
            for (auto &capture : slots) if (capture) capture->pollOverlay();
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
                    if (slots[command->slot]->overlayStopRequested) slots[command->slot]->state("", "stop");
                    else if (!control.cancelled(command->slot, command->generation))
                        slots[command->slot]->state(sauce_obs::captureStartFailureCode(slots[command->slot]->startFailure));
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
                if (capture->overlay) {
                    if (capture->overlayEditPending && !capture->overlayStopRequested) {
                        capture->overlayEditPending = false; capture->state("", "edit");
                    }
                    if (capture->overlayStopRequested) {
                        capture->state("", "stop");
                        capture->stopRaw(sauce_obs::RawReason::SourceStopped);
                        auto finished = std::move(capture); finished.reset(); continue;
                    }
                    if (!capture->overlayLive && capture->output.frames() > 0 && capture->healthy()) {
                        capture->overlayLive = capture->overlay->markLive(capture->request.generation);
                        if (!capture->overlayLive) {
                            capture->state("", "stop");
                            auto finished = std::move(capture); finished.reset(); continue;
                        }
                    }
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
