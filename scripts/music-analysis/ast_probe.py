"""Offline supervised AudioSet candidate check; not a production inference API."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import resource
import time

from probe import audio_windows, WINDOW_SECONDS

MODEL_ID = "MIT/ast-finetuned-audioset-10-10-0.4593"
REVISION = "f826b80d28226b62986cc218e5cec390b1096902"
WEIGHTS_SHA256 = "ae0c1e2ad4e1381d851fa9bf298ba13ebc9c5a914cdee2dbe427a6583869924d"
SAMPLE_RATE = 16_000
MIN_FRAME_SAMPLES = 400  # AST's 25 ms Kaldi analysis window, not a confidence cutoff.


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--audio", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    with (args.model_dir / "model.safetensors").open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != WEIGHTS_SHA256:
            raise ValueError("Unreviewed AST model weights")
    import numpy as np
    import torch
    import transformers
    from transformers import ASTFeatureExtractor, ASTForAudioClassification

    torch.set_num_threads(4)
    torch.manual_seed(0)
    started = time.perf_counter()
    model = ASTForAudioClassification.from_pretrained(args.model_dir, local_files_only=True,
        trust_remote_code=False, use_safetensors=True).eval()
    extractor = ASTFeatureExtractor.from_pretrained(args.model_dir, local_files_only=True, trust_remote_code=False)
    if extractor.sampling_rate != SAMPLE_RATE or len(model.config.id2label) != 527:
        raise ValueError("Unreviewed AST preprocessing or label map")
    load_seconds = time.perf_counter() - started
    rows = []
    for path in args.audio:
        with path.open("rb") as stream:
            source_sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
        for index, pcm in audio_windows(path.resolve(strict=True), args.ffmpeg, sample_rate=SAMPLE_RATE):
            if not np.isfinite(pcm).all():
                raise ValueError("Nonfinite PCM cannot be analyzed")
            row = {"file": path.name, "sha256": source_sha256, "window": index,
                "relative_start_seconds": index * WINDOW_SECONDS, "samples": len(pcm),
                "input_seconds": len(pcm) / SAMPLE_RATE, "rms": float(np.sqrt(np.mean(pcm ** 2))),
                "peak": float(np.abs(pcm).max())}
            if len(pcm) < MIN_FRAME_SAMPLES:
                row.update(status="insufficient-context", scores=[])
            else:
                started = time.perf_counter()
                inputs = extractor(pcm, sampling_rate=SAMPLE_RATE, return_tensors="pt")
                prepared = time.perf_counter()
                with torch.inference_mode():
                    scores = model(**inputs).logits.sigmoid()[0].tolist()
                ranked = sorted([{"label": model.config.id2label[index], "score": score}
                    for index, score in enumerate(scores)], key=lambda item: -item["score"])
                row.update(status="classified", scores=ranked, preprocessing_seconds=prepared-started,
                    inference_seconds=time.perf_counter()-prepared)
            rows.append(row)
            print(json.dumps({**row, "scores": row["scores"][:5]}), flush=True)
        with path.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != source_sha256:
                raise ValueError("Audio changed during analysis")
    args.output.write_text(json.dumps({"schema": "saucebunny.ast-feasibility.v1", "model": MODEL_ID,
        "revision": REVISION, "weights_sha256": WEIGHTS_SHA256, "load_seconds": load_seconds,
        "peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        "torch": torch.__version__, "transformers": transformers.__version__, "device": "cpu", "threads": 4,
        "preprocessing": extractor.to_dict(), "windows": rows,
        "limitations": ["No calibrated score threshold", "No accuracy or p95 benchmark",
                        "Short windows are zero-padded in feature space", "No production packaging",
                        "Sequential extraction assumes contiguous zero-origin audio"]}, indent=2, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
