// SPDX-License-Identifier: GPL-2.0-or-later
#include "raw-output.hpp"
#include "raw-frame.hpp"
#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <fcntl.h>
#include <limits>
#include <mutex>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>
#include <vector>

namespace sauce_obs {
namespace {
constexpr size_t videoBufferCount = 3;
constexpr size_t audioFrameCapacity = 12000; // 250 ms, including the current write.
constexpr size_t audioRecordCapacity = 32;
constexpr uint32_t audioSampleRate = 48000;
using Clock = std::chrono::steady_clock;
static_assert(std::atomic<bool>::is_always_lock_free);
static_assert(std::atomic<uint64_t>::is_always_lock_free);
static_assert(sizeof(float) == 4 && std::numeric_limits<float>::is_iec559);
static_assert(__BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__);
}

struct RawOutput::State {
    enum class VideoUse : uint8_t { empty, filling, ready, writing };
    static_assert(std::atomic<VideoUse>::is_always_lock_free);
    struct VideoBuffer {
        std::atomic<VideoUse> use{VideoUse::empty};
        RawFrameInfo info;
        std::vector<uint8_t> bytes;
    };
    struct AudioRecord {
        RawFrameInfo info;
        uint64_t firstFrame = 0;
    };

    RawOutput &owner;
    video_t *video;
    audio_t *audio;
    unsigned mixIndex;
    int fd = -1;
    bool videoConnected = false, audioConnected = false;
    RawFrameInfo videoInfo, audioInfo;
    std::array<VideoBuffer, videoBufferCount> pictures;
    std::array<std::array<float, audioFrameCapacity>, 2> samples{};
    std::array<AudioRecord, audioRecordCapacity> audioRecords;
    // OBS serializes each media callback. These are separate SPSC queues; only
    // the audio producer writes nextAudioFrame, only the writer consumes it.
    uint64_t nextAudioFrame = 0;
    std::atomic<uint64_t> audioFramesRead{0}, audioRead{0}, audioWritten{0};
    std::atomic<bool> accepting{false}, stopping{false};
    std::thread writer;
    std::mutex wakeMutex; // Used only by the writer, never by an OBS callback.
    std::condition_variable wake;

    State(RawOutput &o, video_t *v, audio_t *a, unsigned mix,
          const RawFrameInfo &info)
        : owner(o), video(v), audio(a), mixIndex(mix), videoInfo(info) {
        for (auto &picture : pictures) picture.bytes.resize(info.payloadBytes);
        audioInfo.kind = 2;
        audioInfo.captureGeneration = info.captureGeneration;
        audioInfo.broadcastGeneration = info.broadcastGeneration;
        audioInfo.sampleRate = audioSampleRate;
        audioInfo.channels = 2;
    }
    ~State() { if (fd >= 0) close(fd); }

    void fail() {
        // A record may already be partly written. The owner must never reuse
        // this channel, even when the immediate cause was audio overflow.
        owner.failed_ = true;
        owner.active_ = false;
        accepting = false;
        stopping = true;
        wake.notify_one();
    }

    static void onVideo(void *context, video_data *frame) {
        auto &s = *static_cast<State *>(context);
        if (!s.accepting.load()) return;
        if (!frame || !frame->timestamp || !frame->data[0] ||
            frame->linesize[0] < s.videoInfo.stride) { s.fail(); return; }
        VideoBuffer *available = nullptr;
        // Prefer unused storage, then replace a queued frame. Never touch the
        // writer's buffer, take a mutex, allocate, or wait for pipe progress.
        for (const auto wanted : {VideoUse::empty, VideoUse::ready}) {
            for (auto &picture : s.pictures) {
                auto expected = wanted;
                if (picture.use.compare_exchange_strong(expected, VideoUse::filling,
                                                        std::memory_order_acq_rel)) {
                    available = &picture;
                    break;
                }
            }
            if (available) break;
        }
        if (!available) return; // Video is explicitly replaceable.
        available->info = s.videoInfo;
        available->info.timestamp = frame->timestamp;
        for (uint32_t row = 0; row < s.videoInfo.height; ++row)
            std::memcpy(available->bytes.data() + size_t(row) * s.videoInfo.stride,
                        frame->data[0] + size_t(row) * frame->linesize[0], s.videoInfo.stride);
        available->use.store(VideoUse::ready, std::memory_order_release);
        s.wake.notify_one();
    }

    static void onAudio(void *context, size_t mix, audio_data *data) {
        auto &s = *static_cast<State *>(context);
        if (!s.accepting.load()) return;
        if (mix != s.mixIndex || !data || !data->timestamp || !data->frames ||
            data->frames > 4096 || !data->data[0] || !data->data[1]) { s.fail(); return; }
        const auto written = s.audioWritten.load(std::memory_order_relaxed);
        const auto read = s.audioRead.load(std::memory_order_acquire);
        const auto usedFrames = s.nextAudioFrame - s.audioFramesRead.load(std::memory_order_acquire);
        if (written - read >= audioRecordCapacity || usedFrames + data->frames > audioFrameCapacity) {
            s.fail(); // No silence insertion, loss concealment, or dropped audio.
            return;
        }
        const size_t offset = s.nextAudioFrame % audioFrameCapacity;
        const size_t first = std::min<size_t>(data->frames, audioFrameCapacity - offset);
        for (size_t channel = 0; channel < 2; ++channel) {
            std::memcpy(s.samples[channel].data() + offset, data->data[channel], first * sizeof(float));
            std::memcpy(s.samples[channel].data(), data->data[channel] + first * sizeof(float),
                        (data->frames - first) * sizeof(float));
        }
        auto &record = s.audioRecords[written % audioRecordCapacity];
        record.info = s.audioInfo;
        record.info.timestamp = data->timestamp;
        record.info.frames = data->frames;
        record.info.payloadBytes = data->frames * 2 * sizeof(float);
        record.firstFrame = s.nextAudioFrame;
        s.nextAudioFrame += data->frames;
        s.audioWritten.store(written + 1, std::memory_order_release);
        s.wake.notify_one();
    }

    bool writeBytes(const uint8_t *bytes, size_t count, Clock::time_point deadline) {
        while (count) {
            const auto now = Clock::now();
            if (now >= deadline) return false;
            const ssize_t sent = write(fd, bytes, std::min<size_t>(count, 65536));
            if (sent > 0) { bytes += sent; count -= size_t(sent); continue; }
            if (sent < 0 && errno == EINTR) continue;
            if (sent >= 0 || (errno != EAGAIN && errno != EWOULDBLOCK)) return false;
            pollfd pending{fd, POLLOUT, 0};
            const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now).count();
            const int result = poll(&pending, 1, static_cast<int>(std::max<int64_t>(1, remaining)));
            if (result < 0 && errno == EINTR) continue;
            if (result <= 0 || (pending.revents & (POLLERR | POLLHUP | POLLNVAL))) return false;
        }
        return true;
    }

    bool writeVideo(const VideoBuffer &picture) {
        const auto deadline = Clock::now() + std::chrono::milliseconds(200);
        const auto header = rawFrameHeader(picture.info);
        return writeBytes(header.data(), header.size(), deadline) &&
            writeBytes(picture.bytes.data(), picture.info.payloadBytes, deadline);
    }

    bool writeAudio(const AudioRecord &record) {
        const auto deadline = Clock::now() + std::chrono::milliseconds(200);
        const auto header = rawFrameHeader(record.info);
        if (!writeBytes(header.data(), header.size(), deadline)) return false;
        const size_t offset = record.firstFrame % audioFrameCapacity;
        const size_t first = std::min<size_t>(record.info.frames, audioFrameCapacity - offset);
        // The circular storage can wrap, but the wire is always all left
        // samples followed by all right samples, with no interleaving/padding.
        for (const auto &plane : samples) {
            if (!writeBytes(reinterpret_cast<const uint8_t *>(plane.data() + offset), first * sizeof(float), deadline) ||
                !writeBytes(reinterpret_cast<const uint8_t *>(plane.data()),
                            (record.info.frames - first) * sizeof(float), deadline)) return false;
        }
        return true;
    }

    VideoBuffer *takeVideo() {
        VideoBuffer *newest = nullptr;
        for (auto &picture : pictures) {
            auto expected = VideoUse::ready;
            if (!picture.use.compare_exchange_strong(expected, VideoUse::writing,
                                                     std::memory_order_acq_rel)) continue;
            // Read metadata only AFTER claiming its buffer. The producer can
            // otherwise replace a ready frame while this scan is underway.
            if (!newest || picture.info.timestamp > newest->info.timestamp) {
                if (newest) newest->use.store(VideoUse::empty, std::memory_order_release);
                newest = &picture;
            } else picture.use.store(VideoUse::empty, std::memory_order_release);
        }
        return newest;
    }

    void run() {
        // Keep a closed reader's SIGPIPE local to this thread. Changing the
        // process-wide signal handler would affect the independent MP4 output.
        sigset_t blocked;
        sigemptyset(&blocked);
        sigaddset(&blocked, SIGPIPE);
        if (pthread_sigmask(SIG_BLOCK, &blocked, nullptr) != 0) { fail(); return; }
        uint64_t lastVideoTimestamp = 0;
        while (!stopping.load()) {
            bool progressed = false;
            const auto read = audioRead.load(std::memory_order_relaxed);
            if (read != audioWritten.load(std::memory_order_acquire)) {
                const auto &record = audioRecords[read % audioRecordCapacity];
                if (stopping.load()) break;
                if (!writeAudio(record)) { fail(); break; }
                audioFramesRead.store(record.firstFrame + record.info.frames, std::memory_order_release);
                audioRead.store(read + 1, std::memory_order_release);
                // Drain queued audio before selecting another large picture.
                // Otherwise a consumer taking one frame interval per picture
                // would service audio at video cadence and overflow needlessly.
                continue;
            }
            if (stopping.load()) break;
            if (auto *picture = takeVideo()) {
                if (stopping.load()) break;
                const bool newer = picture->info.timestamp > lastVideoTimestamp;
                if (newer && !writeVideo(*picture)) { fail(); break; }
                if (newer) lastVideoTimestamp = picture->info.timestamp;
                picture->use.store(VideoUse::empty, std::memory_order_release);
                progressed = true;
            }
            if (!progressed) {
                std::unique_lock<std::mutex> lock(wakeMutex);
                // Callbacks notify without acquiring this mutex. A notification
                // racing the wait is harmless: the fallback wait is bounded.
                wake.wait_for(lock, std::chrono::milliseconds(5));
            }
        }
        owner.active_ = false;
    }
};

RawOutput::RawOutput() = default;
RawOutput::~RawOutput() { stop(); }

bool RawOutput::start(video_t *video, audio_t *audio, unsigned mixIndex,
                      unsigned width, unsigned height, int inheritedFd,
                      uint64_t captureGeneration, uint64_t broadcastGeneration) {
    RawFrameInfo info;
    info.kind = 1;
    info.captureGeneration = captureGeneration;
    info.broadcastGeneration = broadcastGeneration;
    info.timestamp = 1; // Validated before callbacks supply the original OBS timestamp.
    info.width = width; info.height = height;
    info.stride = width * 4; info.payloadBytes = info.stride * height;
    if (state_ || failed() || !video || !audio || mixIndex >= MAX_AUDIO_MIXES ||
        inheritedFd < 0 || !rawFrameValid(info)) return false;
    struct stat pipeInfo{};
    const int flags = fcntl(inheritedFd, F_GETFL);
    if (flags < 0 || (flags & O_ACCMODE) != O_WRONLY ||
        fstat(inheritedFd, &pipeInfo) != 0 || !S_ISFIFO(pipeInfo.st_mode)) return false;
    try {
        state_ = std::make_unique<State>(*this, video, audio, mixIndex, info);
        auto &s = *state_;
        s.fd = fcntl(inheritedFd, F_DUPFD_CLOEXEC, 3);
        if (s.fd < 0 || fcntl(s.fd, F_SETFL, flags | O_NONBLOCK) < 0) { stop(); return false; }
        video_scale_info picture{};
        picture.format = VIDEO_FORMAT_BGRA;
        picture.width = width; picture.height = height;
        picture.range = VIDEO_RANGE_FULL;
        picture.colorspace = VIDEO_CS_709;
        s.videoConnected = video_output_connect(video, &picture, State::onVideo, &s);
        if (!s.videoConnected) { stop(); return false; }
        audio_convert_info sound{};
        sound.samples_per_sec = audioSampleRate;
        sound.format = AUDIO_FORMAT_FLOAT_PLANAR;
        sound.speakers = SPEAKERS_STEREO;
        s.audioConnected = audio_output_connect(audio, mixIndex, &sound, State::onAudio, &s);
        if (!s.audioConnected) { stop(); return false; }
        active_ = true;
        s.accepting = true;
        s.writer = std::thread([&s] { s.run(); });
    } catch (...) {
        // No bytes have been written if allocation/thread creation fails.
        stop();
        return false;
    }
    if (failed()) { stop(); return false; }
    return true;
}

void RawOutput::stop() {
    active_ = false;
    if (!state_) return;
    auto &s = *state_;
    s.accepting = false;
    s.stopping = true;
    s.wake.notify_one();
    // Both pinned OBS disconnect functions lock the same input mutex held
    // around their callbacks. Returning from disconnect is the lifetime barrier
    // before these buffers, or the program's canvas/audio output, can be freed.
    if (s.videoConnected) video_output_disconnect(s.video, State::onVideo, &s);
    if (s.audioConnected) audio_output_disconnect(s.audio, s.mixIndex, State::onAudio, &s);
    // At most the record already selected by the writer is completed. It gets
    // one total 200 ms deadline; all remaining queued records are discarded.
    // Any incomplete record sets failed(), preventing channel reuse.
    if (s.writer.joinable()) s.writer.join();
    state_.reset();
}
} // namespace sauce_obs
