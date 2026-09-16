"""Release gate for the frozen worker: recipe identity, payload and OS floor."""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

STAMP = "runtime-manifest.json"
MAGIC = {b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xca\xfe\xba\xbe"}


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def recipe(repo):
    paths = sorted({*repo.joinpath("video-sidecar").glob("*.py"),
                    *repo.joinpath("video-sidecar").glob("requirements*"),
                    repo / "video-sidecar/models.json",
                    *repo.joinpath("scripts").glob("build-video*.sh")})
    return {str(path.relative_to(repo)): digest(path) for path in paths}


def inventory(root):
    entries = {}
    for path in sorted(root.rglob("*")):
        name = str(path.relative_to(root))
        if name == STAMP:
            continue
        if path.is_symlink():
            if not path.resolve().is_relative_to(root.resolve()) or not path.resolve().exists():
                raise ValueError(f"External or broken runtime link: {name}")
            # Tauri copies resource files with fs::copy, dereferencing file
            # aliases. Compare their payload, not the link representation.
            if path.is_dir():
                raise ValueError(f"Directory aliases are not supported in the runtime: {name}")
        if path.is_dir():
            continue
        with path.open("rb") as stream:
            native = stream.read(4) in MAGIC
        # Release signing legitimately changes Mach-O signature bytes. Verify
        # signatures/linkage separately; hash all non-native payload verbatim.
        entries[name] = {"native": True} if native else {"sha256": digest(path)}
    return entries


def audit_native(root, entries):
    for name, entry in entries.items():
        if not entry.get("native"):
            continue
        loads = subprocess.check_output(["/usr/bin/otool", "-l", str(root / name)], text=True)
        versions = re.findall(r"\bminos ([\d.]+)", loads)
        versions += re.findall(r"LC_VERSION_MIN_MACOSX\s+cmdsize \d+\s+version ([\d.]+)", loads)
        if not versions or any(tuple(map(int, v.split(".")[:2])) > (14, 0) for v in versions):
            raise ValueError(f"Runtime exceeds macOS 14 floor: {name}: {versions}")
        if "x264" in name or "x265" in name:
            raise ValueError(f"Unexpected GPL decoder dependency: {name}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["stamp", "verify"])
    parser.add_argument("runtime", type=Path)
    parser.add_argument("--repo", type=Path, required=True)
    args = parser.parse_args()
    root, repo = args.runtime.resolve(), args.repo.resolve()
    if not (root / "saucebunny-video").is_file():
        raise ValueError("Frozen video worker is missing")
    entries = inventory(root)
    expected = {"schema": 1, "minimum_macos": "14.0", "recipe": recipe(repo), "files": entries}
    audit_native(root, entries)
    for required in ("_internal/models.json", "_internal/mlx.metallib", "_internal/licenses/dependencies/dependency-inventory.json",
                     "_internal/licenses/ffmpeg/COPYING.LGPLv2.1", "_internal/licenses/ffmpeg/ffmpeg-8.0.3.tar.xz"):
        if required not in entries:
            raise ValueError(f"Runtime material is missing: {required}")
    if digest(root / "_internal/models.json") != digest(repo / "video-sidecar/models.json"):
        raise ValueError("Frozen model manifest differs from source")
    if digest(root / "_internal/mlx.metallib") != digest(root / "_internal/mlx/lib/mlx.metallib"):
        raise ValueError("MLX shader alias differs from its pinned library payload")
    if args.mode == "stamp":
        (root / STAMP).write_text(json.dumps(expected, indent=2) + "\n")
    else:
        if json.loads((root / STAMP).read_text()) != expected:
            raise ValueError("Runtime is stale or incomplete; rebuild scripts/build-video.sh")
        subprocess.run(["python3", str(repo / "aaf-sidecar/verify_runtime.py"), str(root)], check=True)
        subprocess.run([str(root / "saucebunny-video"), "--version"], check=True)
    print(f"Video runtime {args.mode}: current recipe, {len(entries)} payload entries, macOS 14 floor")


if __name__ == "__main__":
    main()
