// SPDX-License-Identifier: GPL-2.0-or-later
#include "proof-output.hpp"
#include "raw-output.hpp"
#include "raw-frame.hpp"
#include <atomic>
#include <chrono>
#include <cstdio>
#include <fcntl.h>
#include <sys/stat.h>

namespace sauce_obs {
namespace {
std::atomic<unsigned> occupiedMixes{0};
}
ProgramOutput::ProgramOutput() = default;
ProgramOutput::~ProgramOutput() { stop(); }
void ProgramOutput::onStart(void *context, calldata_t *) {
    static_cast<ProgramOutput *>(context)->started_ = true;
}
void ProgramOutput::onStop(void *context, calldata_t *data) {
    auto *state = static_cast<ProgramOutput *>(context);
    state->code_ = static_cast<int>(calldata_int(data, "code"));
    state->stopped_ = true;
}
bool ProgramOutput::prepare(obs_source_t *source, const Raster &raster, unsigned slot, int destinationFd) {
    if (attempted_ || !source || slot > 1 || destinationFd < 1 || fcntl(destinationFd, F_GETFD) < 0 ||
        raster.width < 2 || raster.height < 2 || raster.width > 1920 || raster.height > 1080 ||
        raster.width % 2 || raster.height % 2) return false;
    struct stat destinationInfo{};
    if (fstat(destinationFd, &destinationInfo) != 0) return false;
    attempted_ = true;
    const unsigned mix = 1u << slot;
    if (occupiedMixes.fetch_or(mix) & mix) return false;
    mix_ = mix;
    encodedDevice_ = destinationInfo.st_dev;
    encodedInode_ = destinationInfo.st_ino;
    encodedPipe_ = S_ISFIFO(destinationInfo.st_mode);
    mixIndex_ = slot;
    width_ = raster.width;
    height_ = raster.height;
    obs_video_info video = {};
    if (!obs_get_video_info(&video)) return false;
    video.base_width = video.output_width = raster.width;
    video.base_height = video.output_height = raster.height;
    const std::string name = "program-" + std::to_string(slot);
    canvas_ = obs_canvas_create_private(name.c_str(), &video, PROGRAM | EPHEMERAL);
    if (!canvas_ || !obs_canvas_has_video(canvas_)) return false;
    scene_ = obs_canvas_scene_create(canvas_, name.c_str());
    if (!scene_) return false;
    obs_sceneitem_t *item = obs_scene_add(scene_, source);
    if (!item) return false;
    obs_source_set_monitoring_type(source, OBS_MONITORING_TYPE_NONE);
    obs_source_set_audio_mixers(source, mix_);
    obs_source_set_audio_mixers(obs_scene_get_source(scene_), mix_);
    obs_sceneitem_crop crop = {static_cast<int>(raster.left), static_cast<int>(raster.top),
                              static_cast<int>(raster.right), static_cast<int>(raster.bottom)};
    obs_sceneitem_set_crop(item, &crop);
    vec2 bounds = {};
    bounds.x = static_cast<float>(raster.width);
    bounds.y = static_cast<float>(raster.height);
    obs_sceneitem_set_bounds_type(item, OBS_BOUNDS_SCALE_INNER);
    obs_sceneitem_set_bounds(item, &bounds);
    obs_canvas_set_channel(canvas_, 0, obs_scene_get_source(scene_));

    obs_data_t *settings = obs_data_create();
    const std::string destination = "pipe:" + std::to_string(destinationFd);
    obs_data_set_string(settings, "url", destination.c_str());
    obs_data_set_string(settings, "format_name", "mp4");
    obs_data_set_string(settings, "muxer_settings",
                        "movflags=frag_keyframe+empty_moov+default_base_moof flush_packets=1");
    obs_data_set_string(settings, "video_encoder", "h264_videotoolbox");
    obs_data_set_string(settings, "video_settings", "realtime=1 allow_sw=0 bf=0 profile=main level=40");
    obs_data_set_int(settings, "video_bitrate", 6000);
    // Each three-frame fragment must be independently decodable by Preview.
    obs_data_set_int(settings, "gop_size", 3);
    obs_data_set_string(settings, "audio_encoder", "aac");
    obs_data_set_int(settings, "audio_bitrate", 160);
    output_ = obs_output_create("ffmpeg_output", name.c_str(), settings, nullptr);
    obs_data_release(settings);
    if (!output_) return false;
    obs_output_set_media(output_, obs_canvas_get_video(canvas_), obs_get_audio());
    obs_output_set_mixers(output_, mix_);
    auto *signals = obs_output_get_signal_handler(output_);
    signal_handler_connect(signals, "start", onStart, this);
    signal_handler_connect(signals, "stop", onStop, this);
    return true;
}
bool ProgramOutput::start() {
    if (!output_ || requested_) return false;
    requested_ = true;
    return obs_output_start(output_);
}
uint32_t ProgramOutput::frames() const { return output_ ? obs_output_get_total_frames(output_) : finalFrames_; }
bool ProgramOutput::startRaw(int inheritedFd, uint64_t captureGeneration, uint64_t broadcastGeneration) {
    if (!output_ || !started() || stopped() || raw_ ||
        !captureGeneration || captureGeneration > rawMaxGeneration ||
        !broadcastGeneration || broadcastGeneration > rawMaxGeneration ||
        broadcastGeneration <= rawBroadcastGeneration_ ||
        (rawCaptureGeneration_ && rawCaptureGeneration_ != captureGeneration)) return false;
    struct stat rawPipe{};
    // Descriptor numbers alone miss dup(). Reject an alias before RawOutput
    // can set shared O_NONBLOCK flags or write raw bytes into the encoded pipe.
    // Rejection must also leave generation 1 available for the correct pipe.
    if (fstat(inheritedFd, &rawPipe) != 0 || !S_ISFIFO(rawPipe.st_mode) ||
        (encodedPipe_ && rawPipe.st_dev == encodedDevice_ && rawPipe.st_ino == encodedInode_)) return false;
    rawCaptureGeneration_ = captureGeneration;
    rawBroadcastGeneration_ = broadcastGeneration;
    auto raw = std::make_unique<RawOutput>();
    if (!raw->start(obs_canvas_get_video(canvas_), obs_get_audio(), mixIndex_, width_, height_,
                    inheritedFd, captureGeneration, broadcastGeneration)) {
        rawLastFailure_ = rawLastFailure_ || raw->failed();
        return false;
    }
    raw_ = std::move(raw);
    rawLastFailure_ = false;
    return true;
}
bool ProgramOutput::rawActive() const { return raw_ && raw_->active(); }
bool ProgramOutput::rawFailed() const { return rawLastFailure_ || (raw_ && raw_->failed()); }
void ProgramOutput::stopRaw() {
    if (!raw_) return;
    raw_->stop();
    rawLastFailure_ = rawLastFailure_ || raw_->failed();
    raw_.reset();
}
void ProgramOutput::stop(const std::function<void()> &serviceControl) {
    if (stopInProgress_) return;
    stopInProgress_ = true;
    struct StopGuard {
        bool &active;
        ~StopGuard() { active = false; }
    } guard{stopInProgress_};
    // Disconnect and drain raw callbacks while their private canvas/mix still
    // exists. A failed raw consumer must never stop the encoded output.
    stopRaw();
    if (output_) {
        if (requested_) {
            obs_output_force_stop(output_);
            const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
            while (!stopped_ && std::chrono::steady_clock::now() < deadline) {
                pumpEvents(0.01);
                if (serviceControl) serviceControl();
            }
        }
        auto *signals = obs_output_get_signal_handler(output_);
        signal_handler_disconnect(signals, "start", onStart, this);
        signal_handler_disconnect(signals, "stop", onStop, this);
        finalFrames_ = obs_output_get_total_frames(output_);
        obs_output_release(output_);
        output_ = nullptr;
    }
    if (canvas_) obs_canvas_set_channel(canvas_, 0, nullptr);
    if (scene_) {
        obs_canvas_scene_remove(scene_);
        obs_scene_release(scene_);
        scene_ = nullptr;
    }
    if (canvas_) { obs_canvas_release(canvas_); canvas_ = nullptr; }
    if (mix_) { occupiedMixes.fetch_and(~mix_); mix_ = 0; }
}
int writeProgram(obs_source_t *source, const Raster &raster, const std::function<bool()> &sourceStillValid,
                 const std::function<bool()> &shouldStop, std::optional<double> durationSeconds) {
    ProgramOutput output;
    bool valid = sourceStillValid();
    if (output.prepare(source, raster, 0, 1)) {
        pumpEvents(0.5);
        valid = sourceStillValid();
        if (valid && !shouldStop() && output.start()) {
            const auto began = std::chrono::steady_clock::now();
            auto report = began;
            while (!output.stopped() && valid && !shouldStop() &&
                   (!durationSeconds || std::chrono::duration<double>(std::chrono::steady_clock::now() - began).count() < *durationSeconds)) {
                pumpEvents(0.05);
                valid = sourceStillValid();
                if (std::chrono::steady_clock::now() >= report) {
                    std::fprintf(stderr, "{\"event\":\"program-state\",\"width\":%u,\"height\":%u,\"fps\":30,\"frames\":%u}\n",
                                 raster.width, raster.height, output.frames());
                    report = std::chrono::steady_clock::now() + std::chrono::seconds(1);
                }
            }
        }
    }
    output.stop();
    std::fprintf(stderr, "{\"event\":\"media-proof\",\"started\":%s,\"stopped\":%s,\"code\":%d,\"sourceValid\":%s}\n",
                 output.started() ? "true" : "false", output.stopped() ? "true" : "false", output.code(), valid ? "true" : "false");
    return valid && output.started() && output.stopped() && output.code() == 0 ? 0 : 5;
}
} // namespace sauce_obs
