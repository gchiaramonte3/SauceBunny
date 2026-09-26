"""AST trust-boundary tests; no weights, network, GPU or inference dependencies."""
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

import numpy as np

from audio_ast import AudioSpectrogramClassifier, FRAME_SAMPLES, WINDOW_SAMPLES, prepare_features, MODEL_ID, MODEL_REVISION, FILES
from artifacts import model_spec


class AudioAstTests(unittest.TestCase):
    def test_download_catalog_matches_the_exact_adapter_artifacts(self):
        spec = model_spec(MODEL_ID)
        self.assertEqual(spec["revision"], MODEL_REVISION)
        self.assertEqual(spec["role"], "audio")
        self.assertEqual(spec["bytes"], sum(item["bytes"] for item in spec["files"]))
        self.assertEqual({item["name"]: item["sha256"] for item in spec["files"] if item["name"] in FILES}, FILES)

    def test_invalid_pcm_is_rejected_before_loading_inference_dependencies(self):
        invalid = [np.zeros(FRAME_SAMPLES - 1), np.zeros(WINDOW_SAMPLES + 1),
                   np.zeros((2, FRAME_SAMPLES)), np.full(FRAME_SAMPLES, np.nan),
                   np.full(FRAME_SAMPLES, np.inf)]
        with patch.dict(sys.modules, {"transformers.audio_utils": None}):
            for pcm in invalid:
                with self.subTest(shape=pcm.shape), self.assertRaisesRegex(ValueError, "finite mono"):
                    prepare_features(pcm, {})

    def test_bad_checkpoint_is_rejected_before_loading_mlx(self):
        with patch.dict(sys.modules, {"mlx.core": None}):
            with patch.object(Path, "open", return_value=io.BytesIO(b"wrong checkpoint")):
                with self.assertRaisesRegex(ValueError, "Unreviewed AST artifact: model.safetensors"):
                    AudioSpectrogramClassifier(Path("unreviewed-model"))

    def test_invalid_features_cannot_reach_model_operations(self):
        classifier = AudioSpectrogramClassifier.__new__(AudioSpectrogramClassifier)
        classifier.mx = None
        classifier.prefix = "unused"
        classifier.config = {"max_length": 1024, "num_mel_bins": 128}
        for features in [np.zeros((2, 1024, 128)), np.zeros((1, 128, 1024)),
                         np.full((1, 1024, 128), np.nan)]:
            with self.assertRaisesRegex(ValueError, "finite, normalized spectrogram"):
                classifier.logits(features)

    def test_scores_are_independent_and_numerically_stable(self):
        classifier = AudioSpectrogramClassifier.__new__(AudioSpectrogramClassifier)
        classifier.preprocessing = {}
        classifier.labels = {"0": "low", "1": "middle", "2": "high"}
        with patch("audio_ast.prepare_features", return_value=np.zeros((1, 1024, 128))):
            with patch.object(classifier, "logits", return_value=np.array([[-1000., 0., 1000.]])):
                with np.errstate(over="raise", invalid="raise"):
                    scores = classifier.classify(np.zeros(FRAME_SAMPLES))
        self.assertEqual(scores, [{"label": "low", "score": 0.0},
                                 {"label": "middle", "score": 0.5},
                                 {"label": "high", "score": 1.0}])


if __name__ == "__main__":
    unittest.main()
