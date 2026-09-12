// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include "engine.hpp"
#include "capture-config.hpp"
#include <atomic>
#include <functional>
#include <memory>
#include <optional>
#include <sys/types.h>
namespace sauce_obs {
class RawOutput;
// One independent video canvas and stereo audio mix per program. The shared
// Engine outlives every output. A program owns its source; multiple consumers
// read its one encoded stream rather than attaching competing outputs.
class ProgramOutput final {
public:
    ProgramOutput();
    ~ProgramOutput();
    ProgramOutput(const ProgramOutput &) = delete;
    ProgramOutput &operator=(const ProgramOutput &) = delete;
    // destinationFd is an inherited descriptor supplied/drained by the owner,
    // never a URL or path supplied by a renderer. Slots 0/1 cannot overlap.
    bool prepare(obs_source_t *source, const Raster &raster, unsigned slot, int destinationFd);
    bool start();
    // The optional engine-thread callback keeps independent control channels
    // responsive during the bounded encoder stop wait. The owner must remove
    // a destructing program from any lookup the callback can use.
    void stop(const std::function<void()> &serviceControl = {});
    bool started() const { return started_.load(); }
    bool stopped() const { return stopped_.load(); }
    int code() const { return code_.load(); }
    uint32_t frames() const;
    // A separate opt-in native output. Starting encoded Preview never attaches
    // raw callbacks. The owner supplies an inherited private pipe, not a path.
    // After a failed attempt the owner MUST retire that pipe and pass a NEW
    // pipe with a newer broadcast generation. A partial old record is never
    // reusable. Each attempt gets a new RawOutput; a failed one stays poisoned.
    bool startRaw(int inheritedFd, uint64_t captureGeneration, uint64_t broadcastGeneration);
    void stopRaw();
    bool rawActive() const;
    bool rawFailed() const;
private:
    static void onStart(void *context, calldata_t *data);
    static void onStop(void *context, calldata_t *data);
    obs_canvas_t *canvas_ = nullptr;
    obs_scene_t *scene_ = nullptr;
    obs_output_t *output_ = nullptr;
    std::atomic<bool> started_{false}, stopped_{false};
    std::atomic<int> code_{0};
    unsigned mix_ = 0;
    uint32_t finalFrames_ = 0;
    bool attempted_ = false, requested_ = false, stopInProgress_ = false;
    std::unique_ptr<RawOutput> raw_;
    unsigned width_ = 0, height_ = 0, mixIndex_ = 0;
    uint64_t rawCaptureGeneration_ = 0, rawBroadcastGeneration_ = 0;
    bool rawLastFailure_ = false;
    dev_t encodedDevice_ = 0;
    ino_t encodedInode_ = 0;
    bool encodedPipe_ = false;
};

// The source is borrowed. stdout must be continuously drained by the app's
// bounded Program publisher, not by an individual webview/network consumer.
int writeProgram(obs_source_t *source, const Raster &raster,
                 const std::function<bool()> &sourceStillValid = [] { return true; },
                 const std::function<bool()> &shouldStop = [] { return false; },
                 std::optional<double> durationSeconds = 8.0);
}
