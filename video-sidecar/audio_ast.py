# Copyright 2022 MIT and The HuggingFace Inc. team. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Adapted from Transformers' Audio Spectrogram Transformer implementation.
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy at http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software distributed
# under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
# CONDITIONS OF ANY KIND, either express or implied. See the License for the
# specific language governing permissions and limitations under the License.

"""Offline float32 AST inference using existing MLX/NumPy, without PyTorch.

Scores are independent sigmoid outputs, not genre certainty. The worker checks
explicitly downloaded artifacts before loading this model.
The caller must provide source-timed PCM and preserve actual window coverage.
"""
from __future__ import annotations

import hashlib
import gc
import json
from pathlib import Path

import numpy as np

MODEL_ID = "ast-audioset"
MODEL_REVISION = "f826b80d28226b62986cc218e5cec390b1096902"
FILES = {
    "model.safetensors": "ae0c1e2ad4e1381d851fa9bf298ba13ebc9c5a914cdee2dbe427a6583869924d",
    "config.json": "a93d525511d77e8ecc933d09674b85099815bbbb417c228a4edd655e252fb9ff",
    "preprocessor_config.json": "8d04ba5a9c6fca5d39d0de2b1fd05ecf79deb589fbba279728bbebac39934231",
}
SAMPLE_RATE = 16_000
WINDOW_SAMPLES = SAMPLE_RATE * 10
FRAME_SAMPLES = 400
HOP_SAMPLES = 160
FFT_SAMPLES = 512


def prepare_features(pcm: np.ndarray, config: dict) -> np.ndarray:
    if (pcm.ndim != 1 or not FRAME_SAMPLES <= pcm.size <= WINDOW_SAMPLES
            or not np.isfinite(pcm).all()):
        raise ValueError("AST requires one finite mono PCM window between 25 ms and 10 seconds")
    from transformers.audio_utils import mel_filter_bank, spectrogram, window_function

    filters = mel_filter_bank(num_frequency_bins=FFT_SAMPLES // 2 + 1,
        num_mel_filters=config["num_mel_bins"], min_frequency=20, max_frequency=SAMPLE_RATE // 2,
        sampling_rate=SAMPLE_RATE, norm=None, mel_scale="kaldi", triangularize_in_mel_space=True)
    features = spectrogram(pcm, window_function(FRAME_SAMPLES, "hann", periodic=False),
        frame_length=FRAME_SAMPLES, hop_length=HOP_SAMPLES, fft_length=FFT_SAMPLES,
        power=2.0, center=False, preemphasis=0.97, mel_filters=filters,
        log_mel="log", mel_floor=1.192092955078125e-07, remove_dc_offset=True).T
    features = np.pad(features, ((0, config["max_length"] - len(features)), (0, 0)))
    return ((features - config["mean"]) / (config["std"] * 2)).astype(np.float32)[None]


class AudioSpectrogramClassifier:
    def __init__(self, directory: Path, memory_bytes: int | None = None):
        for filename, digest in FILES.items():
            with (directory / filename).open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != digest:
                    raise ValueError(f"Unreviewed AST artifact: {filename}")
        import mlx.core as mx

        self.mx = mx
        if memory_bytes is not None:
            mx.set_memory_limit(memory_bytes)
            mx.set_cache_limit(min(memory_bytes // 8, 512 * 1024 * 1024))
        self.config = json.loads((directory / "config.json").read_text())
        self.preprocessing = json.loads((directory / "preprocessor_config.json").read_text())
        self.labels = self.config["id2label"]
        self.weights = mx.load(str(directory / "model.safetensors"))
        self.prefix = "audio_spectrogram_transformer."
        self._used_weights: set[str] = set()

    def close(self):
        self.weights.clear()
        gc.collect()
        self.mx.clear_cache()

    def weight(self, key: str):
        self._used_weights.add(key)
        return self.weights[key]

    def linear(self, x, prefix: str):
        return x @ self.weight(prefix + ".weight").T + self.weight(prefix + ".bias")

    def norm(self, x, prefix: str):
        return self.mx.fast.layer_norm(x, self.weight(prefix + ".weight"),
            self.weight(prefix + ".bias"), self.config["layer_norm_eps"])

    def logits(self, input_values: np.ndarray):
        mx, c, prefix = self.mx, self.config, self.prefix
        if input_values.shape != (1, c["max_length"], c["num_mel_bins"]) or not np.isfinite(input_values).all():
            raise ValueError("AST expects one finite, normalized spectrogram")
        self._used_weights.clear()
        embeddings = prefix + "embeddings."
        patch = embeddings + "patch_embeddings.projection"
        image = mx.array(input_values).transpose(0, 2, 1)[..., None]
        x = mx.conv2d(image, self.weight(patch + ".weight").transpose(0, 2, 3, 1),
            stride=(c["frequency_stride"], c["time_stride"])) + self.weight(patch + ".bias")
        x = x.reshape(1, -1, c["hidden_size"])
        x = mx.concatenate([self.weight(embeddings + "cls_token"), self.weight(embeddings + "distillation_token"), x], axis=1)
        x = x + self.weight(embeddings + "position_embeddings")
        heads = c["num_attention_heads"]
        head_size = c["hidden_size"] // heads
        for index in range(c["num_hidden_layers"]):
            layer = prefix + f"encoder.layer.{index}."
            normalized = self.norm(x, layer + "layernorm_before")
            q, k, v = [self.linear(normalized, layer + "attention.attention." + name)
                .reshape(1, -1, heads, head_size).transpose(0, 2, 1, 3) for name in ("query", "key", "value")]
            attended = mx.fast.scaled_dot_product_attention(q, k, v, scale=head_size ** -0.5)
            x = x + self.linear(attended.transpose(0, 2, 1, 3).reshape(1, -1, c["hidden_size"]), layer + "attention.output.dense")
            hidden = self.linear(self.norm(x, layer + "layernorm_after"), layer + "intermediate.dense")
            hidden = hidden * .5 * (1 + mx.erf(hidden / 2 ** .5))
            x = x + self.linear(hidden, layer + "output.dense")
        x = self.norm(x, prefix + "layernorm")
        pooled = (x[:, 0] + x[:, 1]) / 2
        logits = self.linear(self.norm(pooled, "classifier.layernorm"), "classifier.dense")
        if self._used_weights != self.weights.keys():
            raise ValueError("Unused AST checkpoint parameters")
        mx.eval(logits)
        result = np.array(logits)
        mx.clear_cache()
        return result

    def classify(self, pcm: np.ndarray):
        logits = self.logits(prepare_features(pcm, self.preprocessing))
        scores = np.exp(-np.logaddexp(0, -logits[0]))
        return [{"label": self.labels[str(index)], "score": float(score)} for index, score in enumerate(scores)]
