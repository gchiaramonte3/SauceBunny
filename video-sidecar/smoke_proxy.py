"""Model-free packaged decoder check using generated footage, never user media."""
import argparse
import json
import os
import subprocess
from pathlib import Path

from test_worker import make_video


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="New directory for generated media and report")
    args = parser.parse_args()
    worker = args.worker.resolve(strict=True)
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    movie = root / "generated-colors.mp4"
    make_video(movie)
    env = {**os.environ, "PATH": "/usr/bin:/bin", "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}

    def request(payload):
        result = subprocess.run(["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)(deny network*)",
            str(worker), "--root", str(root / "data")], input=json.dumps(payload) + "\n",
            text=True, capture_output=True, timeout=90, env=env)
        if result.returncode or result.stderr.strip():
            raise RuntimeError(f"Packaged worker failed: {result.stdout[-4000:]}\n{result.stderr[-4000:]}")
        packets = [json.loads(line) for line in result.stdout.splitlines()]
        return next(packet for packet in packets if packet["type"] == "result")

    models = request({"operation": "models"})
    assert all(not model["ready"] for model in models["models"])
    source = request({"operation": "inspect-video", "path": str(movie)})["analysis_source"]
    proxy = request({"operation": "prepare-shot-proxy", "path": str(movie)})["scene_proxy"]
    assert proxy["source"] == source
    assert proxy["frame_count"] == 48
    assert proxy["time_map_version"] == "relative-pts-us-v1"
    assert proxy["time_map"][-1]["source_end_us"] == source["duration_us"] == 2_002_000
    assert request({"operation": "prepare-shot-proxy", "path": str(movie)})["scene_proxy"] == proxy
    assert not (root / "data" / "models").exists()
    report = {"status": "passed", "worker": str(worker), "fixture_root": str(root), "frames": 48,
        "source": source, "proxy": proxy, "network": "denied", "model_downloads": 0, "stderr": "empty"}
    destination = root / "report.json"
    destination.write_text(json.dumps(report, indent=2))
    print(destination)


if __name__ == "__main__":
    main()
