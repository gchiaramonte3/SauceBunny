"""Real frozen-worker acceptance. Uses only generated footage, never user media."""
import argparse
import json
import os
import selectors
import resource
import subprocess
import tempfile
import time
from pathlib import Path

from test_worker import make_video
from media import windows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", type=Path, required=True)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    root = args.output / "data"
    root.mkdir(exist_ok=True)
    if not (root / "models").exists():
        (root / "models").symlink_to(args.models.resolve(), target_is_directory=True)
    movie = args.output / "generated-colors.mp4"
    make_video(movie, seconds=14)
    env = {**os.environ, "PATH": "/usr/bin:/bin", "HF_HOME": str(args.output / "empty-hf-cache"),
           "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}
    command = ["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)(deny network*)",
               str(args.worker.resolve()), "--root", str(root.resolve())]
    evidence = {}

    def request(payload, name):
        start = time.monotonic()
        result = subprocess.run(command, input=json.dumps(payload) + "\n", text=True, capture_output=True,
                                env=env, timeout=180)
        packets = [json.loads(line) for line in result.stdout.splitlines()]
        evidence[name] = {"seconds": time.monotonic() - start, "exit_code": result.returncode,
                          "peak_child_rss_bytes": resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss,
                          "packets": packets, "stderr": result.stderr[-4000:]}
        args.output.joinpath("evidence.json").write_text(json.dumps(evidence, indent=2))
        if result.returncode:
            raise RuntimeError(f"{name}: {result.stdout}\n{result.stderr[-4000:]}")
        if "resource_tracker" in result.stderr or "the following arguments are required: --root" in result.stderr:
            raise RuntimeError(f"{name}: frozen multiprocessing helper failed: {result.stderr[-4000:]}")
        return next(packet for packet in packets if packet["type"] == "result")

    request({"operation": "models"}, "models")
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, env=env)
    process.stdin.write(json.dumps({"operation": "index", "paths": [str(movie.resolve())]}) + "\n")
    process.stdin.flush()
    deadline = time.monotonic() + 30
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while time.monotonic() < deadline:
                if not selector.select(1):
                    continue
                line = process.stdout.readline()
                if not line:
                    raise RuntimeError("Worker exited before cold-load cancellation")
                packet = json.loads(line)
                if packet.get("phase") == "loading-model":
                    start = time.monotonic()
                    process.terminate()
                    process.communicate(timeout=2)
                    evidence["cold_stop"] = {"seconds": time.monotonic() - start, "code": process.returncode}
                    break
            else:
                raise RuntimeError("No cold-load progress before timeout")
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate()
    indexed = request({"operation": "index", "paths": [str(movie.resolve())]}, "index")
    source = next(source for source in indexed["sources"] if source["path"] == str(movie.resolve()))
    expected_segments = len(list(windows(source["duration"])))
    assert source["complete"] and source["segments"] == expected_segments
    resumed = request({"operation": "index", "paths": [str(movie.resolve())]}, "resume")
    assert next(s for s in resumed["sources"] if s["key"] == source["key"])["segments"] == expected_segments
    assert not any(packet.get("phase") == "loading-model" for packet in evidence["resume"]["packets"])
    found = request({"operation": "search", "query": "A blue screen", "scope": [source["key"]], "rerank": True}, "search")
    assert found["hits"] and all(hit["path"] == str(movie.resolve()) for hit in found["hits"])
    answer = request({"operation": "reason", "query": "What color fills these frames?", "segments": [found["hits"][0]["id"]], "transcripts": {}}, "reason")
    assert answer["answers"] and "blue" in answer["answers"][0]["text"].lower()
    proxy = request({"operation": "prepare-shot-proxy", "path": str(movie.resolve())}, "shot_proxy")["scene_proxy"]
    inspection = request({"operation": "inspect-video", "path": str(movie.resolve())}, "shot_source")["analysis_source"]
    assert proxy["source"] == inspection and proxy["frame_count"] == 336
    # This generated fixture changes color at source frame 24 (1.001 s).
    # The browser fixture tests separately establish the real cut detector.
    shots = [{"id": 1, "start_us": 0, "end_us": 1_001_000, "transcript": "A supplied test line."},
             {"id": 2, "start_us": 1_001_000, "end_us": inspection["duration_us"], "transcript": ""}]
    described = request({"operation": "analyze-shots", "path": str(movie.resolve()),
                         "source_sha256": inspection["sha256"], "analysis_id": "a" * 64,
                         "query": "What color fills each supplied shot? Keep supplied text separate from visual observations.",
                         "shots": shots}, "shot_descriptions")["shot_analysis"]
    assert described["audio_analyzed"] is False and len(described["shots"]) == 2
    for supplied, result, color in zip(shots, described["shots"], ["red", "blue"]):
        assert all(result[key] == value for key, value in supplied.items())
        assert color in result["text"].lower()
        assert all(supplied["start_us"] <= pts < supplied["end_us"] for pts in result["frame_pts_us"])
    args.output.joinpath("evidence.json").write_text(json.dumps(evidence, indent=2))
    print(json.dumps({key: value.get("seconds") for key, value in evidence.items()}, indent=2))


if __name__ == "__main__":
    main()
