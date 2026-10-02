"""Source-bound streaming music evidence for the existing owned worker lifecycle.

The decoder, not the classifier, owns all times. The terminal packet is emitted
only after EOF and source revalidation; callers must discard earlier windows on
failure/cancellation. This does not turn model scores into a genre verdict.
"""
from __future__ import annotations

import contextlib
import base64
import math
from pathlib import Path
import platform

import numpy as np

from audio_ast import MODEL_ID, MODEL_REVISION, FRAME_SAMPLES
from audio_pcm import Audio
from index_store import source_identity, source_unchanged
from media import Video
from shot_analysis import MAX_DURATION_US, valid_hash

CLASSIFIER = f"{MODEL_ID}@{MODEL_REVISION}"
PREPROCESSING = "pyav-swr16k-mono-10s-kaldi-ast-v1"


def analyze_music(path: Path, request: dict, engine_factory, emit):
    origin, duration, track = (request.get(key) for key in ("origin_us", "duration_us", "audio_track_index"))
    if (not valid_hash(request.get("analysis_id")) or not valid_hash(request.get("source_sha256"))
            or type(origin) is not int or type(duration) is not int or not 0 < duration <= MAX_DURATION_US
            or type(track) is not int or track < 0):
        raise ValueError("Invalid music analysis source identity or range")
    source = source_identity(path)
    if source["sha256"] != request["source_sha256"]:
        raise ValueError("The video changed. Detect its shots again before analyzing audio.")
    with contextlib.closing(Video(path)) as video:
        if round(video.origin * 1_000_000) != origin or round(video.duration * 1_000_000) != duration:
            raise ValueError("The requested audio range does not match the inspected video")
    engine = None
    count = 0
    labels = []
    try:
        with contextlib.closing(Audio(path, track, origin, duration)) as audio:
            with contextlib.closing(audio.windows()) as windows:
                for window in windows:
                    if not source_unchanged(source):
                        raise ValueError("The video changed during audio analysis")
                    peak = float(np.max(np.abs(window.pcm)))
                    # Accumulate energy in f64, avoiding f32 under/overflow.
                    rms = float(np.sqrt(np.mean(window.pcm.astype(np.float64) ** 2)))
                    encoded_scores = ""
                    if peak == 0:
                        status = "digital-silence"
                    elif len(window.pcm) < FRAME_SAMPLES:
                        status = "insufficient-context"
                    else:
                        if engine is None:
                            engine = engine_factory()
                            labels = [engine.labels[str(index)] for index in range(len(engine.labels))]
                        scores = engine.classify(window.pcm)
                        if (len(scores) != len(engine.labels) or {row["label"] for row in scores} != set(engine.labels.values())
                                or any(not isinstance(row["label"], str) or not row["label"]
                                    or not math.isfinite(row["score"]) or not 0 <= row["score"] <= 1 for row in scores)):
                            raise ValueError("The audio classifier returned invalid evidence")
                        # Preserve every model f32 exactly; repeating 527 label
                        # strings per window would overwhelm long-run transport.
                        by_label = {row["label"]: row["score"] for row in scores}
                        encoded_scores = base64.b64encode(np.array([by_label[label] for label in labels],
                            dtype="<f4").tobytes()).decode("ascii")
                        status = "classified"
                    if not source_unchanged(source):
                        raise ValueError("The video changed during audio analysis")
                    emit({"type": "window", "start_us": window.start_us, "end_us": window.end_us,
                        "rms": rms, "peak": peak, "status": status, "scores_f32le": encoded_scores})
                    count += 1
            maximum_retained_samples = audio.maximum_retained_samples
            status = "no-audio" if audio.stream is None else "decoded"
        # A full second hash also catches same-size/timestamp replacement.
        if source_identity(path) != source:
            raise ValueError("The video changed during audio analysis")
        if engine is not None:
            engine.close()
            engine = None
        emit({"type": "complete", "analysis_id": request["analysis_id"], "source_sha256": source["sha256"],
            "origin_us": origin, "duration_us": duration, "audio_track_index": track,
            "classifier": CLASSIFIER, "os": platform.platform(), "preprocessing_version": PREPROCESSING,
            "status": status, "windows": count, "maximum_retained_frames": maximum_retained_samples,
            "labels": labels})
    finally:
        if engine is not None:
            engine.close()
