"""Opt-in real-worker smoke. Uses supplied local weights and the reviewed fixture.

No model downloads or app-data writes. The JSON report can be fed through the
production Rust collector with SAUCE_MUSIC_WORKER_REPORT.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import selectors
import signal
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "video-sidecar"))
from artifacts import download, model_directory, model_spec, ready  # noqa: E402
from audio_ast import MODEL_ID  # noqa: E402
from index_store import source_identity  # noqa: E402
from shot_analysis import inspect_source  # noqa: E402

FIXTURE_SHA256 = "c2b9b3ea9727c598674e7044967d68476cee5772ba7de7458c2951f90cb727e8"
EXPECTED_RANGES = [(0, 10_000_000), (10_000_000, 20_000_000), (20_000_000, 23_500_000)]
TEST_DEADLINE_SECONDS = 180
OFFLINE_SANDBOX = ["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)(deny network*)"]


def run_worker(command, root, request, stop_at=None):
    packets, pending = [], b""
    started, stopped = time.monotonic(), None
    deadline = started + TEST_DEADLINE_SECONDS
    env = {**os.environ, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "HF_HOME": str(root / "hub"),
        "HTTPS_PROXY": "http://127.0.0.1:9", "HTTP_PROXY": "http://127.0.0.1:9"}
    with tempfile.TemporaryFile() as errors, subprocess.Popen([*OFFLINE_SANDBOX, *command, "--root", str(root)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors, env=env) as process:
        try:
            process.stdin.write(json.dumps(request).encode() + b"\n")
            process.stdin.close()
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not selector.select(remaining):
                        raise TimeoutError("Real-worker smoke exceeded its test deadline")
                    chunk = os.read(process.stdout.fileno(), 65536)
                    if not chunk:
                        break
                    pending += chunk
                    while b"\n" in pending:
                        line, pending = pending.split(b"\n", 1)
                        packet = json.loads(line)
                        packets.append(packet)
                        if stopped is None and stop_at and stop_at(packet):
                            stopped = time.monotonic()
                            process.terminate()
            code = process.wait(timeout=max(.001, deadline - time.monotonic()))
            if pending:
                raise AssertionError("Worker left an incomplete protocol line")
            ended = time.monotonic()
            errors.seek(0)
            return {"exit_code": code, "elapsed_ms": (ended - started) * 1000,
                "stop_to_exit_ms": None if stopped is None else (ended - stopped) * 1000,
                "packets": packets, "stderr": errors.read().decode(errors="replace")[-16_384:]}
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()


def validate_complete(result, request):
    assert result["exit_code"] == 0, result["stderr"]
    packets = result["packets"]
    assert packets and packets[-1]["type"] == "complete", packets
    assert all(p["type"] in ("progress", "window", "complete") for p in packets)
    assert sum(p["type"] == "complete" for p in packets) == 1
    windows = [p for p in packets if p["type"] == "window"]
    assert [(p["start_us"], p["end_us"]) for p in windows] == EXPECTED_RANGES
    complete = packets[-1]
    assert complete["source_sha256"] == request["source_sha256"]
    assert complete["analysis_id"] == request["analysis_id"]
    assert complete["origin_us"] == request["origin_us"]
    assert complete["duration_us"] == request["duration_us"]
    assert complete["audio_track_index"] == request["audio_track_index"]
    assert complete["status"] == "decoded" and complete["windows"] == len(windows)
    assert complete["maximum_retained_frames"] == 160_000
    assert len(complete["labels"]) == len(set(complete["labels"])) == 527
    for window in windows:
        assert window["status"] == "classified"
        raw = base64.b64decode(window["scores_f32le"], validate=True)
        scores = struct.unpack("<527f", raw)
        assert all(0 <= value <= 1 for value in scores)
        assert 0 < window["rms"] <= window["peak"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--worker", type=Path, help="Frozen worker; defaults to the source worker with this Python")
    args = parser.parse_args()
    # A sandbox failure must not be mistaken for a successful offline smoke.
    probe = subprocess.run([*OFFLINE_SANDBOX, sys.executable, "-c",
        'import socket; socket.socket().bind(("127.0.0.1", 0))'], capture_output=True, text=True, timeout=10)
    assert probe.returncode != 0 and "Operation not permitted" in probe.stderr, "Network denial canary failed"
    path = args.fixture.resolve(strict=True)
    assert source_identity(path)["sha256"] == FIXTURE_SHA256, "Use the reviewed 23.5-second scene fixture"
    source = inspect_source(path)["analysis_source"]
    assert source["origin_us"] == 0 and source["duration_us"] == 23_500_000
    request = {"operation": "analyze-music", "path": str(path), "source_sha256": source["sha256"],
        "analysis_id": "a" * 64, "origin_us": source["origin_us"], "duration_us": source["duration_us"],
        "audio_track_index": 0}
    command = [str(args.worker.resolve(strict=True))] if args.worker else [sys.executable, str(REPO / "video-sidecar/worker.py")]
    with tempfile.TemporaryDirectory(prefix="sauce-music-worker-") as folder:
        root = Path(folder)
        missing = run_worker(command, root, request)
        assert missing["exit_code"] != 0
        assert [p["type"] for p in missing["packets"]] == ["error"]
        assert "Download AudioSet AST" in missing["packets"][0]["message"]
        directory = model_directory(root / "models", MODEL_ID)
        directory.mkdir(parents=True)
        for item in model_spec(MODEL_ID)["files"]:
            shutil.copy2(args.model_dir / item["name"], directory / item["name"])
        # Production download verifies every already-present artifact and writes
        # its receipt. Any attempt to fetch rather than reuse is a test failure.
        with patch("artifacts.urllib.request.urlopen", side_effect=AssertionError("Network is forbidden in this smoke")):
            download(root / "models", MODEL_ID, lambda *_: None)
        assert ready(root / "models", MODEL_ID)
        completed = run_worker(command, root, request)
        validate_complete(completed, request)
        stops = {}
        for stage, predicate in (("model-load", lambda p: p["type"] == "progress" and p.get("phase") == "loading-model"),
                                 ("inference", lambda p: p["type"] == "window")):
            stopped = run_worker(command, root, request, predicate)
            assert stopped["exit_code"] == -signal.SIGTERM
            assert stopped["stop_to_exit_ms"] is not None and stopped["stop_to_exit_ms"] <= 1000
            assert not any(p["type"] in ("complete", "result") for p in stopped["packets"])
            assert ready(root / "models", MODEL_ID), "Stop damaged verified model artifacts"
            stops[stage] = stopped
        restarted = run_worker(command, root, request)
        validate_complete(restarted, request)
        report = {"schema": "sauce.music-worker-smoke.v1", "command": command, "network": "sandbox-denied", "request": request,
            "missing_model": missing, "completed": completed, "stopped": stops, "restarted": restarted}
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"report": str(args.output), "windows": len(EXPECTED_RANGES), "labels": 527,
            "complete_ms": completed["elapsed_ms"], "stop_ms": {stage: row["stop_to_exit_ms"] for stage, row in stops.items()}}))


if __name__ == "__main__":
    main()
