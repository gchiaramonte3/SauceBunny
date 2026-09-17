"""Durable segment truth, independent of the replaceable HNSW search cache.

No media writes, pickle files or model-generated timestamps. Each segment is an
atomic checkpoint. Model/sampling changes create a different index generation.
"""
from __future__ import annotations

import array
import hashlib
import json
import math
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

SCHEMA_VERSION = 1
DIMENSIONS = 2048
MAX_SEGMENTS = 100_000  # Under 1 GB of float32 vectors; bound HNSW memory too.
SAMPLING_VERSION = "windows-8s-step-6s-1fps-384-display-v2"


def source_identity(path: Path) -> dict:
    path = path.resolve(strict=True)
    before = path.stat()
    if not path.is_file():
        raise ValueError("Choose a local video file")
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError("The source changed while it was being read. Try again.")
    return {"path": str(path), "sha256": digest.hexdigest(),
            "bytes": after.st_size, "mtime_ns": after.st_mtime_ns}


def source_unchanged(source: dict) -> bool:
    try:
        stat = Path(source["path"]).stat()
        return stat.st_size == source["bytes"] and stat.st_mtime_ns == source["mtime_ns"]
    except OSError:
        return False


def vector_bytes(values: list[float]) -> bytes:
    if len(values) != DIMENSIONS or any(not math.isfinite(v) for v in values):
        raise ValueError("Invalid visual embedding")
    norm = math.sqrt(sum(v * v for v in values))
    if norm < 1e-12:
        raise ValueError("The visual embedding was empty")
    packed = array.array("f", (v / norm for v in values))
    if packed.itemsize != 4:
        raise ValueError("Unsupported vector format")
    return packed.tobytes()


class IndexStore:
    def __init__(self, root: Path):
        root.mkdir(parents=True, exist_ok=True)
        self.root = root
        self.db = sqlite3.connect(root / "segments.sqlite", timeout=5)
        self.db.row_factory = sqlite3.Row
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        if version not in (0, SCHEMA_VERSION):
            self.db.close()
            raise ValueError("This video index needs a newer Sauce Bunny version")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS sources (
            key TEXT PRIMARY KEY, path TEXT NOT NULL, sha256 TEXT NOT NULL,
            bytes INTEGER NOT NULL, mtime_ns INTEGER NOT NULL,
            duration REAL NOT NULL, model TEXT NOT NULL, sampling TEXT NOT NULL,
            complete INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS segments (
            id INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT NOT NULL
            REFERENCES sources(key) ON DELETE CASCADE, ordinal INTEGER NOT NULL,
            start REAL NOT NULL, end REAL NOT NULL, frames TEXT NOT NULL,
            vector BLOB NOT NULL, UNIQUE(source_key, ordinal));
          CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
          INSERT OR IGNORE INTO state VALUES (1, 0);
        """)
        self.db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        self.db.commit()

    def close(self):
        self.db.close()

    @contextmanager
    def transaction(self):
        try:
            self.db.execute("BEGIN IMMEDIATE")
            yield
            self.db.execute("UPDATE state SET revision=revision+1 WHERE id=1")
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise

    def begin_source(self, source: dict, duration: float, model: str) -> str:
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError("The video has no playable duration")
        key = hashlib.sha256(f"{source['path']}:{source['sha256']}:{model}:{SAMPLING_VERSION}".encode()).hexdigest()
        with self.transaction():
            # Identical copies keep distinct selectable identities. A changed
            # source at the same path must not return its old moments.
            self.db.execute("DELETE FROM sources WHERE path=? AND key<>?", (source["path"], key))
            self.db.execute("""INSERT INTO sources
                (key,path,sha256,bytes,mtime_ns,duration,model,sampling) VALUES (?,?,?,?,?,?,?,?)
                ON CONFLICT(key) DO UPDATE SET path=excluded.path, bytes=excluded.bytes,
                mtime_ns=excluded.mtime_ns""", (key, source["path"], source["sha256"],
                source["bytes"], source["mtime_ns"], duration, model, SAMPLING_VERSION))
        return key

    def ordinals(self, key: str) -> set[int]:
        return {row[0] for row in self.db.execute("SELECT ordinal FROM segments WHERE source_key=?", (key,))}

    def save_segment(self, key: str, ordinal: int, start: float, end: float,
                     frames: list[float], vector: list[float]):
        source = self.db.execute("SELECT * FROM sources WHERE key=?", (key,)).fetchone()
        if not source or not source_unchanged(dict(source)):
            raise ValueError("The source changed. Reindex it before continuing.")
        if (ordinal < 0 or not all(math.isfinite(t) for t in [start, end, *frames])
                or not 0 <= start < end <= source["duration"] + 0.001
                or not frames or frames != sorted(set(frames))
                or any(t < start or t >= end for t in frames)):
            raise ValueError("Invalid decoded segment timing")
        packed = vector_bytes(vector)
        with self.transaction():
            existing = self.db.execute("SELECT 1 FROM segments WHERE source_key=? AND ordinal=?", (key, ordinal)).fetchone()
            if not existing and self.db.execute("SELECT count(*) FROM segments").fetchone()[0] >= MAX_SEGMENTS:
                raise ValueError("The local video index is full. Remove an older index before adding more videos.")
            self.db.execute("""INSERT INTO segments(source_key,ordinal,start,end,frames,vector)
                VALUES (?,?,?,?,?,?) ON CONFLICT(source_key,ordinal) DO UPDATE SET
                start=excluded.start,end=excluded.end,frames=excluded.frames,vector=excluded.vector""",
                (key, ordinal, start, end, json.dumps(frames), packed))

    def finish_source(self, key: str, expected: int):
        if self.ordinals(key) != set(range(expected)):
            raise ValueError("Video indexing is not complete")
        source = self.db.execute("SELECT * FROM sources WHERE key=?", (key,)).fetchone()
        if not source or not source_unchanged(dict(source)):
            raise ValueError("The source changed before indexing finished")
        with self.transaction():
            self.db.execute("UPDATE sources SET complete=1 WHERE key=?", (key,))

    def sources(self) -> list[dict]:
        rows = self.db.execute("""SELECT sources.*, count(segments.id) AS segments
            FROM sources LEFT JOIN segments ON segments.source_key=sources.key GROUP BY sources.key""")
        return [{**dict(row), "available": row["sampling"] == SAMPLING_VERSION and source_unchanged(dict(row))} for row in rows]

    def forget(self, key: str):
        # Only the derived index is removed. Source media is never deleted.
        with self.transaction():
            self.db.execute("DELETE FROM sources WHERE key=?", (key,))

    def _search_index(self, model: str):
        import numpy as np
        from usearch.index import Index

        if self.db.execute("SELECT count(*) FROM segments").fetchone()[0] > MAX_SEGMENTS:
            raise ValueError("This video index exceeds the local memory budget. Remove an older index first.")

        revision = self.db.execute("SELECT revision FROM state WHERE id=1").fetchone()[0]
        model_key = hashlib.sha256(model.encode()).hexdigest()[:24]
        path = self.root / f"{model_key}.usearch"
        stamp = self.root / f"{model_key}.revision"
        expected = f"{SCHEMA_VERSION}:{revision}:{DIMENSIONS}:{SAMPLING_VERSION}"
        try:
            if path.is_file() and stamp.is_file() and stamp.read_text() == expected:
                restored = Index.restore(str(path), view=True)
                if restored is not None:
                    return restored
        except (OSError, RuntimeError, ValueError):
            pass  # Derived cache corruption never destroys durable vectors.
        index = Index(ndim=DIMENSIONS, metric="cos", dtype="f32", connectivity=16)
        rows = self.db.execute("""SELECT segments.id,vector FROM segments JOIN sources
            ON sources.key=source_key WHERE model=? AND sampling=? ORDER BY segments.id""", (model, SAMPLING_VERSION))
        while batch := rows.fetchmany(128):
            keys = np.asarray([row["id"] for row in batch], dtype=np.uint64)
            vectors = np.stack([np.frombuffer(row["vector"], dtype=np.float32) for row in batch])
            index.add(keys, vectors, threads=1)
        temporary = path.with_suffix(".partial")
        index.save(str(temporary))
        os.replace(temporary, path)
        temporary_stamp = stamp.with_suffix(".partial-revision")
        temporary_stamp.write_text(expected)
        os.replace(temporary_stamp, stamp)
        return index

    def search(self, vector: list[float], model: str, scope: list[str], limit: int = 12) -> list[dict]:
        import numpy as np

        if not scope or not 1 <= limit <= 50:
            raise ValueError("Choose indexed sources to search")
        index = self._search_index(model)
        query = np.frombuffer(vector_bytes(vector), dtype=np.float32)
        sources = {s["key"]: s for s in self.sources() if s["available"] and s["key"] in scope and s["model"] == model}
        # Expand candidates until the requested scope has enough hits. A small
        # chosen folder must not lose results to a larger unselected library.
        count = min(len(index), max(limit * 4, 64))
        while count:
            hits = []
            for match in index.search(query, count=count, threads=1):
                row = self.db.execute("SELECT * FROM segments WHERE id=?", (int(match.key),)).fetchone()
                if row and row["source_key"] in sources:
                    source = sources[row["source_key"]]
                    hits.append({"id": row["id"], "source_key": row["source_key"], "path": source["path"],
                                 "start": row["start"], "end": row["end"], "frames": json.loads(row["frames"]),
                                 "score": max(-1.0, min(1.0, 1 - float(match.distance)))})
            if len(hits) >= limit or count == len(index):
                return hits[:limit]
            count = min(len(index), count * 2)
        return []
