"""Owned music-evidence lifecycle; synthetic video, no weights or network."""
from pathlib import Path
import base64
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np

from audio_pcm import AudioWindow
from index_store import source_identity
from music_analysis import analyze_music, CLASSIFIER, PREPROCESSING
from shot_analysis import inspect_source
from test_worker import make_video


class MusicAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "source.mp4"
        make_video(self.path)
        source = inspect_source(self.path)["analysis_source"]
        self.request = {"source_sha256": source["sha256"], "analysis_id": "a" * 64,
            "origin_us": source["origin_us"], "duration_us": source["duration_us"], "audio_track_index": 0}
        self.engine = Mock(labels={"0": "Music", "1": "Speech"})
        self.engine.classify.return_value = [{"label": "Music", "score": .6}, {"label": "Speech", "score": .3}]
        self.factory = Mock(return_value=self.engine)

    def fake_audio(self, rows):
        audio = Mock(stream=SimpleNamespace(), maximum_retained_samples=160000)
        audio.windows.return_value = (row for row in rows)
        return audio

    def row(self, value=.1, samples=16000, start=0):
        return AudioWindow(start, start + round(samples * 1e6 / 16000), np.full(samples, value, dtype=np.float32))

    def test_real_video_without_audio_never_loads_the_classifier(self):
        packets = []
        analyze_music(self.path, self.request, self.factory, packets.append)
        self.factory.assert_not_called()
        self.assertEqual(len(packets), 1)
        self.assertEqual(packets[0]["type"], "complete")
        self.assertEqual(packets[0]["status"], "no-audio")

    def test_silence_and_subframe_tail_are_not_forced_into_music_labels(self):
        packets = []
        audio = self.fake_audio([self.row(value=0), self.row(samples=399, start=1_000_000)])
        with patch("music_analysis.Audio", return_value=audio):
            analyze_music(self.path, self.request, self.factory, packets.append)
        self.factory.assert_not_called()
        self.assertEqual([p["status"] for p in packets], ["digital-silence", "insufficient-context", "decoded"])
        self.assertTrue(all(p["scores_f32le"] == "" for p in packets[:2]))
        self.assertEqual(packets[-1]["labels"], [])
        audio.close.assert_called_once()

    def test_evidence_keeps_actual_ranges_and_one_owned_model(self):
        packets = []
        audio = self.fake_audio([self.row(), self.row(start=1_000_000)])
        with patch("music_analysis.Audio", return_value=audio):
            analyze_music(self.path, self.request, self.factory, packets.append)
        self.factory.assert_called_once()
        self.engine.close.assert_called_once()
        audio.close.assert_called_once()
        self.assertEqual([(p["start_us"], p["end_us"]) for p in packets[:-1]], [(0, 1_000_000), (1_000_000, 2_000_000)])
        self.assertEqual(packets[-1]["classifier"], CLASSIFIER)
        self.assertEqual(packets[-1]["preprocessing_version"], PREPROCESSING)
        self.assertEqual(packets[-1]["source_sha256"], self.request["source_sha256"])
        self.assertEqual(packets[-1]["analysis_id"], self.request["analysis_id"])
        self.assertEqual(packets[-1]["windows"], 2)
        self.assertEqual(packets[-1]["labels"], ["Music", "Speech"])
        scores = np.frombuffer(base64.b64decode(packets[0]["scores_f32le"]), dtype="<f4")
        np.testing.assert_array_equal(scores, np.array([.6, .3], dtype=np.float32))

    def test_reordered_scores_use_the_shared_vocabulary_order(self):
        self.engine.classify.return_value.reverse()
        packets = []
        with patch("music_analysis.Audio", return_value=self.fake_audio([self.row()])):
            analyze_music(self.path, self.request, self.factory, packets.append)
        scores = np.frombuffer(base64.b64decode(packets[0]["scores_f32le"]), dtype="<f4")
        np.testing.assert_array_equal(scores, np.array([.6, .3], dtype=np.float32))

    def test_cleanup_failure_cannot_publish_completion(self):
        self.engine.close.side_effect = RuntimeError("model cleanup failed")
        packets = []
        with patch("music_analysis.Audio", return_value=self.fake_audio([self.row()])), self.assertRaisesRegex(RuntimeError, "cleanup"):
            analyze_music(self.path, self.request, self.factory, packets.append)
        self.assertEqual([p["type"] for p in packets], ["window"])

    def test_bad_identity_or_video_timing_is_rejected_before_loading(self):
        for changes in [{"source_sha256": "b" * 64}, {"analysis_id": "invalid"},
                        {"origin_us": 1}, {"duration_us": 100}, {"duration_us": True},
                        {"audio_track_index": -1}, {"origin_us": float("nan")}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                analyze_music(self.path, {**self.request, **changes}, self.factory, Mock())
        self.factory.assert_not_called()

    def test_stop_or_inference_failure_closes_every_owner_without_completion(self):
        for error in [KeyboardInterrupt(), RuntimeError("inference failed")]:
            self.engine.reset_mock()
            self.engine.classify.side_effect = [self.engine.classify.return_value, error]
            packets = []
            audio = self.fake_audio([self.row(), self.row(start=1_000_000)])
            with patch("music_analysis.Audio", return_value=audio), self.assertRaises(type(error)):
                analyze_music(self.path, self.request, self.factory, packets.append)
            self.assertEqual([p["type"] for p in packets], ["window"])
            self.engine.close.assert_called_once()
            audio.close.assert_called_once()
            self.assertIsNone(audio.windows.return_value.gi_frame)

    def test_bad_score_or_label_does_not_publish_evidence(self):
        for scores in [[{"label": "Music", "score": float("nan")}, {"label": "Speech", "score": .3}],
                       [{"label": "Music", "score": 1.1}, {"label": "Speech", "score": .3}],
                       [{"label": "Other", "score": .5}, {"label": "Speech", "score": .3}], []]:
            self.engine.classify.return_value = scores
            packets = []
            with patch("music_analysis.Audio", return_value=self.fake_audio([self.row()])), self.assertRaises(ValueError):
                analyze_music(self.path, self.request, self.factory, packets.append)
            self.assertEqual(packets, [])

    def test_source_change_during_inference_discards_completion(self):
        def change_source(_):
            self.path.write_bytes(b"replaced source")
            return [{"label": "Music", "score": .6}, {"label": "Speech", "score": .3}]
        self.engine.classify.side_effect = change_source
        packets = []
        with patch("music_analysis.Audio", return_value=self.fake_audio([self.row()])), self.assertRaisesRegex(ValueError, "changed"):
            analyze_music(self.path, self.request, self.factory, packets.append)
        self.assertEqual(packets, [])
        self.engine.close.assert_called_once()

    def test_final_hash_rejects_same_stat_content_replacement(self):
        source = source_identity(self.path)
        audio = self.fake_audio([self.row()])
        packets = []
        with patch("music_analysis.Audio", return_value=audio), \
                patch("music_analysis.source_identity", side_effect=[source, {**source, "sha256": "b" * 64}]), \
                self.assertRaisesRegex(ValueError, "changed"):
            analyze_music(self.path, self.request, self.factory, packets.append)
        self.assertEqual([p["type"] for p in packets], ["window"])
        self.engine.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
