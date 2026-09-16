"""In-process, bounded frame sampling. Cancellation cannot orphan a decoder."""
from __future__ import annotations

import math
from pathlib import Path

WINDOW_SECONDS = 8.0
STEP_SECONDS = 6.0
FRAME_INTERVAL = 1.0
MAX_FRAME_SIDE = 384


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
        self.origin = float((self.stream.start_time or 0) * self.stream.time_base)
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
            image = frame.to_image().convert("RGB")
            image.thumbnail((MAX_FRAME_SIDE, MAX_FRAME_SIDE))
            images.append(image)
            timestamps.append(position)
            target = position + FRAME_INTERVAL
            if len(images) >= 8:
                break
        if not images:
            raise ValueError("No decoded frame was available for this range")
        return images, timestamps
