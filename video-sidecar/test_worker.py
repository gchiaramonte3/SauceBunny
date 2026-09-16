"""No model weights/network/GPU required. Real PyAV and HNSW where relevant."""
import contextlib
import hashlib
import io
import json
import math
import os
import shutil
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path
from unittest.mock import patch

import artifacts
from index_store import DIMENSIONS, IndexStore, source_identity, vector_bytes
from inference import video_tokens
from media import Video, windows
from worker import dispatch
from runtime_manifest import audit_native, inventory, recipe


def vector(axis=0):
    result = [0.] * DIMENSIONS
    result[axis] = 1.
    return result


def make_video(path, seconds=2, fps=Fraction(24000, 1001)):
    import av
    from PIL import Image

    with av.open(str(path), "w") as container:
        stream = container.add_stream("mpeg4", rate=fps)
        stream.width, stream.height, stream.pix_fmt = 64, 64, "yuv420p"
        for index in range(math.ceil(float(fps) * seconds)):
            image = Image.new("RGB", (64, 64), "red" if index < float(fps) else "blue")
            for packet in stream.encode(av.VideoFrame.from_image(image)):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)


class RuntimeTests(unittest.TestCase):
    def test_tauri_resource_copy_preserves_inventory(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "runtime"
            root.mkdir()
            (root / "payload").write_bytes(b"same payload")
            (root / "alias").symlink_to("payload")
            copied = Path(folder) / "copied"
            shutil.copytree(root, copied, symlinks=False)
            self.assertEqual(inventory(root), inventory(copied))

    def test_inventory_tracks_payload_and_rejects_external_links(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "payload").write_bytes(b"first")
            first = inventory(root)
            (root / "payload").write_bytes(b"second")
            self.assertNotEqual(first, inventory(root))
            (root / "outside").symlink_to("/usr/bin/true")
            with self.assertRaisesRegex(ValueError, "External or broken"):
                inventory(root)

    def test_os_floor_rejects_newer_native_wheels(self):
        native = {"libmlx.dylib": {"native": True}}
        with patch("runtime_manifest.subprocess.check_output", return_value="minos 26.2\n"):
            with self.assertRaisesRegex(ValueError, "macOS 14"):
                audit_native(Path("/fixture"), native)
        with patch("runtime_manifest.subprocess.check_output", return_value="minos 14.0\n"):
            audit_native(Path("/fixture"), native)

    def test_build_recipe_contains_worker_manifest_and_lock(self):
        files = recipe(Path(__file__).resolve().parent.parent)
        for name in ("video-sidecar/worker.py", "video-sidecar/inference.py", "video-sidecar/models.json",
                     "video-sidecar/requirements-build.txt", "scripts/build-video.sh"):
            self.assertIn(name, files)


class IndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / "source.mp4"
        self.path.write_bytes(b"fixture")
        self.store = IndexStore(self.root / "index")
        self.addCleanup(self.store.close)

    def source(self, path=None, model="test"):
        return self.store.begin_source(source_identity(path or self.path), 14, model)

    def test_index_memory_ceiling_keeps_existing_checkpoints(self):
        key = self.source()
        with patch("index_store.MAX_SEGMENTS", 1):
            self.store.save_segment(key, 0, 0, 8, [0, 1], vector())
            with self.assertRaisesRegex(ValueError, "index is full"):
                self.store.save_segment(key, 1, 6, 14, [6, 7], vector())
            self.assertEqual(self.store.ordinals(key), {0})
            # Replacing the same checkpoint does not consume a second slot.
            self.store.save_segment(key, 0, 0, 8, [0, 1], vector(1))

    def test_checkpoint_resume_without_duplicates(self):
        key = self.source()
        self.store.save_segment(key, 0, 0, 8, [0, 1, 2], vector())
        self.assertEqual(self.source(), key)
        self.assertEqual(self.store.ordinals(key), {0})
        self.store.save_segment(key, 0, 0, 8, [0, 1, 2], vector())
        self.assertEqual(self.store.sources()[0]["segments"], 1)
        with self.assertRaises(ValueError):
            self.store.finish_source(key, 2)
        self.store.save_segment(key, 1, 6, 14, [6, 7, 8], vector(1))
        self.store.finish_source(key, 2)
        self.assertEqual(self.store.sources()[0]["complete"], 1)

    def test_transaction_rollback_survives_cancel(self):
        key = self.source()
        with self.assertRaises(KeyboardInterrupt):
            with self.store.transaction():
                self.store.db.execute("DELETE FROM sources WHERE key=?", (key,))
                raise KeyboardInterrupt()
        self.assertEqual(len(self.store.sources()), 1)

    def test_changed_file_invalidates_old_results(self):
        key = self.source()
        self.store.save_segment(key, 0, 0, 8, [0], vector())
        self.path.write_bytes(b"different")
        self.assertFalse(self.store.sources()[0]["available"])
        with self.assertRaises(ValueError):
            self.store.save_segment(key, 1, 6, 14, [6], vector())
        self.assertEqual(self.store.search(vector(), "test", [key]), [])
        self.assertNotEqual(self.source(), key)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM segments").fetchone()[0], 0)

    def test_identical_files_remain_separately_scoped(self):
        first = self.source()
        copy = self.root / "copy.mp4"
        copy.write_bytes(self.path.read_bytes())
        second = self.source(copy)
        self.assertNotEqual(first, second)
        for key in [first, second]:
            self.store.save_segment(key, 0, 0, 8, [0], vector())
        hits = self.store.search(vector(), "test", [second])
        self.assertEqual([hit["path"] for hit in hits], [str(copy.resolve())])

    def test_search_scope_and_cache_recovery(self):
        key = self.source()
        self.store.save_segment(key, 0, 0, 8, [0], vector())
        self.assertEqual(len(self.store.search(vector(), "test", [key])), 1)
        cache = next((self.root / "index").glob("*.usearch"))
        cache.write_bytes(b"broken cache")
        self.assertEqual(len(self.store.search(vector(), "test", [key])), 1)
        self.assertEqual(self.store.search(vector(), "other model", [key]), [])
        with self.assertRaises(ValueError):
            self.store.search(vector(), "test", [])

    def test_forget_only_removes_derived_data(self):
        key = self.source()
        self.store.save_segment(key, 0, 0, 8, [0], vector())
        self.store.forget(key)
        self.assertTrue(self.path.exists())
        self.assertEqual(self.store.search(vector(), "test", [key]), [])

    def test_validation_rejects_invalid_vectors_and_times(self):
        key = self.source()
        for values in [[], [0.] * DIMENSIONS, [float("nan")] * DIMENSIONS]:
            with self.assertRaises(ValueError):
                vector_bytes(values)
        for frames in [[], [1, 0], [8], [float("nan")]]:
            with self.assertRaises(ValueError):
                self.store.save_segment(key, 0, 0, 8, frames, vector())


class MediaTests(unittest.TestCase):
    def test_window_bounds_and_eof(self):
        self.assertEqual(windows(.25), [(0, .25)])
        self.assertEqual(windows(14), [(0, 8), (6, 14)])
        for duration in [0, float("nan"), 86401]:
            with self.assertRaises(ValueError):
                windows(duration)

    def test_fractional_rate_decoded_timestamps(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "colors.mp4"
            make_video(path)
            with contextlib.closing(Video(path)) as video:
                frames, timestamps = video.sample(0, video.duration)
                self.assertEqual(len(frames), 2)
                self.assertAlmostEqual(timestamps[1], 1.001, places=3)
                self.assertGreater(frames[0].getpixel((0, 0))[0], 240)
                self.assertGreater(frames[1].getpixel((0, 0))[2], 240)
                last, times = video.sample(video.duration - .05, video.duration)
                self.assertEqual(len(last), 1)
                self.assertLess(times[0], video.duration)

    def test_temporal_patches_use_actual_pts_and_pad_last(self):
        rendered = video_tokens([1, 2.04, 3.11], [2, 4, 4])
        self.assertIn("<1.520 seconds>", rendered)
        self.assertIn("<3.110 seconds>", rendered)
        self.assertEqual(rendered.count("<|video_pad|>"), 8)
        with self.assertRaises(ValueError):
            video_tokens([0, 0], [1, 4, 4])


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.spec = {"id": "test", "name": "Test", "role": "embedding", "repo": "example/model",
            "revision": "abc", "total_bytes": 4, "files": [{"name": "config.json", "bytes": 4,
            "sha256": hashlib.sha256(b"true").hexdigest()}]}
        self.patch = patch.dict(artifacts.MODELS, {"test": self.spec})
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def response(self, data):
        response = io.BytesIO(data)
        response.status, response.url = 200, "https://huggingface.co/file"
        return response

    def test_download_verifies_then_publishes(self):
        with patch("urllib.request.urlopen", return_value=self.response(b"true")):
            artifacts.download(self.root, "test", lambda *args: None)
        self.assertTrue(artifacts.ready(self.root, "test"))
        directory = artifacts.require_model(self.root, "test")
        (directory / "config.json").write_bytes(b"fail")
        self.assertFalse(artifacts.ready(self.root, "test"))

    def test_failed_integrity_never_becomes_ready(self):
        with patch("urllib.request.urlopen", return_value=self.response(b"fail")):
            with self.assertRaises(ValueError):
                artifacts.download(self.root, "test", lambda *args: None)
        self.assertFalse(artifacts.ready(self.root, "test"))

    def test_rejects_unknown_model_and_remote_media(self):
        with self.assertRaises(ValueError):
            artifacts.model_spec("../../elsewhere")
        with self.assertRaises(ValueError):
            dispatch(self.root, {"operation": "index", "paths": ["https://example.com/file.mp4"]})


if __name__ == "__main__":
    unittest.main()
