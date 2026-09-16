"""Compare the local MLX AST adapter with the pinned PyTorch reference offline."""
from __future__ import annotations

import argparse
import importlib.metadata
import json
from pathlib import Path
import sys
import time

from probe import audio_windows

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "video-sidecar"))
from audio_ast import AudioSpectrogramClassifier, prepare_features, FILES, SAMPLE_RATE, FRAME_SAMPLES


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--audio", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    import numpy as np
    import torch
    import mlx.core as mx
    import transformers
    from transformers import ASTFeatureExtractor, ASTForAudioClassification

    torch.set_num_threads(4)
    # This validates the exact weights, label mapping and preprocessing first.
    candidate = AudioSpectrogramClassifier(args.model_dir)
    reference = ASTForAudioClassification.from_pretrained(args.model_dir, local_files_only=True,
        trust_remote_code=False, use_safetensors=True, attn_implementation="eager").eval()
    extractor = ASTFeatureExtractor.from_pretrained(args.model_dir, local_files_only=True, trust_remote_code=False)
    rows = []
    for path in args.audio:
        for index, pcm in audio_windows(path.resolve(strict=True), args.ffmpeg, sample_rate=SAMPLE_RATE):
            if len(pcm) < FRAME_SAMPLES:
                continue  # Both implementations require a full 25 ms STFT frame.
            features = prepare_features(pcm, candidate.preprocessing)
            ref_features = extractor(pcm, sampling_rate=SAMPLE_RATE, return_tensors="pt")["input_values"]
            with torch.inference_mode():
                ref_logits = reference(ref_features).logits.numpy()
            start = time.perf_counter()
            logits = candidate.logits(features)
            duration = time.perf_counter() - start
            ref_scores = np.exp(-np.logaddexp(0, -ref_logits))
            scores = np.exp(-np.logaddexp(0, -logits))
            row = {"file": path.name, "window": index, "samples": len(pcm),
                "feature_max_absolute": float(np.max(np.abs(features - ref_features.numpy()))),
                "logit_max_absolute": float(np.max(np.abs(logits - ref_logits))),
                "score_max_absolute": float(np.max(np.abs(scores - ref_scores))),
                "mlx_seconds": duration, "metal_peak_bytes": mx.get_peak_memory(),
                "reference_top": candidate.labels[str(int(ref_scores.argmax()))],
                "mlx_top": candidate.labels[str(int(scores.argmax()))]}
            # Cross-runtime float32 numeric parity, not prediction accuracy.
            row["passed"] = bool(np.allclose(features, ref_features.numpy(), rtol=0, atol=1e-5)
                and np.allclose(logits, ref_logits, rtol=0, atol=1e-3)
                and np.allclose(scores, ref_scores, rtol=0, atol=1e-4))
            rows.append(row)
            print(json.dumps(row), flush=True)
            mx.clear_cache()
    passed = bool(rows) and all(row["passed"] for row in rows)
    args.output.write_text(json.dumps({"schema": "saucebunny.ast-mlx-parity.v1", "passed": passed,
        "files": FILES, "versions": {"mlx": importlib.metadata.version("mlx"),
            "torch": torch.__version__, "transformers": transformers.__version__},
        "windows": rows, "limitations": ["No accuracy or p95 claim", "No packaged-app validation",
            "Sequential extraction assumes contiguous zero-origin audio"]}, indent=2, allow_nan=False) + "\n")
    if not passed:
        raise ValueError("MLX adapter does not match the reference; inspect the parity report")


if __name__ == "__main__":
    main()
