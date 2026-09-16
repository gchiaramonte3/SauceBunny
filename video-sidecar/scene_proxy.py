"""Frame-preserving analysis proxy, never a playback or original-media export.

Encoding stays in this owned process: Stop cannot leave a child encoder behind.
Every decoded PTS is checked again after encoding; only a verified, complete
directory is published. A killed worker can leave an unpublished staging dir.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import struct
import tempfile
from fractions import Fraction
from pathlib import Path

from index_store import source_identity, source_unchanged
from media import Video
from shot_analysis import source_metadata

SCHEMA = "sauce.scene-proxy.v1"
PROXY_VERSION = "h264-vt-540p-all-frames-v1"
TIME_MAP_VERSION = "relative-pts-us-v1"
TIME_BASE = Fraction(1, 1_000_000)
MAX_PROXY_BYTES = 2 * 1024**3
MAX_FRAMES = 3_000_000


class TimingEvidence:
    def __init__(self):
        self.count = 0
        self.last = -1
        self.digest = hashlib.sha256()

    def add(self, pts_us):
        if type(pts_us) is not int or pts_us < 0 or pts_us <= self.last:
            raise ValueError("Analysis requires strictly increasing presentation timestamps")
        if not self.count and pts_us != 0:
            raise ValueError("The first presented frame must match the source origin; this edit list is not supported yet")
        if self.count >= MAX_FRAMES:
            raise ValueError("This video exceeds the analysis frame limit")
        self.digest.update(struct.pack("<q", pts_us))
        self.count += 1
        self.last = pts_us

    def signature(self):
        if not self.count:
            raise ValueError("No presentation frames were decoded")
        return self.count, self.digest.hexdigest()


def proxy_dimensions(width, height):
    if width < 2 or height < 2:
        raise ValueError("Invalid video dimensions")
    scale = min(1, 960 / width, 540 / height)
    return max(2, int(width * scale) // 2 * 2), max(2, int(height * scale) // 2 * 2)


def verify_proxy(path, expected):
    """A second full decode catches dropped/duplicated/retimed encoder frames."""
    observed = TimingEvidence()
    with contextlib.closing(Video(path)) as video:
        if video.stream.codec_context.name != "h264" or video.origin != 0:
            raise ValueError("The analysis proxy is not a normalized H.264 video")
        for frame in video.container.decode(video.stream):
            if frame.pts is None:
                raise ValueError("An analysis frame has no presentation timestamp")
            observed.add(round(frame.pts * frame.time_base * 1_000_000))
    if observed.signature() != expected.signature():
        raise ValueError("Analysis proxy changed the frame count or presentation timing")


def encode_proxy(source, path, on_progress):
    import av

    if "h264_videotoolbox" not in av.codecs_available:
        raise ValueError("This build needs the updated local H.264 analysis runtime")
    timing = TimingEvidence()
    with contextlib.closing(Video(Path(source["path"]))) as video:
        metadata = source_metadata(source, video)
        width, height = proxy_dimensions(video.stream.width, video.stream.height)
        with av.open(str(path), "w", format="mp4", options={"movflags": "+faststart",
                     "video_track_timescale": "1000000"}) as output:
            # Frame rate is an encoder hint only. PTS comes from each source
            # frame, not this hint, the loop index, or a reduced-rate sampler.
            stream = output.add_stream("h264_videotoolbox", rate=video.stream.average_rate or 30)
            stream.width, stream.height, stream.pix_fmt = width, height, "yuv420p"
            stream.time_base = TIME_BASE
            stream.codec_context.time_base = TIME_BASE
            stream.codec_context.max_b_frames = 0
            stream.bit_rate = 4_000_000
            stream.options = {"realtime": "1", "allow_sw": "0"}
            for frame in video.container.decode(video.stream):
                if frame.pts is None:
                    raise ValueError("A source frame has no presentation timestamp")
                pts = round((frame.pts * frame.time_base - video._origin_pts) * 1_000_000)
                timing.add(pts)
                if pts >= metadata["duration_us"]:
                    raise ValueError("Source frame extends beyond its declared video duration")
                duration_us = round(frame.duration * frame.time_base * 1_000_000)
                resized = frame.reformat(width=width, height=height, format="yuv420p")
                resized.pts, resized.time_base = pts, TIME_BASE
                # Keep source frame duration too, including VFR / the final
                # frame. Never synthesize it from the nominal frame rate.
                resized.duration = duration_us
                for packet in stream.encode(resized):
                    output.mux(packet)
                if timing.count % 120 == 0:
                    if not source_unchanged(source):
                        raise ValueError("The source changed during proxy preparation")
                    if path.stat().st_size > MAX_PROXY_BYTES:
                        raise ValueError("Analysis proxy exceeds its 2 GB limit")
                    on_progress("preparing-shot-proxy", pts, metadata["duration_us"])
            for packet in stream.encode():
                output.mux(packet)
    return metadata, timing


def prepare_proxy(root, path, on_progress):
    on_progress("inspecting-shot-source", 0, 1)
    source = source_identity(path)
    key = hashlib.sha256(f"{PROXY_VERSION}:{source['sha256']}".encode()).hexdigest()
    directory = root / "scene-proxies" / key
    manifest_path = directory / "manifest.json"
    if manifest_path.is_file():
        cached = json.loads(manifest_path.read_text())
        # Full proxy identity, not existence or filename alone, grants reuse.
        proxy = source_identity(directory / "analysis.mp4")
        if (cached.get("schema_version") == SCHEMA and cached.get("proxy_version") == PROXY_VERSION
                and cached.get("time_map_version") == TIME_MAP_VERSION
                and cached.get("source", {}).get("sha256") == source["sha256"]
                and cached.get("sha256") == proxy["sha256"] and source_unchanged(source)):
            return {"scene_proxy": {**cached, "path": str(directory / "analysis.mp4"),
                                    "source": {**cached["source"], "path": source["path"]}}}
        raise ValueError("The saved analysis proxy changed. Remove it from the analysis cache before retrying.")
    directory.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{key}-", dir=directory.parent) as stage_name:
        stage = Path(stage_name)
        proxy_path = stage / "analysis.mp4"
        metadata, timing = encode_proxy(source, proxy_path, on_progress)
        if proxy_path.stat().st_size > MAX_PROXY_BYTES:
            raise ValueError("Analysis proxy exceeds its 2 GB limit")
        on_progress("verifying-shot-proxy", 0, timing.count)
        verify_proxy(proxy_path, timing)
        if not source_unchanged(source):
            raise ValueError("The source changed during proxy preparation")
        count, pts_sha = timing.signature()
        evidence = {"schema_version": SCHEMA, "proxy_version": PROXY_VERSION,
                    "time_map_version": TIME_MAP_VERSION, "source": metadata,
                    "path": str(directory / "analysis.mp4"), "sha256": source_identity(proxy_path)["sha256"],
                    "frame_count": count, "pts_sha256": pts_sha,
                    "time_map": [{"analysis_start_us": 0, "analysis_end_us": metadata["duration_us"],
                                  "source_start_us": 0, "source_end_us": metadata["duration_us"]}]}
        with (stage / "manifest.json").open("x") as manifest:
            json.dump(evidence, manifest)
            manifest.flush()
            os.fsync(manifest.fileno())
        # A single owned job prepares proxies. No incomplete path is returned.
        os.rename(stage, directory)
    on_progress("verifying-shot-proxy", count, count)
    return {"scene_proxy": evidence}
