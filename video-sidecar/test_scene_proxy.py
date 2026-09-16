"""Proxy lifecycle tests; optional real Apple H.264 encoder test is explicit."""
import hashlib
import os
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from scene_proxy import TimingEvidence, prepare_proxy, proxy_dimensions, verify_proxy
from test_worker import make_video


class SceneProxyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / "original.mp4"
        make_video(self.path)
        self.derived = self.root / "derived"

    def test_timing_digest_matches_wire_int64_little_endian(self):
        timing = TimingEvidence()
        for pts in (0, 41668, 83417):
            timing.add(pts)
        self.assertEqual(timing.signature(), (3, hashlib.sha256(struct.pack("<qqq", 0, 41668, 83417)).hexdigest()))
        for pts in (83417, 0, -1, 12.5):
            with self.assertRaises(ValueError):
                timing.add(pts)
        with self.assertRaisesRegex(ValueError, "edit list"):
            TimingEvidence().add(1)
        with self.assertRaisesRegex(ValueError, "No presentation"):
            TimingEvidence().signature()

    def test_proxy_is_bounded_and_does_not_upscale(self):
        for width, height, expected in [(1920, 1080, (960, 540)), (1080, 1920, (302, 540)),
                                       (640, 360, (640, 360)), (4096, 2160, (960, 506))]:
            self.assertEqual(proxy_dimensions(width, height), expected)

    def fake_encode(self, source, output, progress):
        output.write_bytes(b"owned fake proxy")
        timing = TimingEvidence()
        timing.add(0); timing.add(41668)
        return {"path": source["path"], "sha256": source["sha256"], "duration_us": 83417, "origin_us": 0}, timing

    def test_only_verified_complete_proxies_are_published_and_reused(self):
        before = self.path.read_bytes()
        with patch("scene_proxy.encode_proxy", side_effect=self.fake_encode) as encode, \
                patch("scene_proxy.verify_proxy") as verify:
            first = prepare_proxy(self.derived, self.path, Mock())["scene_proxy"]
            second = prepare_proxy(self.derived, self.path, Mock())["scene_proxy"]
        encode.assert_called_once(); verify.assert_called_once()
        self.assertEqual(first, second)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(first["frame_count"], 2)
        self.assertTrue(Path(first["path"]).is_file())
        self.assertTrue(Path(first["path"]).with_name("manifest.json").is_file())
        self.assertEqual(first["time_map"], [{"analysis_start_us": 0, "analysis_end_us": 83417,
                                             "source_start_us": 0, "source_end_us": 83417}])

    def test_failed_or_cancelled_verification_never_publishes_a_proxy(self):
        for failure in [ValueError("retimed frame"), KeyboardInterrupt()]:
            with patch("scene_proxy.encode_proxy", side_effect=self.fake_encode), \
                    patch("scene_proxy.verify_proxy", side_effect=failure), self.assertRaises(type(failure)):
                prepare_proxy(self.derived, self.path, Mock())
            self.assertEqual(list((self.derived / "scene-proxies").iterdir()), [])

    def test_changed_source_and_changed_cached_proxy_are_rejected(self):
        with patch("scene_proxy.encode_proxy", side_effect=self.fake_encode), patch("scene_proxy.verify_proxy"), \
                patch("scene_proxy.source_unchanged", return_value=False), self.assertRaisesRegex(ValueError, "changed"):
            prepare_proxy(self.derived, self.path, Mock())
        with patch("scene_proxy.encode_proxy", side_effect=self.fake_encode), patch("scene_proxy.verify_proxy"):
            result = prepare_proxy(self.derived, self.path, Mock())["scene_proxy"]
        Path(result["path"]).write_bytes(b"replaced proxy")
        with self.assertRaisesRegex(ValueError, "saved analysis proxy changed"):
            prepare_proxy(self.derived, self.path, Mock())

    def test_non_h264_proxy_is_rejected_in_real_decoder(self):
        expected = TimingEvidence(); expected.add(0)
        with self.assertRaisesRegex(ValueError, "H.264"):
            verify_proxy(self.path, expected)

    @unittest.skipUnless(os.environ.get("VIDEO_TEST_H264_PROXY") == "1", "Opt in to the actual macOS H.264 encoder")
    def test_actual_fractional_rate_encoder_preserves_all_source_frames(self):
        # make_video is 24000/1001 fps, not integer 24.
        result = prepare_proxy(self.derived, self.path, Mock())["scene_proxy"]
        self.assertEqual(result["frame_count"], 48)
        self.assertEqual(prepare_proxy(self.derived, self.path, Mock())["scene_proxy"], result)

    @unittest.skipUnless(os.environ.get("VIDEO_TEST_H264_PROXY") == "1", "Opt in to the actual macOS H.264 encoder")
    def test_actual_vfr_and_nonzero_origin_preserve_the_source_relative_clock(self):
        import av
        from fractions import Fraction
        from PIL import Image
        path = self.root / "offset-vfr.mp4"
        offsets = [0, 1001, 2002, 4004, 5005, 8008]
        base = Fraction(1, 30000)
        with av.open(str(path), "w") as container:
            stream = container.add_stream("mpeg4", rate=Fraction(30000, 1001))
            stream.width, stream.height, stream.pix_fmt = 64, 64, "yuv420p"
            stream.time_base = stream.codec_context.time_base = base
            for offset in offsets:
                frame = av.VideoFrame.from_image(Image.new("RGB", (64, 64), "blue"))
                frame.pts, frame.time_base = 90000 + offset, base
                for packet in stream.encode(frame):
                    container.mux(packet)
            for packet in stream.encode():
                container.mux(packet)
        result = prepare_proxy(self.derived, path, Mock())["scene_proxy"]
        expected = TimingEvidence()
        for offset in offsets:
            expected.add(round(offset * base * 1_000_000))
        self.assertEqual(result["source"]["origin_us"], 3_000_000)
        self.assertEqual((result["frame_count"], result["pts_sha256"]), expected.signature())


if __name__ == "__main__":
    unittest.main()
