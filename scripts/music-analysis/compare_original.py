"""Offline numerical comparison against pinned LAION inference components.

This developer check does not install an application model or classify genres.
It loads the original HTSAT module unchanged, plus the exact utility/preparation
functions it needs. Skipping package __init__ avoids the upstream training
module's automatic pretrained-tokenizer downloads and unused training imports.
"""
from __future__ import annotations

import argparse
import ast
from contextlib import suppress
import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time
from types import ModuleType, SimpleNamespace

for name in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY", "HF_HUB_DISABLE_IMPLICIT_TOKEN"):
    os.environ[name] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

UPSTREAM_REVISION = "1fd4c37df5ffbfcfbad5415c170bc66cf94c9994"
CHECKPOINT_SHA256 = "fae3e9c087f2909c28a09dc31c8dfcdacbc42ba44c70e972b58c1bd1caf6dedd"
# Float32 cross-implementation tolerance on normalized embeddings and cosine
# scores, not an accuracy threshold or a music-presence decision.
PARITY_ABSOLUTE_TOLERANCE = 1e-4


def parity_passed(text: dict, windows: list[dict]) -> bool:
    metrics = [text] + [window[field] for window in windows for field in ("embedding", "scores")]
    return bool(windows) and all(math.isfinite(metric["max_absolute"])
        and 0 <= metric["max_absolute"] <= PARITY_ABSOLUTE_TOLERANCE for metric in metrics)


def functions(path: Path, names: set[str], namespace: dict):
    tree = ast.parse(path.read_text(), filename=str(path))
    selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    if {node.name for node in selected} != names:
        raise ValueError("Pinned reference function missing")
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(path), "exec"), namespace)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--audio", type=Path, action="append", required=True)
    args = parser.parse_args()
    root = args.upstream.resolve(strict=True)
    revision = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    if revision != UPSTREAM_REVISION:
        raise ValueError("Unreviewed reference revision")
    subprocess.run(["git", "-C", str(root), "diff", "--exit-code", "HEAD", "--", "src/laion_clap"], check=True)
    source = args.work_dir / "original/music_audioset_epoch_15_esc_90.14.pt"
    with source.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != CHECKPOINT_SHA256:
            raise ValueError("Original checkpoint checksum mismatch")

    import numpy as np
    import torch
    import torch.nn.functional as F
    import transformers
    import librosa
    from transformers import ClapModel, ClapProcessor, RobertaConfig, RobertaModel
    from probe import LABELS, SAMPLE_RATE, WINDOW_SAMPLES, audio_windows

    torch.set_num_threads(4)
    torch.manual_seed(0)
    np.random.seed(0)
    with torch.serialization.safe_globals([
        (np._core.multiarray.scalar, "numpy.core.multiarray.scalar"), np.dtype, np.dtypes.Float64DType,
    ]):
        checkpoint = torch.load(source, map_location="cpu", weights_only=True)
    weights = {key.removeprefix("module."): value for key, value in checkpoint["state_dict"].items()}
    del checkpoint
    directory = root / "src/laion_clap/clap_module"
    package = ModuleType("_clap_reference")
    package.__path__ = [str(directory)]
    sys.modules[package.__name__] = package
    utilities = ModuleType("_clap_reference.utils")
    utilities.torch = torch
    functions(directory / "utils.py", {"do_mixup", "interpolate"}, utilities.__dict__)
    sys.modules[utilities.__name__] = utilities
    reference = importlib.import_module("_clap_reference.htsat")
    config = json.loads((directory / "model_configs/HTSAT-base.json").read_text())["audio_cfg"]
    original = reference.create_htsat_model(SimpleNamespace(**config)).eval()
    original.load_state_dict({key.removeprefix("audio_branch."): value for key, value in weights.items()
                              if key.startswith("audio_branch.")}, strict=True)
    prepare = {"torch": torch, "F": F, "np": np, "suppress": suppress}
    functions(root / "src/laion_clap/training/data.py", {"get_audio_features"}, prepare)

    converted_dir = args.work_dir / "converted"
    receipt = json.loads((converted_dir / "conversion.json").read_text())
    with (converted_dir / "model.safetensors").open("rb") as stream:
        converted_sha = hashlib.file_digest(stream, "sha256").hexdigest()
    if receipt["source_sha256"] != CHECKPOINT_SHA256 or receipt["safetensors_sha256"] != converted_sha:
        raise ValueError("Converted weights do not match their receipt")
    converted = ClapModel.from_pretrained(converted_dir, local_files_only=True,
        trust_remote_code=False, use_safetensors=True).eval()
    processor = ClapProcessor.from_pretrained(converted_dir, local_files_only=True, trust_remote_code=False)

    def projection(prefix: str, width: int):
        model = torch.nn.Sequential(torch.nn.Linear(width, 512), torch.nn.ReLU(), torch.nn.Linear(512, 512)).eval()
        model.load_state_dict({key.removeprefix(prefix): value for key, value in weights.items()
                               if key.startswith(prefix)}, strict=True)
        return model

    audio_projection = projection("audio_projection.", original.num_features)
    text_projection = projection("text_projection.", converted.config.text_config.hidden_size)
    text_config = RobertaConfig(**converted.config.text_config.to_dict())
    text_config._attn_implementation = "eager"
    text_original = RobertaModel(text_config).eval()
    text_weights = {key.removeprefix("text_branch."): value for key, value in weights.items() if key.startswith("text_branch.")}
    # Transformers no longer registers this deterministic position-ID buffer.
    if "embeddings.position_ids" not in text_original.state_dict():
        positions = text_weights.pop("embeddings.position_ids")
        assert torch.equal(positions, torch.arange(positions.shape[1]).unsqueeze(0))
    text_original.load_state_dict(text_weights, strict=True)
    del weights, text_weights

    def differences(a, b):
        return {"max_absolute": float((a - b).abs().max()),
                "mean_absolute": float((a - b).abs().mean()),
                "cosine_min": float(F.cosine_similarity(a, b, dim=-1).min())}

    prompts = [prompt for labels in LABELS.values() for prompt in labels]
    text = processor.tokenizer(prompts, padding="max_length", truncation=True, max_length=77, return_tensors="pt")
    with torch.inference_mode():
        text_hf = converted.get_text_features(**text).pooler_output
        text_ref = F.normalize(text_projection(text_original(**text).pooler_output), dim=-1)
        text_delta = differences(text_hf, text_ref)
    print(json.dumps({"text": text_delta}), flush=True)

    rows = []
    for path in args.audio:
        with path.open("rb") as stream:
            audio_sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
        for index, pcm in audio_windows(path.resolve(strict=True), args.ffmpeg):
            if not np.isfinite(pcm).all():
                raise ValueError("Nonfinite PCM cannot be compared")
            # LAION's file API quantizes to int16 first; give both paths exactly
            # the same values so this check isolates preprocessing/model parity.
            audio = (np.clip(pcm, -1, 1) * 32767).astype(np.int16).astype(np.float32) / 32767
            with torch.inference_mode():
                prepared = prepare["get_audio_features"]({}, torch.from_numpy(audio), WINDOW_SAMPLES,
                    data_truncating="rand_trunc", data_filling="repeatpad", audio_cfg=config)
                prepared = {key: value.unsqueeze(0) for key, value in prepared.items()}
                started = time.perf_counter()
                raw_ref = original(prepared, device="cpu")["embedding"]
                embedding_ref = F.normalize(audio_projection(raw_ref), dim=-1)
                features = processor.feature_extractor(audio, sampling_rate=SAMPLE_RATE,
                    return_tensors="pt", truncation="rand_trunc", padding="repeatpad")
                raw_hf = converted.audio_model(**features).pooler_output
                embedding_hf = F.normalize(converted.audio_projection(raw_hf), dim=-1)
                logits_ref = embedding_ref @ text_ref.T
                logits_hf = embedding_hf @ text_hf.T
                row = {"file": path.name, "sha256": audio_sha256, "window": index, "samples": len(audio),
                    "latent": differences(raw_ref, raw_hf), "embedding": differences(embedding_ref, embedding_hf),
                    "scores": differences(logits_ref, logits_hf), "seconds": time.perf_counter() - started,
                    "reference_scores": logits_ref[0].tolist(), "converted_scores": logits_hf[0].tolist()}
            rows.append(row)
            print(json.dumps({key: value for key, value in row.items() if not key.endswith("_scores")}), flush=True)
        with path.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != audio_sha256:
                raise ValueError("Audio source changed during comparison")
    passed = parity_passed(text_delta, rows)
    args.output.write_text(json.dumps({"schema": "saucebunny.clap-reference-comparison.v1", "upstream": revision,
        "checkpoint_sha256": CHECKPOINT_SHA256, "converted_sha256": converted_sha, "text": text_delta,
        "passed": passed, "absolute_tolerance": PARITY_ABSOLUTE_TOLERANCE,
        "versions": {"torch": torch.__version__, "transformers": transformers.__version__, "librosa": librosa.__version__},
        "prompts": prompts, "windows": rows,
        "limitations": ["No full upstream package import", "No genre accuracy claim", "CPU float32 only",
                        "Sequential extraction assumes contiguous zero-origin audio"]}, indent=2, allow_nan=False) + "\n")
    if not passed:
        raise ValueError("Converted inference differs from the pinned reference; inspect the comparison report")


if __name__ == "__main__":
    main()
