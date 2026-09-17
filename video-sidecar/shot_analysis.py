"""Describe supplied source-time shots without inventing cuts or requiring an index.

The detector owns shot boundaries. This layer samples visual evidence only;
transcript text is supplied separately and is never presented as heard audio.
"""
from __future__ import annotations

import contextlib
from pathlib import Path

from artifacts import model_spec
from index_store import source_identity, source_unchanged
from media import Video

MAX_SHOTS_PER_REQUEST = 64
MAX_DURATION_US = 24 * 3600 * 1_000_000
SAMPLING_VERSION = "shot-spread-8frames-384-display-v2"
REASONING = "qwen3.5-9b-video"


def valid_hash(value):
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def validate_shots(request):
    if not valid_hash(request.get("analysis_id")) or not valid_hash(request.get("source_sha256")):
        raise ValueError("Invalid shot analysis identity")
    query = request.get("query")
    if not isinstance(query, str) or not query.strip() or len(query) > 1000:
        raise ValueError("Invalid video question")
    shots = request.get("shots")
    if not isinstance(shots, list) or not 1 <= len(shots) <= MAX_SHOTS_PER_REQUEST:
        raise ValueError("Choose between 1 and 64 detected shots per request")
    ids, previous_end = set(), 0
    for shot in shots:
        if not isinstance(shot, dict) or set(shot) != {"id", "start_us", "end_us", "transcript"}:
            raise ValueError("Invalid detected shot")
        identifier, start, end, transcript = (shot[key] for key in ("id", "start_us", "end_us", "transcript"))
        if (type(identifier) is not int or not 0 < identifier <= 2**32 - 1 or identifier in ids
                or type(start) is not int or type(end) is not int
                or not previous_end <= start < end <= MAX_DURATION_US
                or not isinstance(transcript, str) or len(transcript.encode("utf8")) > 12000):
            raise ValueError("Shots must have unique IDs and ordered, non-overlapping source-time ranges")
        ids.add(identifier)
        previous_end = end
    return shots


def source_metadata(source, video):
    return {"path": source["path"], "sha256": source["sha256"],
            "duration_us": round(video.duration * 1_000_000),
            "origin_us": round(video.origin * 1_000_000)}


def inspect_source(path: Path):
    source = source_identity(path)
    with contextlib.closing(Video(path)) as video:
        metadata = source_metadata(source, video)
    if not source_unchanged(source):
        raise ValueError("The video changed during inspection")
    return {"analysis_source": metadata}


def analyze_shots(path: Path, request, engine_factory, on_progress):
    shots = validate_shots(request)
    # Full content identity ties these ranges to the source that was inspected,
    # not just a pathname that could now point at a different edit.
    on_progress("inspecting-shots", 0, len(shots))
    source = source_identity(path)
    if source["sha256"] != request["source_sha256"]:
        raise ValueError("The video changed. Detect its shots again before analyzing them.")
    engine = None
    answers = []
    try:
        with contextlib.closing(Video(path)) as video:
            metadata = source_metadata(source, video)
            if shots[-1]["end_us"] > metadata["duration_us"]:
                raise ValueError("A detected shot extends beyond the video")
            for position, shot in enumerate(shots):
                if not source_unchanged(source):
                    raise ValueError("The video changed during shot analysis")
                frames, timestamps = video.sample_shot(shot["start_us"], shot["end_us"])
                if engine is None:
                    engine = engine_factory()
                text = engine.reason(request["query"], frames,
                                     [timestamp / 1_000_000 for timestamp in timestamps], shot["transcript"],
                                     visual_only=True)
                if not isinstance(text, str) or not text.strip() or len(text.encode("utf8")) > 16000:
                    raise ValueError("The video model returned an empty or oversized shot description")
                if not source_unchanged(source):
                    raise ValueError("The video changed during shot analysis")
                answers.append({**shot, "frame_pts_us": timestamps, "text": text})
                # Do not retain images from completed shots while decoding the next.
                del frames
                on_progress("analyzing-shots", position + 1, len(shots))
        return {"shot_analysis": {"analysis_id": request["analysis_id"], "source": metadata,
                "model_id": REASONING, "model_revision": model_spec(REASONING)["revision"],
                "sampling_version": SAMPLING_VERSION, "audio_analyzed": False, "shots": answers}}
    finally:
        if engine is not None:
            engine.close()
