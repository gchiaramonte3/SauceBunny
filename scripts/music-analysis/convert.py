# Copyright 2023 The HuggingFace Inc. team. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Strict local conversion based on HF's Apache-2.0 CLAP key mapping.

Reference: transformers v4.35.0 models/clap/convert_clap_original_pytorch_to_hf.py.
Unlike the upstream example, every inference weight must match exactly; only
training heads and the separate STFT/mel implementation can be omitted.
"""
import argparse
import os
from pathlib import Path
import hashlib
import json
import re

for key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY", "HF_HUB_DISABLE_IMPLICIT_TOKEN"):
    os.environ[key] = "1"

import numpy as np
import torch
from transformers import ClapConfig, ClapModel, ClapProcessor

parser = argparse.ArgumentParser()
parser.add_argument("--work-dir", type=Path, required=True)
args = parser.parse_args()
ROOT = args.work_dir.resolve(strict=True)
target = ROOT / "converted"
if target.exists():
    raise ValueError("The converted output directory already exists; choose a fresh work directory")
source = ROOT / "original/music_audioset_epoch_15_esc_90.14.pt"
with source.open("rb") as f:
    if hashlib.file_digest(f, "sha256").hexdigest() != "fae3e9c087f2909c28a09dc31c8dfcdacbc42ba44c70e972b58c1bd1caf6dedd":
        raise ValueError("Original checkpoint checksum mismatch")
# Training metadata contains a NumPy float scalar. Keep tensor-only loading;
# allow precisely NumPy's scalar/dtype reconstruction, never arbitrary globals.
with torch.serialization.safe_globals([
    (np._core.multiarray.scalar, "numpy.core.multiarray.scalar"),
    np.dtype, np.dtypes.Float64DType,
]):
    checkpoint = torch.load(source, map_location="cpu", weights_only=True)
print("envelope", list(checkpoint), flush=True)
weights = checkpoint["state_dict"]
renames = {
    "text_branch": "text_model", "audio_branch": "audio_model.audio_encoder",
    "attn": "attention.self", "self.proj": "output.dense",
    "attention.self_mask": "attn_mask", "mlp.fc1": "intermediate.dense",
    "mlp.fc2": "output.dense", "norm1": "layernorm_before",
    "norm2": "layernorm_after", "bn0": "batch_norm",
}
converted = {}
for original_key, value in weights.items():
    key = original_key.removeprefix("module.")
    for old, new in renames.items():
        key = key.replace(old, new)
    match = re.match(r".*sequential\.(\d+)\.", key)
    projection = re.match(r".*_projection\.(\d+)\.", key)
    if match:
        key = key.replace(f"sequential.{match[1]}.", f"layers.{int(match[1]) // 3}.linear.")
    elif projection:
        number = 1 if projection[1] == "0" else 2
        key = key.replace(f"_projection.{projection[1]}.", f"_projection.linear{number}.")
    if "audio" in key and "qkv" in key:
        assert value.shape[0] % 3 == 0
        for label, tensor in zip(("query", "key", "value"), value.chunk(3), strict=True):
            converted[key.replace("qkv", label)] = tensor
    else:
        converted[key] = value
config = ClapConfig.from_pretrained(ROOT / "model", local_files_only=True)
model = ClapModel(config)
expected = model.state_dict()
extras = [key for key in converted if key not in expected]
missing = [key for key in expected if key not in converted]
print(json.dumps({"missing": missing, "extras": extras}), flush=True)
# RoBERTa's single-segment zero buffer is registered persistently by this
# Transformers version, but is not a learned checkpoint parameter.
assert missing in ([], ["text_model.embeddings.token_type_ids"])
assert not any(key in dict(model.named_parameters()) for key in missing)
for key in missing:
    assert torch.count_nonzero(expected[key]) == 0
    converted[key] = expected[key]
allowed_unused = (
    "audio_model.audio_encoder.spectrogram_extractor.",
    "audio_model.audio_encoder.logmel_extractor.",
    "audio_model.audio_encoder.head.",
    "audio_model.audio_encoder.tscam_conv.",
    "audio_transform.", "text_transform.",
)
assert all(key.startswith(allowed_unused) or key == "text_model.embeddings.position_ids"
    or re.fullmatch(r"audio_model\.audio_encoder\.layers\.\d+\.blocks\.\d+\.attn_mask", key)
    for key in extras), extras
inference_weights = {key: value for key, value in converted.items() if key in expected}
model.load_state_dict(inference_weights, strict=True)
model.save_pretrained(target, safe_serialization=True)
ClapProcessor.from_pretrained(ROOT / "model", local_files_only=True).save_pretrained(target)
with (target / "model.safetensors").open("rb") as f:
    converted_hash = hashlib.file_digest(f, "sha256").hexdigest()
(target / "conversion.json").write_text(json.dumps({
    "schema": "saucebunny.clap-conversion-proof.v1",
    "source_revision": "b3708341862f581175dba5c356a4ebf74a9b6651",
    "source_sha256": "fae3e9c087f2909c28a09dc31c8dfcdacbc42ba44c70e972b58c1bd1caf6dedd",
    "safetensors_sha256": converted_hash,
    "derived_buffers": missing, "unused_source_keys": extras,
}, indent=2) + "\n")
print(json.dumps({"target": str(target), "logit_scale_a": float(model.logit_scale_a.detach()),
    "parameters": sum(p.numel() for p in model.parameters())}), flush=True)
