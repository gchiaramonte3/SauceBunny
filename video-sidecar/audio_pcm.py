"""Bounded mono PCM with decoded source timestamps, including real audio gaps.

Resampling never joins discontinuous regions. Each region is anchored to its
first decoded PTS; rational sample counts preserve that anchor without repeated
microsecond rounding. Only the final evidence intervals use integer microseconds.
"""
from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
import math
from pathlib import Path

import numpy as np

from audio_ast import SAMPLE_RATE, WINDOW_SAMPLES


@dataclass(frozen=True)
class AudioWindow:
    start_us: int
    end_us: int
    pcm: np.ndarray


class WindowBuffer:
    def __init__(self, origin: Fraction, end: Fraction):
        self.origin, self.end = origin, end
        self.pcm = np.empty(WINDOW_SAMPLES, dtype=np.float32)
        self.start: Fraction | None = None
        self.count = 0
        self.maximum_retained_samples = 0

    def flush(self):
        if not self.count:
            return None
        start = self.start
        result = AudioWindow(round((start - self.origin) * 1_000_000),
            round((start + Fraction(self.count, SAMPLE_RATE) - self.origin) * 1_000_000),
            self.pcm[:self.count].copy())
        self.count, self.start = 0, None
        return result

    def append(self, pcm: np.ndarray, start: Fraction):
        if pcm.ndim != 1 or not np.isfinite(pcm).all():
            raise ValueError("Decoded audio must contain finite mono samples")
        # Keep complete samples within the requested source interval. Never pad
        # a leading gap or claim a fractional sample beyond the video's ending.
        left = max(0, math.ceil((self.origin - start) * SAMPLE_RATE))
        right = min(len(pcm), math.floor((self.end - start) * SAMPLE_RATE))
        while left < right:
            position = start + Fraction(left, SAMPLE_RATE)
            if self.start is None:
                self.start = position
            elif position != self.start + Fraction(self.count, SAMPLE_RATE):
                raise ValueError("Resampled audio lost its contiguous source clock")
            take = min(right - left, WINDOW_SAMPLES - self.count)
            self.pcm[self.count:self.count + take] = pcm[left:left + take]
            self.count += take
            left += take
            self.maximum_retained_samples = max(self.maximum_retained_samples, self.count)
            if self.count == WINDOW_SAMPLES:
                yield self.flush()


class Audio:
    def __init__(self, path: Path, track_index: int, origin_us: int, duration_us: int):
        import av

        if (type(track_index) is not int or track_index < 0 or type(origin_us) is not int
                or type(duration_us) is not int or duration_us <= 0
                or not path.is_absolute() or not path.is_file()):
            raise ValueError("Invalid local audio source or time range")
        self.origin = Fraction(origin_us, 1_000_000)
        self.end = self.origin + Fraction(duration_us, 1_000_000)
        self.maximum_retained_samples = 0
        self.container = av.open(str(path), options={"protocol_whitelist": "file",
            "format_whitelist": "mov,matroska,avi,mxf,mpegts,mpeg,wav,aiff,ogg,flac,mp3"})
        try:
            tracks = self.container.streams.audio
            if not tracks and track_index == 0:
                self.stream = None
            elif track_index >= len(tracks):
                raise ValueError("The selected audio track is not present")
            else:
                self.stream = tracks[track_index]
                self.stream.thread_count = 2
        except BaseException:
            self.close()
            raise

    def close(self):
        self.container.close()

    def windows(self):
        import av

        if self.stream is None:
            return
        buffer = WindowBuffer(self.origin, self.end)
        resampler = None
        anchor = None
        input_samples = output_samples = 0
        rate = None
        format_key = None

        def consume(frames, input_end):
            nonlocal output_samples
            for frame in frames:
                # PyAV's passthrough flush can return [None].
                if frame is None:
                    continue
                if frame.pts is None or frame.time_base is None or frame.sample_rate != SAMPLE_RATE:
                    raise ValueError("Resampled audio has no source timestamp")
                offset = Fraction(output_samples, SAMPLE_RATE)
                start = anchor + offset
                if abs(frame.pts * frame.time_base - offset) > Fraction(1, SAMPLE_RATE):
                    raise ValueError("Resampling changed the decoded source timing")
                pcm = frame.to_ndarray().reshape(-1)
                if len(frame.layout.channels) != 1 or len(pcm) != frame.samples:
                    raise ValueError("Resampled audio is not mono")
                # Resampler EOF rounding must not manufacture coverage after
                # the last decoded input sample. Keep its full-sample portion.
                valid = min(len(pcm), max(0, math.floor((input_end - start) * SAMPLE_RATE)))
                yield from buffer.append(pcm[:valid], start)
                output_samples += len(pcm)
                self.maximum_retained_samples = buffer.maximum_retained_samples

        for frame in self.container.decode(self.stream):
            if (frame.pts is None or frame.time_base is None or frame.time_base <= 0
                    or frame.sample_rate <= 0 or frame.samples <= 0):
                raise ValueError("Decoded audio has invalid timestamps or sample rate")
            start = frame.pts * frame.time_base
            if start >= self.end:
                break
            current_key = (frame.sample_rate, frame.format.name, frame.layout.name)
            expected = anchor + Fraction(input_samples, rate) if anchor is not None else start
            # Coarse containers quantize packet PTS (e.g. Matroska milliseconds).
            # Snap only inside one declared timestamp tick, always against the
            # original anchor/sample count so rounding cannot accumulate drift.
            exact_sample_ticks = (Fraction(1, frame.sample_rate) / frame.time_base).denominator == 1
            tolerance = Fraction(0) if exact_sample_ticks else frame.time_base
            if start < expected - tolerance:
                raise ValueError("Decoded audio timestamps overlap or run backwards")
            discontinuity = anchor is not None and (start > expected + tolerance or current_key != format_key)
            if discontinuity:
                yield from consume(resampler.resample(None), expected)
                tail = buffer.flush()
                if tail is not None:
                    yield tail
                resampler = None
            if resampler is None:
                anchor, rate, format_key = start, frame.sample_rate, current_key
                input_samples = output_samples = 0
                resampler = av.AudioResampler(format="fltp", layout="mono", rate=SAMPLE_RATE)
            # After validating decoded PTS above, give the resampler an exact
            # region-relative sample clock. Container rounding is not drift;
            # the original source anchor and genuine gaps remain separate.
            frame.time_base = Fraction(1, rate)
            frame.pts = input_samples
            input_samples += frame.samples
            yield from consume(resampler.resample(frame), anchor + Fraction(input_samples, rate))
        if resampler is not None:
            yield from consume(resampler.resample(None), anchor + Fraction(input_samples, rate))
        tail = buffer.flush()
        if tail is not None:
            yield tail
