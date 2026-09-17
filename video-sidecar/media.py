"""In-process, bounded frame sampling. Cancellation cannot orphan a decoder."""
from __future__ import annotations

import math
import struct
from fractions import Fraction
from pathlib import Path

WINDOW_SECONDS = 8.0
STEP_SECONDS = 6.0
FRAME_INTERVAL = 1.0
MAX_FRAME_SIDE = 384


def display_transform(frame):
    """Read the full display matrix, including mirrors; rotation alone loses them.

    PyAV returns coded pixels. These eight orthogonal transforms cover the
    container's standard camera orientations without resampling. Fail explicitly
    on affine/perspective transforms we cannot faithfully present yet.
    """
    from PIL import Image

    matrix = next((data for data in frame.side_data if data.type.name == "DISPLAYMATRIX"), None)
    if matrix is None:
        return None
    raw = bytes(matrix)
    if len(raw) != 36:
        raise ValueError("Invalid video display matrix")
    a, b, u, c, d, v, x, y, w = struct.unpack("=9i", raw)
    if (u, v, x, y, w) != (0, 0, 0, 0, 1 << 30):
        raise ValueError("This video display transform is not supported for analysis")
    unit = 1 << 16  # FFmpeg's display-matrix 16.16 coefficients.
    transforms = {
        (unit, 0, 0, unit): None,
        (0, -unit, unit, 0): Image.Transpose.ROTATE_90,
        (-unit, 0, 0, -unit): Image.Transpose.ROTATE_180,
        (0, unit, -unit, 0): Image.Transpose.ROTATE_270,
        (-unit, 0, 0, unit): Image.Transpose.FLIP_LEFT_RIGHT,
        (unit, 0, 0, -unit): Image.Transpose.FLIP_TOP_BOTTOM,
        (0, unit, unit, 0): Image.Transpose.TRANSPOSE,
        (0, -unit, -unit, 0): Image.Transpose.TRANSVERSE,
    }
    if (a, b, c, d) not in transforms:
        raise ValueError("This video display transform is not supported for analysis")
    return transforms[(a, b, c, d)]


def display_image(frame):
    transform = display_transform(frame)
    image = frame.to_image().convert("RGB")
    return image if transform is None else image.transpose(transform)


def windows(duration: float) -> list[tuple[float, float]]:
    if not math.isfinite(duration) or duration <= 0 or duration > 24 * 3600:
        raise ValueError("Choose a video shorter than 24 hours")
    result = []
    start = 0.0
    while start < duration:
        result.append((start, min(start + WINDOW_SECONDS, duration)))
        if start + WINDOW_SECONDS >= duration:
            break
        start += STEP_SECONDS
    return result


class Video:
    def __init__(self, path: Path):
        import av

        if not path.is_absolute() or not path.is_file():
            raise ValueError("Choose a local video file")
        self.container = av.open(str(path), options={"protocol_whitelist": "file",
            "format_whitelist": "mov,matroska,avi,mxf,mpegts,mpeg"})
        if not self.container.streams.video:
            self.close()
            raise ValueError("This file has no video track")
        self.stream = self.container.streams.video[0]
        self.stream.thread_count = 2
        self._origin_pts = (self.stream.start_time or 0) * self.stream.time_base
        self.origin = float(self._origin_pts)
        self.duration = (float(self.stream.duration * self.stream.time_base)
                         if self.stream.duration is not None else float(self.container.duration or 0) / av.time_base)
        try:
            windows(self.duration)  # Validate before expensive work.
        except ValueError:
            self.close()
            raise

    def close(self):
        self.container.close()

    def sample(self, start: float, end: float):
        if not (math.isfinite(start) and math.isfinite(end) and 0 <= start < end <= self.duration + 0.001):
            raise ValueError("Invalid video range")
        if end - start > WINDOW_SECONDS + 0.001:
            raise ValueError("Video analysis windows must remain bounded")
        self.container.seek(int((self.origin + start) / float(self.stream.time_base)), stream=self.stream, backward=True)
        images, timestamps = [], []
        target = start
        for frame in self.container.decode(self.stream):
            if frame.pts is None:
                continue
            position = float(frame.pts * frame.time_base) - self.origin
            if position >= end:
                break
            if position + 1e-7 < target or position < 0:
                continue
            image = display_image(frame)
            image.thumbnail((MAX_FRAME_SIDE, MAX_FRAME_SIDE))
            images.append(image)
            timestamps.append(position)
            target = position + FRAME_INTERVAL
            if len(images) >= 8:
                break
        if not images:
            raise ValueError("No decoded frame was available for this range")
        return images, timestamps

    def sample_shot(self, start_us: int, end_us: int):
        """Bounded visual evidence across a detected shot, not cut detection.

        Seek to at most eight evenly distributed positions even for long shots.
        Return actual decoded source-relative PTS, never the requested times or
        frames from a neighbouring shot. Native stream origin stays internal.
        """
        if (type(start_us) is not int or type(end_us) is not int
                or not 0 <= start_us < end_us <= round(self.duration * 1_000_000)):
            raise ValueError("Invalid shot range")
        images, timestamps_us = [], []
        for index in range(8):
            target_us = start_us + (end_us - start_us) * index // 8
            if timestamps_us and target_us <= timestamps_us[-1]:
                continue
            self.container.seek(int((self._origin_pts + Fraction(target_us, 1_000_000)) / self.stream.time_base),
                                stream=self.stream, backward=True)
            for frame in self.container.decode(self.stream):
                if frame.pts is None:
                    continue
                position_us = round((frame.pts * frame.time_base - self._origin_pts) * 1_000_000)
                if position_us >= end_us:
                    break
                if position_us < target_us:
                    continue
                image = display_image(frame)
                image.thumbnail((MAX_FRAME_SIDE, MAX_FRAME_SIDE))
                images.append(image)
                timestamps_us.append(position_us)
                break
        if not images:
            raise ValueError("No decoded frame was available inside this shot")
        return images, timestamps_us
