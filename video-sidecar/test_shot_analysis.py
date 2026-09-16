"""Shot analysis contracts: real local decoding, fake inference, no model download."""
import contextlib
import copy
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from index_store import source_identity
from media import Video
from shot_analysis import analyze_shots, inspect_source, validate_shots
from test_worker import make_video
from worker import dispatch


def request_for(path):
    return {"operation": "analyze-shots", "path": str(path), "analysis_id": "a" * 64,
            "source_sha256": source_identity(path)["sha256"], "query": "Describe each shot.",
            "shots": [{"id": 1, "start_us": 0, "end_us": 1_000_000, "transcript": "A supplied line."},
                      {"id": 2, "start_us": 1_000_000, "end_us": 2_000_000, "transcript": ""}]}


class ShotAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "shots.mp4"
        make_video(self.path)
        self.request = request_for(self.path)

    def test_validation_preserves_supplied_shots_and_rejects_malformed_ranges(self):
        self.assertEqual(validate_shots(self.request), self.request["shots"])
        cases = [
            {"analysis_id": "not-a-hash"}, {"source_sha256": "A" * 64}, {"query": ""}, {"shots": []},
            {"shots": self.request["shots"] * 33},
        ]
        for changes in [{"id": True}, {"id": 0}, {"start_us": .5}, {"start_us": -1},
                        {"end_us": float("nan")}, {"end_us": 0}, {"end_us": 86_400_000_001},
                        {"transcript": "🔊" * 3001}, {"unexpected": "field"}]:
            cases.append({"shots": [{**self.request["shots"][0], **changes}]})
        cases.append({"shots": [self.request["shots"][0], {**self.request["shots"][1], "id": 1}]})
        cases.append({"shots": [self.request["shots"][0], {**self.request["shots"][1], "start_us": 999_999}]})
        for changes in cases:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate_shots({**self.request, **changes})

    def test_real_decode_samples_actual_pts_only_inside_each_shot(self):
        with contextlib.closing(Video(self.path)) as video:
            for start, end in [(0, 1_000_000), (1_000_000, 2_000_000), (1_960_000, 2_000_000)]:
                frames, pts = video.sample_shot(start, end)
                self.assertTrue(1 <= len(frames) <= 8)
                self.assertEqual(len(frames), len(pts))
                self.assertEqual(pts, sorted(set(pts)))
                self.assertTrue(all(start <= timestamp < end for timestamp in pts))
                self.assertTrue(all(max(frame.size) <= 384 for frame in frames))
                self.assertTrue(all(timestamp in {round(Fraction(index * 1001, 24000) * 1_000_000)
                                                for index in range(48)} for timestamp in pts))
            _, pts = video.sample_shot(1_000_000, 2_000_000)
            self.assertEqual(pts[0], 1_001_000)  # actual next frame, not the requested timestamp
            with self.assertRaisesRegex(ValueError, "No decoded frame"):
                video.sample_shot(1, 2)  # never borrow a neighbour for an empty subframe range

    def test_long_shot_evidence_spans_the_shot_without_loading_every_frame(self):
        make_video(self.path, seconds=20)
        with contextlib.closing(Video(self.path)) as video:
            frames, pts = video.sample_shot(0, 20_000_000)
        self.assertEqual(len(frames), 8)
        self.assertGreaterEqual(pts[-1], 17_500_000)
        self.assertLess(pts[-1], 20_000_000)

    def test_nonzero_origin_uses_rational_pts_until_final_microsecond_rounding(self):
        from PIL import Image

        time_base = Fraction(1, 6_000_000)
        stream = SimpleNamespace(start_time=20_000_000, time_base=time_base, duration=6_000_000)
        frame = SimpleNamespace(pts=20_250_005, time_base=time_base,
                                to_image=lambda: Image.new("RGB", (16, 16)))
        container = Mock(streams=SimpleNamespace(video=[stream]))
        container.decode.side_effect = lambda *_: iter([frame])
        with patch("av.open", return_value=container), contextlib.closing(Video(self.path)) as video:
            _, pts = video.sample_shot(0, 200_000)
        self.assertEqual(pts, [41_668])  # 41667.5 us rounds once, not through float subtraction
        container.close.assert_called_once()

    def test_analysis_preserves_boundaries_and_separates_transcript_from_audio(self):
        original = copy.deepcopy(self.request)
        engine = Mock()
        engine.reason.return_value = "A visible red frame."
        factory, progress = Mock(return_value=engine), Mock()
        response = analyze_shots(self.path, self.request, factory, progress)["shot_analysis"]
        self.assertEqual(self.request, original)
        self.assertFalse(response["audio_analyzed"])
        self.assertEqual(response["source"]["sha256"], self.request["source_sha256"])
        self.assertEqual(response["analysis_id"], self.request["analysis_id"])
        self.assertEqual(response["model_id"], "qwen3.5-9b-video")
        self.assertTrue(response["model_revision"])
        self.assertEqual(response["sampling_version"], "shot-spread-8frames-384-v1")
        for supplied, answer, call in zip(self.request["shots"], response["shots"], engine.reason.call_args_list):
            self.assertEqual({key: answer[key] for key in supplied}, supplied)
            self.assertEqual(call.args[3], supplied["transcript"])
            self.assertEqual(call.kwargs, {"visual_only": True})
            self.assertTrue(all(supplied["start_us"] <= pts < supplied["end_us"] for pts in answer["frame_pts_us"]))
        factory.assert_called_once()
        engine.close.assert_called_once()
        self.assertEqual(progress.call_args.args, ("analyzing-shots", 2, 2))

    def test_changed_source_and_out_of_duration_shots_never_load_the_model(self):
        for request in [{**self.request, "source_sha256": "b" * 64},
                        {**self.request, "shots": [{**self.request["shots"][0], "end_us": 3_000_000}]}]:
            factory = Mock()
            with self.subTest(request=request), self.assertRaises(ValueError):
                analyze_shots(self.path, request, factory, Mock())
            factory.assert_not_called()

    def test_model_failure_and_cancellation_close_decoder_and_engine_without_partial_success(self):
        for error in [RuntimeError("decode inference failed"), KeyboardInterrupt()]:
            engine = Mock()
            engine.reason.side_effect = ["first shot", error]
            videos = []

            def tracked_video(path):
                video = Video(path)
                video.close = Mock(wraps=video.close)
                videos.append(video)
                return video

            with patch("shot_analysis.Video", side_effect=tracked_video), self.assertRaises(type(error)):
                analyze_shots(self.path, self.request, lambda: engine, Mock())
            engine.close.assert_called_once()
            videos[0].close.assert_called_once()

    def test_changed_source_during_inference_is_not_published(self):
        engine = Mock()
        engine.reason.return_value = "not current"
        with patch("shot_analysis.source_unchanged", side_effect=[True, False]), self.assertRaisesRegex(ValueError, "changed"):
            analyze_shots(self.path, self.request, lambda: engine, Mock())
        engine.close.assert_called_once()

    def test_empty_or_oversized_model_answers_are_not_accepted(self):
        for text in [None, "  ", "a" * 16001, "🔊" * 4001]:
            engine = Mock()
            engine.reason.return_value = text
            with self.subTest(text_length=len(text or "")), self.assertRaisesRegex(ValueError, "empty or oversized"):
                analyze_shots(self.path, self.request, lambda: engine, Mock())
            engine.close.assert_called_once()

    def test_shot_dispatch_does_not_require_or_create_an_embedding_index(self):
        engine = Mock()
        engine.reason.return_value = "A visible frame."
        root = self.path.parent / "derived"
        with patch("worker.IndexStore", side_effect=AssertionError("Index must not open")), \
                patch("worker.load_model", return_value=engine) as load, patch("worker.progress"):
            source = dispatch(root, {"operation": "inspect-video", "path": str(self.path)})
            load.assert_not_called()
            self.assertEqual(source, inspect_source(self.path))
            response = dispatch(root, self.request)
            self.assertEqual(len(response["shot_analysis"]["shots"]), 2)
            self.assertEqual(load.call_args.args[1], "qwen3.5-9b-video")
        self.assertFalse(root.exists())


if __name__ == "__main__":
    unittest.main()
