"""Display transforms: exact pixels plus opt-in real FFmpeg/PyAV/proxy checks."""
import contextlib
import os
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from PIL import Image

from media import Video, display_image, display_transform
from scene_proxy import prepare_proxy


class Matrix:
    type = SimpleNamespace(name="DISPLAYMATRIX")

    def __init__(self, values):
        self.values = values

    def __bytes__(self):
        return struct.pack("=9i", *self.values)


class DisplayTransformTests(unittest.TestCase):
    def test_unsupported_geometry_fails_instead_of_silently_showing_coded_pixels(self):
        for values in [(32768, 0, 0, 0, 65536, 0, 0, 0, 1 << 30),
                       (65536, 0, 1, 0, 65536, 0, 0, 0, 1 << 30)]:
            with self.subTest(values=values), self.assertRaisesRegex(ValueError, "display transform"):
                display_transform(SimpleNamespace(side_data=[Matrix(values)]))

    def test_identity_and_missing_matrix_do_not_change_pixels(self):
        image = Image.new("RGB", (96, 64), "red")
        for side_data in [[], [Matrix((65536, 0, 0, 0, 65536, 0, 0, 0, 1 << 30))]]:
            frame = SimpleNamespace(side_data=side_data, to_image=lambda: image)
            self.assertIsNone(display_transform(frame))
            self.assertEqual(display_image(frame).tobytes(), image.tobytes())


@unittest.skipUnless(os.environ.get("VIDEO_TEST_H264_PROXY") == "1", "Opt in to real macOS proxy orientation tests")
class RealOrientationTests(unittest.TestCase):
    def test_all_eight_orientations_match_ffmpeg_and_keep_every_source_pts(self):
        import av
        import numpy as np

        ffmpeg = os.environ.get("VIDEO_TEST_FFMPEG", str(Path(__file__).resolve().parents[1]
                            / "src-tauri/binaries/ffmpeg-aarch64-apple-darwin"))

        def run(*args):
            return subprocess.check_output([ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", *map(str, args)])

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            base = root / "pattern.mp4"
            run("-f", "lavfi", "-i", "testsrc2=size=96x64:rate=24:duration=1", "-c:v", "mpeg4", "-q:v", "2", base)
            for angle in (0, 90, 180, 270):
                for mirror in (0, 1):
                    with self.subTest(angle=angle, mirror=mirror):
                        path = root / f"orientation-{angle}-{mirror}.mp4"
                        flip = ("-display_hflip:v:0",) if mirror else ()
                        run("-display_rotation:v:0", angle, *flip, "-i", base, "-c", "copy", path)
                        original = path.read_bytes()
                        dimensions = (64, 96) if angle % 180 else (96, 64)
                        expected = np.frombuffer(run("-i", path, "-frames:v", "1", "-f", "rawvideo",
                                                     "-pix_fmt", "rgb24", "pipe:1"), dtype=np.uint8)
                        expected = expected.reshape(dimensions[1], dimensions[0], 3).astype(float)
                        with contextlib.closing(Video(path)) as video:
                            frames, _ = video.sample(0, .5)
                            self.assertEqual(frames[0].size, dimensions)
                            self.assertLess(np.abs(np.asarray(frames[0], dtype=float) - expected).mean(), 2)
                            frames, _ = video.sample_shot(0, 1_000_000)
                            self.assertEqual(frames[0].size, dimensions)
                            self.assertLess(np.abs(np.asarray(frames[0], dtype=float) - expected).mean(), 2)
                        result = prepare_proxy(root / "derived", path, Mock())["scene_proxy"]
                        self.assertEqual(result["frame_count"], 24)
                        with av.open(result["path"]) as proxy:
                            frame = next(proxy.decode(video=0))
                            self.assertEqual((frame.width, frame.height), dimensions)
                            self.assertEqual(frame.rotation, 0)  # Already baked, never double-rotated.
                            self.assertLess(np.abs(frame.to_ndarray(format="rgb24").astype(float) - expected).mean(), 8)
                        self.assertEqual(path.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
