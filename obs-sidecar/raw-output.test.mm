// SPDX-License-Identifier: GPL-2.0-or-later
// Native generated-media proof. No discovery, device capture, or network.
// Usage: <runtime> <primary 640x360 stereo fixture> <survivor fixture> <NEW output directory>
// Files: encoded.mp4, survivor-encoded.mp4, raw.sbr, survivor.sbr, fresh.sbr,
// retired-stalled.sbr (failed channel, possibly a partial record),
// first-frame.bgra (320x180 BGRA), audio.f32 (48 kHz stereo interleaved LE).
// Survivor image/audio samples use the same names under survivor-samples/.
// silent-encoded.mp4 and silent.sbr prove output compatibility with no audio input.
#import <Foundation/Foundation.h>
#include "proof-output.hpp"
#include "raw-frame.hpp"
#include <util/platform.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <filesystem>
#include <map>
#include <mutex>
#include <poll.h>
#include <stdexcept>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

namespace {
using Clock = std::chrono::steady_clock;
constexpr uint64_t second = 1000000000ULL;
unsigned checks = 0;
void check(bool condition, const char *message) {
    ++checks;
    if (!condition) throw std::runtime_error(message);
}
template<class Predicate> bool await(double seconds, Predicate predicate) {
    const auto deadline = Clock::now() + std::chrono::duration<double>(seconds);
    do {
        if (predicate()) return true;
        sauce_obs::pumpEvents(.01);
    } while (Clock::now() < deadline);
    return predicate();
}
struct FD {
    int value = -1;
    FD() = default;
    explicit FD(int descriptor) : value(descriptor) {}
    ~FD() { if (value >= 0) close(value); }
    FD(const FD &) = delete;
    FD &operator=(const FD &) = delete;
};
struct Pipe {
    FD read, write;
    Pipe() {
        int descriptors[2];
        if (pipe(descriptors)) throw std::runtime_error("pipe_create_failed");
        read.value = descriptors[0]; write.value = descriptors[1];
        if (fcntl(read.value, F_SETFL, fcntl(read.value, F_GETFL) | O_NONBLOCK) < 0)
            throw std::runtime_error("pipe_nonblocking_failed");
    }
};
int createFile(const std::filesystem::path &path) {
    const int descriptor = open(path.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (descriptor < 0) throw std::runtime_error("new_artifact_create_failed");
    return descriptor;
}
bool writeAll(int descriptor, const uint8_t *bytes, size_t size) {
    while (size) {
        const ssize_t written = write(descriptor, bytes, size);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) return false;
        bytes += written; size -= static_cast<size_t>(written);
    }
    return true;
}
struct TrackStats {
    uint64_t capture = 0, broadcast = 0;
    uint64_t videoFrames = 0, audioFrames = 0, audioBlocks = 0;
    uint64_t firstVideo = 0, lastVideo = 0, firstAudio = 0, lastAudio = 0;
    std::array<double, 2> energy{};
    bool color = false;
};
struct Snapshot {
    uint64_t bytes = 0;
    size_t pendingBytes = 0;
    bool eof = false;
    std::string error;
    std::map<uint64_t, TrackStats> generations;
};

// Both encoded streams are drained from dedicated threads even while the
// main test waits for lifecycle transitions. Raw parsing tolerates arbitrary
// pipe fragmentation and never reads a payload before validating its header.
class Drain {
public:
    Drain(int input, const std::filesystem::path &file, uint64_t capture = 0,
          uint64_t earliestTimestamp = 0, const std::filesystem::path &sampleDirectory = {},
          uint64_t expectedBroadcast = 0)
        : input_(input), file_(createFile(file)), capture_(capture), earliest_(earliestTimestamp),
          expectedBroadcast_(expectedBroadcast) {
        if (!sampleDirectory.empty()) {
            image_.value = createFile(sampleDirectory / "first-frame.bgra");
            audio_.value = createFile(sampleDirectory / "audio.f32");
        }
        worker_ = std::thread([this] { run(); });
    }
    ~Drain() { stop(); }
    Drain(const Drain &) = delete;
    Drain &operator=(const Drain &) = delete;
    Snapshot snapshot() const {
        std::lock_guard<std::mutex> lock(mutex_);
        Snapshot copy = state_;
        copy.pendingBytes = pending_.size();
        return copy;
    }
    void stop() {
        stopping_ = true;
        if (worker_.joinable()) worker_.join();
    }
private:
    void fail(const char *message) { if (state_.error.empty()) state_.error = message; }
    void observe(const sauce_obs::RawFrameInfo &frame, const uint8_t *payload) {
        const bool allowedBroadcast = expectedBroadcast_ ? frame.broadcastGeneration == expectedBroadcast_ :
            frame.broadcastGeneration <= (capture_ == 11 ? 2u : 1u);
        if (frame.captureGeneration != capture_ || frame.broadcastGeneration < latestGeneration_ ||
            !allowedBroadcast) {
            fail("stale_or_wrong_generation"); return;
        }
        latestGeneration_ = frame.broadcastGeneration;
        // OBS timestamps are nanoseconds in its monotonic clock domain. This
        // rejects independently zero-based audio/video or restart epochs.
        if (frame.timestamp < earliest_ || frame.timestamp > os_gettime_ns() + second) {
            fail("source_timestamp_rebased"); return;
        }
        auto &stats = state_.generations[frame.broadcastGeneration];
        stats.capture = frame.captureGeneration; stats.broadcast = frame.broadcastGeneration;
        if (frame.kind == 1) {
            if (frame.width != 320 || frame.height != 180 || frame.stride != 1280 ||
                frame.payloadBytes != 230400) { fail("wrong_crop_raster"); return; }
            if (lastVideo_ && frame.timestamp <= lastVideo_) { fail("video_timestamp_not_monotonic"); return; }
            lastVideo_ = frame.timestamp;
            if (!stats.firstVideo) stats.firstVideo = frame.timestamp;
            stats.lastVideo = frame.timestamp;
            ++stats.videoFrames;
            for (size_t offset = 0; offset < frame.payloadBytes; offset += 4 * 97)
                if (std::max({payload[offset], payload[offset + 1], payload[offset + 2]}) > 32 &&
                    std::max({payload[offset], payload[offset + 1], payload[offset + 2]}) -
                    std::min({payload[offset], payload[offset + 1], payload[offset + 2]}) > 16)
                    stats.color = true;
            if (image_.value >= 0 && !savedImage_) {
                if (!writeAll(image_.value, payload, frame.payloadBytes)) fail("image_artifact_write_failed");
                savedImage_ = true;
            }
        } else {
            if (lastAudio_ && frame.timestamp <= lastAudio_) { fail("audio_timestamp_not_monotonic"); return; }
            lastAudio_ = frame.timestamp;
            if (!stats.firstAudio) stats.firstAudio = frame.timestamp;
            stats.lastAudio = frame.timestamp;
            ++stats.audioBlocks; stats.audioFrames += frame.frames;
            std::vector<uint8_t> interleaved(frame.payloadBytes);
            for (uint32_t sample = 0; sample < frame.frames; ++sample) {
                for (unsigned channel = 0; channel < 2; ++channel) {
                    const uint8_t *value = payload + (channel * frame.frames + sample) * 4;
                    const uint32_t bits = static_cast<uint32_t>(value[0]) |
                        static_cast<uint32_t>(value[1]) << 8 | static_cast<uint32_t>(value[2]) << 16 |
                        static_cast<uint32_t>(value[3]) << 24;
                    float amplitude;
                    std::memcpy(&amplitude, &bits, sizeof(amplitude));
                    if (!std::isfinite(amplitude) || std::abs(amplitude) > 1.05f) {
                        fail("invalid_planar_float_sample"); return;
                    }
                    stats.energy[channel] += static_cast<double>(amplitude) * amplitude;
                    std::memcpy(interleaved.data() + (sample * 2 + channel) * 4, value, 4);
                }
            }
            if (audio_.value >= 0 && frame.broadcastGeneration == 1 &&
                !writeAll(audio_.value, interleaved.data(), interleaved.size())) fail("audio_artifact_write_failed");
        }
    }
    void accept(const uint8_t *bytes, size_t size) {
        state_.bytes += size;
        if (!writeAll(file_.value, bytes, size)) fail("stream_artifact_write_failed");
        if (!capture_ || !state_.error.empty()) return;
        pending_.insert(pending_.end(), bytes, bytes + size);
        size_t consumed = 0;
        while (pending_.size() - consumed >= sauce_obs::rawHeaderSize) {
            const auto frame = sauce_obs::readRawFrameHeader(pending_.data() + consumed, sauce_obs::rawHeaderSize);
            if (!frame) { fail("invalid_raw_header"); pending_.clear(); return; }
            const size_t recordSize = sauce_obs::rawHeaderSize + frame->payloadBytes;
            if (pending_.size() - consumed < recordSize) break;
            observe(*frame, pending_.data() + consumed + sauce_obs::rawHeaderSize);
            consumed += recordSize;
        }
        if (consumed) pending_.erase(pending_.begin(), pending_.begin() + static_cast<ptrdiff_t>(consumed));
        if (pending_.size() > sauce_obs::rawHeaderSize + sauce_obs::rawMaxPayload) fail("raw_parser_buffer_exceeded");
    }
    void run() {
        std::array<uint8_t, 16381> bytes{};
        unsigned iteration = 0;
        while (true) {
            // The first read splits the header; subsequent prime sizes split
            // payloads and record boundaries without throttling the producer.
            const size_t wanted = iteration++ == 0 ? 17 : bytes.size();
            const ssize_t count = read(input_, bytes.data(), wanted);
            if (count > 0) {
                std::lock_guard<std::mutex> lock(mutex_);
                accept(bytes.data(), static_cast<size_t>(count));
                continue;
            }
            if (count < 0 && errno == EINTR) continue;
            if (count == 0) {
                std::lock_guard<std::mutex> lock(mutex_);
                state_.eof = true;
                return;
            }
            if (stopping_) return;
            if (errno != EAGAIN && errno != EWOULDBLOCK) {
                std::lock_guard<std::mutex> lock(mutex_);
                fail("stream_read_failed"); return;
            }
            pollfd descriptor{input_, POLLIN, 0};
            (void)poll(&descriptor, 1, 10);
        }
    }
    int input_;
    FD file_, image_, audio_;
    uint64_t capture_, earliest_, expectedBroadcast_;
    uint64_t latestGeneration_ = 0, lastVideo_ = 0, lastAudio_ = 0;
    bool savedImage_ = false;
    mutable std::mutex mutex_;
    Snapshot state_;
    std::vector<uint8_t> pending_;
    std::atomic<bool> stopping_{false};
    std::thread worker_;
};
struct Source {
    obs_source_t *value = nullptr;
    explicit Source(const std::filesystem::path &fixture) {
        obs_data_t *settings = obs_data_create();
        obs_data_set_bool(settings, "is_local_file", true);
        obs_data_set_string(settings, "local_file", fixture.c_str());
        obs_data_set_bool(settings, "looping", true);
        obs_data_set_bool(settings, "restart_on_activate", true);
        value = obs_source_create_private("ffmpeg_source", "generated-raw-test", settings);
        obs_data_release(settings);
        check(value != nullptr, "fixture_source_failed");
    }
    ~Source() { if (value) obs_source_release(value); }
};
bool populated(const Drain &drain, uint64_t generation) {
    const auto state = drain.snapshot();
    const auto found = state.generations.find(generation);
    return state.error.empty() && found != state.generations.end() &&
        found->second.videoFrames >= 30 && found->second.audioFrames >= 48000;
}
void healthy(const Snapshot &state, uint64_t generation) {
    check(state.error.empty(), state.error.c_str());
    const auto found = state.generations.find(generation);
    check(found != state.generations.end(), "generation_population_missing");
    const auto &stats = found->second;
    check(stats.videoFrames >= 30 && stats.color, "real_crop_video_population_missing");
    check(stats.audioFrames >= 48000 && stats.audioBlocks >= 10, "audio_population_missing");
    check(stats.energy[0] / stats.audioFrames > .00001 && stats.energy[1] / stats.audioFrames > .00001,
          "stereo_audio_is_silent");
}
double boundedStop(sauce_obs::ProgramOutput &program) {
    const auto began = Clock::now();
    program.stopRaw();
    const double milliseconds = std::chrono::duration<double, std::milli>(Clock::now() - began).count();
    check(milliseconds < 1000, "raw_stop_exceeded_one_second");
    check(!program.rawActive() && !program.rawFailed(), "healthy_raw_stop_state_incorrect");
    return milliseconds;
}
void quiescent(const Drain &drain) {
    sauce_obs::pumpEvents(.15);
    const auto before = drain.snapshot();
    check(before.error.empty(), before.error.c_str());
    check(before.pendingBytes == 0, "raw_stop_left_partial_record");
    sauce_obs::pumpEvents(.25);
    check(drain.snapshot().bytes == before.bytes, "raw_bytes_arrived_after_stop");
}
void silentInput(const std::filesystem::path &directory) {
    // An empty private scene has no devices, media, or audio-producing source.
    // This tests the mix downstream of acquisition being disabled, not a mute.
    struct Scene {
        obs_scene_t *value = obs_scene_create_private("generated-silent-input");
        ~Scene() { if (value) obs_scene_release(value); }
    } scene;
    check(scene.value != nullptr, "silent_scene_creation_failed");
    Pipe encodedPipe, rawPipe;
    Drain encoded(encodedPipe.read.value, directory / "silent-encoded.mp4");
    Drain raw(rawPipe.read.value, directory / "silent.sbr", 33, os_gettime_ns(), {}, 1);
    sauce_obs::ProgramOutput program;
    const sauce_obs::Raster raster{0, 0, 0, 0, 320, 180};
    check(program.prepare(obs_scene_get_source(scene.value), raster, 0, encodedPipe.write.value),
          "silent_program_prepare_failed");
    check(program.start(), "silent_program_start_failed");
    check(await(5, [&] { return program.frames() >= 30; }), "silent_encoded_warmup_failed");
    check(program.startRaw(rawPipe.write.value, 33, 1), "silent_raw_start_failed");
    check(await(4, [&] { return populated(raw, 1); }), "silent_raw_population_timeout");
    boundedStop(program);
    quiescent(raw);
    program.stop();
    sauce_obs::pumpEvents(.15);
    raw.stop(); encoded.stop();
    const auto state = raw.snapshot();
    check(state.error.empty(), state.error.c_str());
    check(state.generations.size() == 1 && state.pendingBytes == 0, "silent_raw_records_incomplete");
    const auto &track = state.generations.at(1);
    check(track.videoFrames >= 30 && track.audioFrames >= 48000, "silent_av_population_missing");
    check(track.energy[0] == 0 && track.energy[1] == 0, "no_audio_input_leaked_audio");
    check(program.code() == 0 && program.stopped() && encoded.snapshot().error.empty() &&
          encoded.snapshot().bytes > 0, "silent_encoded_output_failed");
}
void printGeneration(const TrackStats &s, bool &first) {
    if (!first) std::putchar(',');
    first = false;
    std::printf("{\"capture\":%llu,\"broadcast\":%llu,\"videoFrames\":%llu,\"audioFrames\":%llu,"
        "\"firstVideoTimestamp\":%llu,\"lastVideoTimestamp\":%llu,\"firstAudioTimestamp\":%llu,"
        "\"lastAudioTimestamp\":%llu,\"rms\":[%.8f,%.8f]}",
        (unsigned long long)s.capture, (unsigned long long)s.broadcast,
        (unsigned long long)s.videoFrames, (unsigned long long)s.audioFrames,
        (unsigned long long)s.firstVideo, (unsigned long long)s.lastVideo,
        (unsigned long long)s.firstAudio, (unsigned long long)s.lastAudio,
        s.audioFrames ? std::sqrt(s.energy[0] / s.audioFrames) : 0,
        s.audioFrames ? std::sqrt(s.energy[1] / s.audioFrames) : 0);
}
} // namespace

int main(int argc, char **argv) {
    @autoreleasepool {
        bool passed = false;
        std::string failure;
        Snapshot primaryState, survivorState, freshState;
        uint64_t retiredChannelBytes = 0;
        bool retiredChannelEOF = false;
        uint32_t primaryBefore = 0, primaryAfter = 0, survivorBefore = 0, survivorAfter = 0;
        double stopMilliseconds = 0, stallMilliseconds = 0;
        try {
            check(argc == 5, "usage_runtime_primary_fixture_survivor_fixture_NEW_output_directory");
            const auto runtime = std::filesystem::canonical(argv[1]);
            const auto fixture = std::filesystem::canonical(argv[2]);
            const auto survivorFixture = std::filesystem::canonical(argv[3]);
            check(std::filesystem::is_regular_file(fixture), "fixture_not_regular_file");
            check(std::filesystem::is_regular_file(survivorFixture), "survivor_fixture_not_regular_file");
            const std::filesystem::path directory(argv[4]);
            check(std::filesystem::create_directory(directory), "output_directory_must_be_new");
            const auto survivorSamples = directory / "survivor-samples";
            check(std::filesystem::create_directory(survivorSamples), "survivor_sample_directory_must_be_new");
            sauce_obs::Engine engine;
            check(engine.initialize(runtime, 640, 360), "engine_initialization_failed");
            const uint64_t earliestTimestamp = os_gettime_ns();
            Source source(fixture), otherSource(survivorFixture);
            Pipe encodedPipe, otherEncodedPipe, rawPipe, otherRawPipe, stalledPipe;
            Drain encoded(encodedPipe.read.value, directory / "encoded.mp4");
            Drain otherEncoded(otherEncodedPipe.read.value, directory / "survivor-encoded.mp4");
            Drain raw(rawPipe.read.value, directory / "raw.sbr", 11, earliestTimestamp, directory);
            Drain otherRaw(otherRawPipe.read.value, directory / "survivor.sbr", 22, earliestTimestamp, survivorSamples);
            sauce_obs::ProgramOutput program, survivor;
            const sauce_obs::Raster crop{160, 90, 160, 90, 320, 180};
            check(program.prepare(source.value, crop, 0, encodedPipe.write.value), "primary_prepare_failed");
            check(survivor.prepare(otherSource.value, crop, 1, otherEncodedPipe.write.value), "survivor_prepare_failed");
            check(!program.rawActive() && !program.rawFailed() && !survivor.rawActive(), "raw_not_disabled_by_default");
            check(program.start() && survivor.start(), "encoded_start_failed");
            check(await(5, [&] { return program.frames() >= 30 && survivor.frames() >= 30; }), "encoded_warmup_failed");
            check(obs_source_get_width(source.value) == 640 && obs_source_get_height(source.value) == 360,
                  "fixture_must_be_640x360");
            check(raw.snapshot().bytes == 0 && otherRaw.snapshot().bytes == 0, "raw_bytes_before_explicit_start");
            check(encoded.snapshot().bytes > 0 && otherEncoded.snapshot().bytes > 0, "encoded_drain_population_missing");
            {
                const auto beforeAlias = program.frames();
                const int encodedFlags = fcntl(encodedPipe.write.value, F_GETFL);
                check(encodedFlags >= 0, "encoded_pipe_flags_unavailable");
                check(!program.startRaw(encodedPipe.write.value, 11, 1), "encoded_pipe_accepted_as_raw");
                FD alias(fcntl(encodedPipe.write.value, F_DUPFD_CLOEXEC, 3));
                check(alias.value >= 0, "encoded_pipe_duplicate_failed");
                check(!program.startRaw(alias.value, 11, 1), "encoded_pipe_duplicate_accepted_as_raw");
                check(fcntl(encodedPipe.write.value, F_GETFL) == encodedFlags,
                      "rejected_raw_alias_changed_encoded_flags");
                check(!program.rawActive() && !program.rawFailed(), "rejected_raw_alias_changed_raw_state");
                check(await(2, [&] { return program.frames() >= beforeAlias + 3 && !program.stopped(); }),
                      "rejected_raw_alias_interrupted_encoder");
            }
            // Alias rejection did not consume generation 1.
            check(program.startRaw(rawPipe.write.value, 11, 1), "first_raw_start_failed");
            check(program.rawActive(), "raw_start_not_active");
            check(!program.startRaw(rawPipe.write.value, 11, 1), "duplicate_raw_start_accepted");
            check(await(4, [&] { return populated(raw, 1); }), "first_raw_population_timeout");
            // Start the second source's branch later: its timestamps must stay
            // in the same clock domain, rather than restart from zero.
            check(survivor.startRaw(otherRawPipe.write.value, 22, 1), "survivor_raw_start_failed");
            check(await(4, [&] { return populated(otherRaw, 1); }), "survivor_raw_population_timeout");
            healthy(raw.snapshot(), 1);
            healthy(otherRaw.snapshot(), 1);
            stopMilliseconds = boundedStop(program);
            quiescent(raw);
            check(!program.startRaw(rawPipe.write.value, 11, 1), "stale_broadcast_generation_accepted");
            check(!program.startRaw(rawPipe.write.value, 12, 2), "changed_capture_generation_accepted");
            check(program.startRaw(rawPipe.write.value, 11, 2), "second_raw_start_failed");
            check(await(4, [&] { return populated(raw, 2); }), "second_raw_population_timeout");
            healthy(raw.snapshot(), 2);
            stopMilliseconds = std::max(stopMilliseconds, boundedStop(program));
            quiescent(raw);
            primaryState = raw.snapshot();
            check(primaryState.generations.size() == 2, "unexpected_primary_generation_count");
            const auto &first = primaryState.generations.at(1);
            const auto &next = primaryState.generations.at(2);
            check(next.firstVideo > first.lastVideo && next.firstAudio > first.lastAudio,
                  "timestamp_epoch_reset_after_restart");
            primaryBefore = program.frames(); survivorBefore = survivor.frames();
            const auto rawSurvivorBefore = otherRaw.snapshot().generations.at(1).videoFrames;
            const auto stalledAt = Clock::now();
            check(program.startRaw(stalledPipe.write.value, 11, 3), "stalled_raw_start_failed");
            check(await(2, [&] { return program.rawFailed(); }), "stalled_reader_not_failed_within_two_seconds");
            stallMilliseconds = std::chrono::duration<double, std::milli>(Clock::now() - stalledAt).count();
            check(!program.rawActive(), "failed_raw_branch_still_active");
            check(await(2, [&] {
                return program.frames() >= primaryBefore + 15 && survivor.frames() >= survivorBefore + 15 &&
                    otherRaw.snapshot().generations.at(1).videoFrames >= rawSurvivorBefore + 15;
            }), "raw_stall_interrupted_encoded_or_survivor_output");
            primaryAfter = program.frames(); survivorAfter = survivor.frames();
            program.stopRaw();
            check(program.rawFailed(), "raw_failure_latch_lost_after_stop");
            check(!program.startRaw(rawPipe.write.value, 11, 3), "failed_attempt_generation_reused");
            check(program.rawFailed(), "stale_attempt_cleared_failure_latch");
            close(stalledPipe.write.value);
            stalledPipe.write.value = -1;
            Drain retired(stalledPipe.read.value, directory / "retired-stalled.sbr");
            check(await(1, [&] { return retired.snapshot().eof; }), "failed_channel_did_not_reach_eof");
            const auto retiredState = retired.snapshot();
            check(retiredState.error.empty(), "failed_channel_retirement_read_failed");
            check(retiredState.bytes > 0, "failed_channel_wrote_no_bytes");
            retiredChannelBytes = retiredState.bytes;
            retiredChannelEOF = retiredState.eof;

            // A new attempt owns a new pipe; the incomplete generation 3 stream
            // is retired rather than concatenated with generation 4.
            Pipe freshPipe;
            Drain fresh(freshPipe.read.value, directory / "fresh.sbr", 11, earliestTimestamp, {}, 4);
            const auto beforeFresh = program.frames();
            const auto survivorBeforeFresh = survivor.frames();
            const auto rawSurvivorBeforeFresh = otherRaw.snapshot().generations.at(1).videoFrames;
            check(program.startRaw(freshPipe.write.value, 11, 4), "fresh_attempt_after_failure_refused");
            check(program.rawActive() && !program.rawFailed(), "fresh_attempt_failure_latch_not_cleared");
            check(await(4, [&] {
                return populated(fresh, 4) && program.frames() >= beforeFresh + 15 &&
                    survivor.frames() >= survivorBeforeFresh + 15 &&
                    otherRaw.snapshot().generations.at(1).videoFrames >= rawSurvivorBeforeFresh + 15;
            }), "fresh_attempt_interrupted_encoded_or_survivor_output");
            healthy(fresh.snapshot(), 4);
            check(retired.snapshot().eof && retired.snapshot().bytes == retiredChannelBytes,
                  "retired_channel_received_new_attempt_bytes");
            stopMilliseconds = std::max(stopMilliseconds, boundedStop(program));
            quiescent(fresh);
            fresh.stop(); retired.stop();
            freshState = fresh.snapshot();
            check(freshState.generations.size() == 1, "fresh_channel_wrong_generation_count");
            const auto &resumed = freshState.generations.at(4);
            check(resumed.firstVideo > next.lastVideo && resumed.firstAudio > next.lastAudio,
                  "timestamp_epoch_reset_after_failed_attempt");
            check(!survivor.rawFailed() && survivor.rawActive(), "survivor_raw_branch_not_healthy");
            const auto survivingFrames = survivor.frames();
            program.stop();
            check(await(2, [&] { return survivor.frames() >= survivingFrames + 15; }), "primary_stop_stopped_survivor");
            stopMilliseconds = std::max(stopMilliseconds, boundedStop(survivor));
            quiescent(otherRaw);
            survivor.stop();
            sauce_obs::pumpEvents(.15);
            raw.stop(); otherRaw.stop(); encoded.stop(); otherEncoded.stop();
            primaryState = raw.snapshot(); survivorState = otherRaw.snapshot();
            healthy(primaryState, 1); healthy(primaryState, 2); healthy(survivorState, 1); healthy(freshState, 4);
            check(encoded.snapshot().error.empty() && otherEncoded.snapshot().error.empty(), "encoded_artifact_drain_failed");
            check(program.code() == 0 && survivor.code() == 0 && program.stopped() && survivor.stopped(),
                  "encoded_program_stop_failed");
            check(primaryState.pendingBytes == 0 && survivorState.pendingBytes == 0 && freshState.pendingBytes == 0,
                  "final_raw_record_incomplete");
            silentInput(directory);
            passed = true;
        } catch (const std::exception &error) {
            // Error identifiers above contain no paths or quotes. Filesystem
            // exceptions go to stderr; stdout stays valid, machine-readable JSON.
            std::fprintf(stderr, "raw-output: %s\n", error.what());
            failure = error.what();
            if (failure.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_") != std::string::npos)
                failure = "native_test_exception";
        }
        std::printf("{\"passed\":%s,\"checks\":%u,\"failure\":\"%s\",\"primaryFramesBeforeStall\":%u,"
            "\"primaryFramesAfterStall\":%u,\"survivorFramesBeforeStall\":%u,\"survivorFramesAfterStall\":%u,"
            "\"stopMilliseconds\":%.3f,\"stallMilliseconds\":%.3f,\"retiredChannelBytes\":%llu,"
            "\"retiredChannelEOF\":%s,\"generations\":[",
            passed ? "true" : "false", checks, failure.c_str(), primaryBefore, primaryAfter,
            survivorBefore, survivorAfter, stopMilliseconds, stallMilliseconds,
            (unsigned long long)retiredChannelBytes, retiredChannelEOF ? "true" : "false");
        bool first = true;
        for (const auto &entry : primaryState.generations) printGeneration(entry.second, first);
        for (const auto &entry : freshState.generations) printGeneration(entry.second, first);
        for (const auto &entry : survivorState.generations) printGeneration(entry.second, first);
        std::puts("]}");
        return passed ? 0 : 5;
    }
}
