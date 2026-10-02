"""Qwen-only packaged smoke: generated footage, existing weights, network denied.

This is not the unavailable reviewed scene-detection fixture or a model-quality
benchmark. It verifies actual offline inference and source-bound shot transport.
"""
import argparse
import json
import os
import re
import selectors
import subprocess
import time
from collections import Counter
from pathlib import Path

from test_worker import make_video


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", type=Path, required=True)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", choices=["qwen3.5-9b-video", "qwen3.5-4b-video"], default="qwen3.5-9b-video")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    root = output / "data"
    root.mkdir()
    (root / "models").symlink_to(args.models.resolve(strict=True), target_is_directory=True)
    movie = output / "generated-colors.mp4"
    make_video(movie)
    env = {**os.environ, "PATH": "/usr/bin:/bin", "HF_HOME": str(output / "empty-hf-cache"),
           "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}
    command = ["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)(deny network*)",
               str(args.worker.resolve(strict=True)), "--root", str(root)]
    evidence = {"network": "denied", "fixture": "generated red then blue, not reviewed reference",
                "worker": str(args.worker), "requests": {}}

    def request(payload, name):
        start = time.monotonic()
        result = subprocess.run(command, input=json.dumps(payload) + "\n", text=True,
                                capture_output=True, env=env, timeout=240)
        packets = [json.loads(line) for line in result.stdout.splitlines()]
        evidence["requests"][name] = {"seconds": time.monotonic() - start,
            "exit_code": result.returncode, "packets": packets, "stderr": result.stderr[-4000:]}
        (output / "report.json").write_text(json.dumps(evidence, indent=2))
        assert result.returncode == 0, f"{name}: {result.stdout[-4000:]} {result.stderr[-4000:]}"
        assert "resource_tracker" not in result.stderr, result.stderr[-4000:]
        assert "the following arguments are required: --root" not in result.stderr
        return next(packet for packet in packets if packet["type"] == "result")

    models = request({"operation": "models"}, "models")["models"]
    assert next(model for model in models if model["id"] == args.model)["ready"]
    source = request({"operation": "inspect-video", "path": str(movie)}, "source")["analysis_source"]
    shots = [{"id": 1, "start_us": 0, "end_us": 1_001_000, "transcript": "Supplied test dialogue."},
             {"id": 2, "start_us": 1_001_000, "end_us": source["duration_us"], "transcript": ""}]
    shot_request = {"operation": "analyze-shots", "path": str(movie), "model_id": args.model,
        "source_sha256": source["sha256"], "analysis_id": "a" * 64,
        # Match the real AI Summary question, not an easier color-only prompt.
        "query": "Describe what is visibly happening in this supplied shot. Then summarize what the supplied transcript says, if any. Keep visual observations and supplied speech distinct. Do not infer music or other sounds, invent cuts, or change shot boundaries.",
        "shots": shots}

    def cancel_at(phase):
        # Stop on observed work, not after a guessed sleep. The following full
        # trials prove that cancellation released the worker's process lock.
        packets, stopped_at = [], None
        child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True, env=env)
        try:
            child.stdin.write(json.dumps(shot_request) + "\n")
            child.stdin.close()
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ)
                deadline = time.monotonic() + 240
                while time.monotonic() < deadline:
                    if not selector.select(timeout=min(1, max(0, deadline - time.monotonic()))):
                        continue
                    line = child.stdout.readline()
                    if not line:
                        break
                    packet = json.loads(line)
                    packets.append(packet)
                    if packet.get("type") == "progress" and packet.get("phase") == phase:
                        stopped_at = time.monotonic()
                        child.terminate()
                        break
            assert stopped_at is not None, f"Cancellation phase not observed: {phase}"
            child.wait(timeout=10)
            latency = time.monotonic() - stopped_at
            packets.extend(json.loads(line) for line in child.stdout.read().splitlines())
            stderr = child.stderr.read()
            evidence["requests"][f"cancel-{phase}"] = {"exit_code": child.returncode,
                "stop_seconds": latency, "packets": packets, "stderr": stderr[-4000:]}
            (output / "report.json").write_text(json.dumps(evidence, indent=2))
            assert child.returncode != 0, "Cancelled worker completed successfully"
            assert not any(packet["type"] == "result" for packet in packets), "Cancelled result was adoptable"
            assert latency < 2, f"Worker termination took {latency:.3f} seconds"
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=10)
            child.stdout.close()
            child.stderr.close()

    cancel_at("loading-model")
    cancel_at("analyzing-shots")
    failures = []
    for trial in range(3):
        answer = request(shot_request, f"shots-{trial + 1}")["shot_analysis"]
        assert answer["model_id"] == args.model
        assert answer["source"] == source and answer["analysis_id"] == "a" * 64
        assert answer["audio_analyzed"] is False and len(answer["shots"]) == 2
        for supplied, actual, color in zip(shots, answer["shots"], ["red", "blue"]):
            assert all(actual[key] == value for key, value in supplied.items())
            assert actual["frame_pts_us"] and all(supplied["start_us"] <= pts < supplied["end_us"]
                                                   for pts in actual["frame_pts_us"])
            if color not in actual["text"].lower():
                failures.append(f"Trial {trial + 1}, shot {supplied['id']}: expected {color}; {actual['text']}")
            sentences = [s.strip().lower() for s in re.split(r"[.!?]+", actual["text"]) if s.strip()]
            if max(Counter(sentences).values(), default=0) >= 3:
                failures.append(f"Trial {trial + 1}, shot {supplied['id']}: repeated sentences; {actual['text']}")
    evidence["status"] = "failed" if failures else "passed"
    evidence["failures"] = failures
    (output / "report.json").write_text(json.dumps(evidence, indent=2))
    print(output / "report.json", flush=True)
    assert not failures, "\n".join(failures)


if __name__ == "__main__":
    main()
