"""Pinned model artifacts. Downloads are explicit; inference never calls the Hub."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import urllib.request
from pathlib import Path

MANIFEST = json.loads((Path(__file__).parent / "models.json").read_text())
MODELS = {model["id"]: model for model in MANIFEST["models"]}
for _model in MODELS.values():
    _model["total_bytes"] = sum(item["bytes"] for item in _model["files"])


def model_spec(model_id: str) -> dict:
    if model_id not in MODELS:
        raise ValueError("Choose a supported video model")
    return MODELS[model_id]


def model_directory(root: Path, model_id: str) -> Path:
    spec = model_spec(model_id)
    return root / model_id / spec["revision"]


def fingerprint(spec: dict) -> str:
    return hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()


def ready(root: Path, model_id: str) -> bool:
    spec, directory = model_spec(model_id), model_directory(root, model_id)
    try:
        receipt = json.loads((directory / ".verified.json").read_text())
        if receipt["manifest"] != fingerprint(spec):
            return False
        for item in spec["files"]:
            path = directory / item["name"]
            stat = path.stat()
            if path.is_symlink() or stat.st_size != item["bytes"] or stat.st_mtime_ns != receipt["files"][item["name"]]:
                return False
        return True
    except (OSError, ValueError, KeyError, TypeError):
        return False


def require_model(root: Path, model_id: str) -> Path:
    if not ready(root, model_id):
        raise ValueError(f"Download {model_spec(model_id)['name']} in Settings → Video Intelligence")
    return model_directory(root, model_id)


def download(root: Path, model_id: str, progress):
    spec, directory = model_spec(model_id), model_directory(root, model_id)
    if directory.is_symlink() or directory.parent.is_symlink():
        raise ValueError("The video model folder must not be a symbolic link")
    directory.mkdir(parents=True, exist_ok=True)
    if ready(root, model_id):
        return
    if shutil.disk_usage(directory).free < spec["total_bytes"] + 512 * 1024 * 1024:
        raise ValueError("Not enough free space for this model")
    complete = 0
    for item in spec["files"]:
        destination = directory / item["name"]
        temporary = directory / (item["name"] + ".partial")
        if destination.is_symlink() or temporary.is_symlink():
            raise ValueError("Model artifacts must not be symbolic links")
        # Reuse only fully hash-verified artifacts after a cancelled download.
        digest = hashlib.sha256()
        if destination.is_file() and destination.stat().st_size == item["bytes"]:
            with destination.open("rb") as source:
                for chunk in iter(lambda: source.read(4 * 1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() == item["sha256"]:
                complete += item["bytes"]
                progress("downloading", complete, spec["total_bytes"])
                continue
        url = f"https://huggingface.co/{spec['repo']}/resolve/{spec['revision']}/{item['name']}"
        request = urllib.request.Request(url, headers={"User-Agent": "SauceBunny-Video/1"})
        digest, received = hashlib.sha256(), 0
        with urllib.request.urlopen(request, timeout=30) as response, temporary.open("wb") as target:
            if response.status != 200 or not response.url.startswith("https://"):
                raise ValueError("The model server returned an invalid response")
            while chunk := response.read(1024 * 1024):
                received += len(chunk)
                if received > item["bytes"]:
                    raise ValueError("The model download exceeded its expected size")
                target.write(chunk)
                digest.update(chunk)
                progress("downloading", complete + received, spec["total_bytes"])
            target.flush()
            os.fsync(target.fileno())
        if received != item["bytes"] or digest.hexdigest() != item["sha256"]:
            raise ValueError("The model download failed its integrity check. Try downloading again.")
        os.replace(temporary, destination)
        complete += received
    receipt = {"manifest": fingerprint(spec), "files": {
        item["name"]: (directory / item["name"]).stat().st_mtime_ns for item in spec["files"]}}
    temporary = directory / ".verified.partial"
    temporary.write_text(json.dumps(receipt))
    os.replace(temporary, directory / ".verified.json")


def delete(root: Path, model_id: str):
    directory = model_directory(root, model_id)
    if directory.is_symlink() or directory.parent.is_symlink():
        raise ValueError("The video model folder must not be a symbolic link")
    if directory.is_dir():
        shutil.rmtree(directory)
