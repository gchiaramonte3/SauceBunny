"""Offline CLAP feasibility measurement, not a production classifier.

Uses only the approved scene fixture and generated controls. Records raw cosine
similarities, never calls them confidence, and makes no genre-accuracy claim.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import subprocess
import tempfile
import time

for name in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY", "HF_HUB_DISABLE_IMPLICIT_TOKEN"):
    os.environ[name] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

REVISION = "a0b4534a14f58e20944452dff00a22a06ce629d1"
WEIGHTS_HASH = "5c289311f4a030d768af7ffbfdecd01b008aa64824211899a4e59f4f9d154fd1"
SAMPLE_RATE = 48_000
WINDOW_SAMPLES = SAMPLE_RATE * 10  # Model's documented ten-second context.
LABELS = {
    "content": [
        "Only a person speaking. There is no music.",
        "Instrumental music playing without speech.",
        "A person speaking over background music.",
        "A person singing with music.",
        "Environmental sounds and noise without music.",
        "Silence with no audible sound.",
    ],
    "style": [f"This audio is a {style} song." for style in [
        "classical orchestral", "cinematic soundtrack", "electronic dance", "pop",
        "rock", "hip hop", "jazz", "acoustic folk", "country", "soul", "ambient",
    ]],
    "instrument": [f"The music features {instrument}." for instrument in [
        "piano", "acoustic guitar", "electric guitar", "orchestral strings",
        "synthesizers", "brass instruments", "drums", "percussion", "a choir", "deep bass",
    ]],
}


def audio_windows(path: Path, ffmpeg: Path):
    import numpy as np

    # Sequential bounded extraction for this proof. A production adapter must
    # additionally retain/gate timestamp gaps and nonzero A/V stream origins.
    # The current video-only PyAV build omits aformat/aresample. Exercise the
    # application's existing FFmpeg audio primitive instead of replacing it.
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen([str(ffmpeg), "-v", "error", "-nostdin", "-threads", "2",
            "-protocol_whitelist", "file", "-i", str(path), "-map", "0:a:0", "-vn",
            "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "pipe:1"],
            stdout=subprocess.PIPE, stderr=errors)
        try:
            index = 0
            while chunk := process.stdout.read(WINDOW_SAMPLES * 4):
                if len(chunk) % 4:
                    raise ValueError("Incomplete PCM sample")
                yield index, np.frombuffer(chunk, dtype="<f4")
                index += 1
            if process.wait() != 0:
                errors.seek(0)
                raise RuntimeError(errors.read(4096).decode("utf-8", "replace"))
        finally:
            process.stdout.close()
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def musical_control():
    import numpy as np
    result = np.zeros(WINDOW_SAMPLES, dtype=np.float32)
    # C-major arpeggios with damped harmonics: known musical structure, not a
    # licensed recording and not a test of genre-recognition accuracy.
    notes = [60, 64, 67, 72, 67, 64, 60, 55, 57, 60, 64, 69, 64, 60, 55, 59, 62, 67, 62, 59]
    for index, midi in enumerate(notes):
        start = index * SAMPLE_RATE // 2
        count = min(SAMPLE_RATE * 2, len(result) - start)
        t = np.arange(count) / SAMPLE_RATE
        fundamental = 440 * 2 ** ((midi - 69) / 12)
        note = sum(np.sin(2 * np.pi * fundamental * harmonic * t) * np.exp(-t * (2 + harmonic / 3)) / harmonic ** 1.5
                   for harmonic in range(1, 9))
        result[start:start + count] += (note * np.minimum(t * 300, 1) * 0.15).astype(np.float32)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("fixture", type=Path)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--speech", type=Path)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--converted", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--write-controls", action="store_true")
    args = parser.parse_args()
    root = args.work_dir.resolve(strict=True)
    model_dir = root / ("converted" if args.converted else "model")
    weight_path = model_dir / ("model.safetensors" if args.converted else "pytorch_model.bin")
    with weight_path.open("rb") as stream:
        weights_hash = hashlib.file_digest(stream, "sha256").hexdigest()
        if not args.converted:
            if weights_hash != WEIGHTS_HASH:
                raise ValueError("The Hub checkpoint does not match the reviewed revision")
        else:
            receipt = json.loads((model_dir / "conversion.json").read_text())
            if (receipt["schema"] != "saucebunny.clap-conversion-proof.v1"
                    or receipt["source_sha256"] != "fae3e9c087f2909c28a09dc31c8dfcdacbc42ba44c70e972b58c1bd1caf6dedd"
                    or receipt["safetensors_sha256"] != weights_hash):
                raise ValueError("The converted checkpoint does not match its receipt")

    import numpy as np
    import torch
    from transformers import ClapModel, ClapProcessor, __version__ as transformers_version

    torch.set_num_threads(args.threads)
    torch.manual_seed(0)
    np.random.seed(0)
    started = time.perf_counter()
    # Explicit safe tensor-only deserialization; never remote model code.
    model = ClapModel.from_pretrained(model_dir, local_files_only=True,
        trust_remote_code=False, use_safetensors=args.converted, weights_only=True).eval()
    processor = ClapProcessor.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False)
    load_seconds = time.perf_counter() - started
    prompts = [prompt for group in LABELS.values() for prompt in group]
    with torch.inference_mode():
        started = time.perf_counter()
        text = processor.tokenizer(prompts, padding=True, return_tensors="pt")
        text_result = model.get_text_features(**text)
        text_features = text_result if torch.is_tensor(text_result) else text_result.pooler_output
        text_seconds = time.perf_counter() - started

    gram = (text_features @ text_features.T).cpu().numpy()
    off_diagonal = gram[~np.eye(len(prompts), dtype=bool)]
    rows = []
    def classify(name, audio):
        started = time.perf_counter()
        features = processor.feature_extractor(audio, sampling_rate=SAMPLE_RATE,
            return_tensors="pt", truncation="rand_trunc", padding="repeatpad")
        prepared = time.perf_counter()
        with torch.inference_mode():
            result = model.get_audio_features(**features)
            embedding = result if torch.is_tensor(result) else result.pooler_output
            scores = (embedding @ text_features.T)[0].tolist()
        row = {"name": name, "seconds": len(audio) / SAMPLE_RATE,
               "rms": float(np.sqrt(np.mean(audio ** 2))),
               "preprocess_seconds": prepared - started,
               "inference_seconds": time.perf_counter() - prepared}
        offset = 0
        for group, labels in LABELS.items():
            row[group] = sorted([{"description": label, "cosine_similarity": score}
                for label, score in zip(labels, scores[offset:offset + len(labels)], strict=True)],
                key=lambda item: -item["cosine_similarity"])
            offset += len(labels)
        rows.append(row)
        if args.write_controls and name.startswith(("generated_", "digital_")):
            import wave
            with wave.open(str(args.output.parent / f"{name}.wav"), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(SAMPLE_RATE)
                output.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
        print(json.dumps(row), flush=True)

    music = musical_control()
    classify("generated_musical_arpeggio", music)
    classify("digital_silence", np.zeros(WINDOW_SAMPLES, dtype=np.float32))
    classify("generated_noise", np.random.default_rng(0).normal(0, 0.05, WINDOW_SAMPLES).astype(np.float32))
    if args.speech:
        stream = audio_windows(args.speech, args.ffmpeg)
        try:
            _, speech = next(stream)
        finally:
            stream.close()
        classify("generated_speech", speech)
        classify("generated_speech_with_music", speech * 0.7 + music[:len(speech)] * 0.7)
    for index, audio in audio_windows(args.fixture, args.ffmpeg):
        classify(f"reviewed_fixture_window_{index}", audio)

    report = {"model": "lukewys/laion_clap/music_audioset_epoch_15_esc_90.14.pt" if args.converted else "laion/larger_clap_music",
              "revision": "b3708341862f581175dba5c356a4ebf74a9b6651" if args.converted else REVISION,
              "weights_sha256": weights_hash, "transformers": transformers_version,
              "text_pairwise_cosine_min": float(off_diagonal.min()),
              "text_pairwise_cosine_max": float(off_diagonal.max()),
              "torch": torch.__version__, "device": "cpu", "threads": args.threads,
              "load_seconds": load_seconds, "text_embedding_seconds": text_seconds,
              "peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
              "vocabulary": LABELS, "windows": rows,
              "limitations": ["Not an accuracy benchmark", "No calibrated confidence or music-presence threshold",
                              "No production packaging", "Source extraction proof assumes contiguous zero-origin audio"]}
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key not in {"windows", "vocabulary"}}), flush=True)


if __name__ == "__main__":
    main()
