"""One owned request per process; stdout is a bounded JSON-lines protocol."""
from __future__ import annotations

# PyInstaller reuses this executable for resource-tracker/spawn helpers. Divert
# those invocations before importing model infrastructure or parsing --root.
if __name__ == "__main__":
    import multiprocessing
    multiprocessing.freeze_support()

import argparse
import contextlib
import fcntl
import json
import os
import sys
import time
from pathlib import Path

from artifacts import MODELS, delete, download, model_spec, ready, require_model
from index_store import IndexStore, source_identity, source_unchanged
from media import Video, windows
from shot_analysis import analyze_shots, inspect_source, picture_model
from audio_ast import MODEL_ID as AUDIO_MODEL

VERSION = "1"
EMBEDDING = "qwen3-vl-embedding-2b"
RERANKER = "qwen3-vl-reranker-2b"
REASONING = "qwen3.5-9b-video"
PROTOCOL_OUT = sys.stdout


def emit(value):
    print(json.dumps(value, allow_nan=False, separators=(",", ":")), file=PROTOCOL_OUT, flush=True)


def progress(phase, completed=0, total=0):
    emit({"type": "progress", "phase": phase, "completed": completed, "total": total})


def bounded_text(value, maximum, name):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"Invalid {name}")
    return value.strip()


def local_path(value):
    path = Path(bounded_text(value, 4096, "video path"))
    if not path.is_absolute() or not path.is_file():
        raise ValueError("Choose a local video file")
    return path.resolve(strict=True)


def identity():
    spec = model_spec(EMBEDDING)
    return f"{EMBEDDING}@{spec['revision']}"


def load_model(root, model_id, memory):
    # Receipt check before importing MLX. A missing model can never trigger an
    # implicit Hub download in a third-party loader.
    directory = require_model(root, model_id)
    progress("loading-model")
    if model_id == AUDIO_MODEL:
        from audio_ast import AudioSpectrogramClassifier
        return AudioSpectrogramClassifier(directory, memory)
    from inference import Inference
    return Inference(directory, model_spec(model_id)["role"], memory)


def index_files(store, models, paths, memory):
    if not isinstance(paths, list) or not 1 <= len(paths) <= 2000:
        raise ValueError("Choose between 1 and 2,000 local videos")
    paths = list(dict.fromkeys(local_path(path) for path in paths))
    engine = None
    try:
        for position, path in enumerate(paths):
            progress("inspecting", position, len(paths))
            source = source_identity(path)
            with contextlib.closing(Video(path)) as video:
                segments = windows(video.duration)
                key = store.begin_source(source, video.duration, identity())
                completed = store.ordinals(key)
                for ordinal, (start, end) in enumerate(segments):
                    if ordinal not in completed:
                        if engine is None:
                            engine = load_model(models, EMBEDDING, memory)
                        frames, timestamps = video.sample(start, end)
                        embedding = engine.embed(frames=frames, timestamps=timestamps)
                        store.save_segment(key, ordinal, start, end, timestamps, embedding)
                    progress("indexing", ordinal + 1, len(segments))
                store.finish_source(key, len(segments))
        return {"sources": store.sources()}
    finally:
        if engine is not None:
            engine.close()


def search(store, models, request, memory):
    query = bounded_text(request.get("query"), 1000, "search query")
    scope = request.get("scope")
    if not isinstance(scope, list) or not scope or len(scope) > 2000 or not all(isinstance(key, str) for key in scope):
        raise ValueError("Choose indexed sources to search")
    engine = load_model(models, EMBEDDING, memory)
    try:
        progress("searching")
        hits = store.search(engine.embed(text=query), identity(), scope)
    finally:
        engine.close()
    if request.get("rerank") and hits:
        engine = load_model(models, RERANKER, memory)
        try:
            for position, hit in enumerate(hits):
                with contextlib.closing(Video(Path(hit["path"]))) as video:
                    frames, times = video.sample(hit["start"], hit["end"])
                    hit["score"] = engine.rerank(query, frames, times)
                progress("ranking", position + 1, len(hits))
            hits.sort(key=lambda hit: (-hit["score"], hit["id"]))
        finally:
            engine.close()
    return {"hits": hits}


def reason(store, models, request, memory):
    query = bounded_text(request.get("query"), 1000, "video question")
    # Resolve candidate IDs against durable evidence, not renderer-supplied
    # paths or language-model-generated timestamps.
    ids = request.get("segments")
    if not isinstance(ids, list) or not 1 <= len(ids) <= 4 or not all(type(i) is int and i > 0 for i in ids):
        raise ValueError("Choose up to four video moments")
    evidence = []
    sources = {s["key"]: s for s in store.sources() if s["available"] and s["model"] == identity()}
    for segment_id in dict.fromkeys(ids):
        row = store.db.execute("SELECT * FROM segments WHERE id=?", (segment_id,)).fetchone()
        if not row or row["source_key"] not in sources:
            raise ValueError("A selected video changed or is unavailable. Reindex it first.")
        evidence.append((dict(row), sources[row["source_key"]]))
    transcripts = request.get("transcripts", {})
    if not isinstance(transcripts, dict) or len(json.dumps(transcripts)) > 64000:
        raise ValueError("Transcript context is too large")
    selected = picture_model(request)
    engine = load_model(models, selected, memory)
    answers = []
    try:
        for position, (segment, source) in enumerate(evidence):
            if not source_unchanged(source):
                raise ValueError("A selected video changed during analysis")
            with contextlib.closing(Video(Path(source["path"]))) as video:
                frames, times = video.sample(segment["start"], segment["end"])
                transcript = transcripts.get(str(segment["id"]), "")
                if not isinstance(transcript, str):
                    raise ValueError("Invalid transcript context")
                text = engine.reason(query, frames, times, transcript)
            answers.append({"id": segment["id"], "path": source["path"], "start": segment["start"],
                            "end": segment["end"], "text": text})
            progress("analyzing", position + 1, len(evidence))
        return {"answers": answers}
    finally:
        engine.close()


def dispatch(root: Path, request: dict):
    models = root / "models"
    operation = request.get("operation")
    if operation == "models":
        return {"models": [{"id": model["id"], "name": model["name"], "role": model["role"],
            "bytes": model["total_bytes"], "ready": ready(models, model["id"])} for model in MODELS.values()]}
    if operation == "download":
        download(models, request.get("model_id"), progress)
        return dispatch(root, {"operation": "models"})
    if operation == "delete-model":
        delete(models, request.get("model_id"))
        return dispatch(root, {"operation": "models"})
    memory = request.get("memory_bytes", 8 * 1024**3)
    if type(memory) is not int or not 2 * 1024**3 <= memory <= 16 * 1024**3:
        raise ValueError("Invalid local inference memory limit")
    if operation == "inspect-video":
        return inspect_source(local_path(request.get("path")))
    if operation == "prepare-shot-proxy":
        from scene_proxy import prepare_proxy
        return prepare_proxy(root, local_path(request.get("path")), progress)
    if operation == "analyze-shots":
        return analyze_shots(local_path(request.get("path")), request,
                             lambda: load_model(models, picture_model(request), memory), progress)
    if operation == "analyze-music":
        # Require the explicit download even for silence/no-audio. Readiness is
        # a receipt check only; the classifier itself stays lazy until needed.
        require_model(models, AUDIO_MODEL)
        from music_analysis import analyze_music
        analyze_music(local_path(request.get("path")), request,
                      lambda: load_model(models, AUDIO_MODEL, memory), emit)
        return None  # Streaming operation already emitted its terminal packet.
    with contextlib.closing(IndexStore(root / "index")) as store:
        if operation == "sources":
            return {"sources": store.sources()}
        if operation == "forget":
            store.forget(bounded_text(request.get("source_key"), 64, "source identity"))
            return {"sources": store.sources()}
        if operation == "index":
            return index_files(store, models, request.get("paths"), memory)
        if operation == "search":
            return search(store, models, request, memory)
        if operation == "reason":
            return reason(store, models, request, memory)
        raise ValueError("Unknown video operation")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", action="version", version=f"saucebunny-video {VERSION}")
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    root = args.root
    if not root.is_absolute():
        raise ValueError("The derived-data folder must be absolute")
    root.mkdir(parents=True, exist_ok=True)
    raw = sys.stdin.buffer.readline(256 * 1024 + 1)
    if len(raw) > 256 * 1024:
        raise ValueError("Video request is too large")
    request = json.loads(raw)
    if not isinstance(request, dict):
        raise ValueError("Invalid video request")
    # Receipts publish atomically; SQLite readers use WAL. Opening Settings
    # during indexing must neither cancel the index nor load any model.
    if request.get("operation") in ("models", "sources"):
        with contextlib.redirect_stdout(sys.stderr):
            result = dispatch(root, request)
        emit({"type": "result", **result})
        return
    # A second app/window cannot overwrite an active index or delete live weights.
    with (root / "worker.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Video Intelligence is already working. Stop it before starting another task.") from None
        with contextlib.redirect_stdout(sys.stderr):
            result = dispatch(root, request)
    if result is not None:
        emit({"type": "result", **result})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        import traceback
        traceback.print_exc(file=sys.stderr)
        emit({"type": "error", "message": str(error)[:2000]})
        sys.exit(1)
