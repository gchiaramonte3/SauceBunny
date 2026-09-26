"""Small offline checks for the feasibility harness, not model-accuracy tests."""
import io
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

import numpy as np

from probe import audio_windows, musical_control, WINDOW_SAMPLES


class Child:
    def __init__(self, output, status=0, running=False):
        self.stdout = io.BytesIO(output)
        self.status = status
        self.running = running
        self.terminated = False
        self.killed = False
        self.waits = []

    def poll(self):
        return None if self.running else self.status

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True
        self.running = False

    def wait(self, timeout=None):
        self.waits.append(timeout)
        if self.running and timeout:
            raise subprocess.TimeoutExpired("test-ffmpeg", timeout)
        self.running = False
        return self.status


class ProbeTests(unittest.TestCase):
    def test_generated_control_is_deterministic_finite_and_bounded(self):
        first = musical_control()
        np.testing.assert_array_equal(first, musical_control())
        self.assertEqual(len(first), WINDOW_SAMPLES)
        self.assertTrue(np.isfinite(first).all())
        self.assertGreater(np.max(np.abs(first)), 0)
        self.assertLessEqual(np.max(np.abs(first)), 1)

    def test_pcm_windows_preserve_all_samples_and_partial_tail(self):
        audio = np.arange(WINDOW_SAMPLES + 13, dtype="<f4")
        child = Child(audio.tobytes())
        with patch("probe.subprocess.Popen", return_value=child) as spawn:
            windows = list(audio_windows(Path("fixture.wav"), Path("ffmpeg")))
        self.assertEqual([index for index, _ in windows], [0, 1])
        np.testing.assert_array_equal(np.concatenate([data for _, data in windows]), audio)
        self.assertTrue(child.stdout.closed)
        self.assertIn("file", spawn.call_args.args[0])

    def test_partial_sample_fails_instead_of_truncating(self):
        child = Child(b"\x00\x00\x00")
        with patch("probe.subprocess.Popen", return_value=child):
            with self.assertRaisesRegex(ValueError, "Incomplete PCM"):
                list(audio_windows(Path("fixture.wav"), Path("ffmpeg")))
        self.assertTrue(child.stdout.closed)

    def test_sixteen_khz_windows_keep_the_same_duration_and_request_real_resampling(self):
        audio = np.arange(160_000 + 13, dtype="<f4")
        child = Child(audio.tobytes())
        with patch("probe.subprocess.Popen", return_value=child) as spawn:
            windows = list(audio_windows(Path("fixture.wav"), Path("ffmpeg"), sample_rate=16_000))
        self.assertEqual([len(data) for _, data in windows], [160_000, 13])
        np.testing.assert_array_equal(np.concatenate([data for _, data in windows]), audio)
        command = spawn.call_args.args[0]
        self.assertEqual(command[command.index("-ar") + 1], "16000")

    def test_nonzero_child_exit_is_not_success(self):
        child = Child(b"", status=1)
        with patch("probe.subprocess.Popen", return_value=child):
            with self.assertRaises(RuntimeError):
                list(audio_windows(Path("fixture.wav"), Path("ffmpeg")))
        self.assertTrue(child.stdout.closed)

    def test_closing_generator_reaps_an_uncooperative_child(self):
        child = Child(np.zeros(WINDOW_SAMPLES, dtype="<f4").tobytes(), running=True)
        with patch("probe.subprocess.Popen", return_value=child):
            windows = audio_windows(Path("fixture.wav"), Path("ffmpeg"))
            next(windows)
            windows.close()
        self.assertTrue(child.terminated)
        self.assertTrue(child.killed)
        self.assertEqual(len(child.waits), 2)
        self.assertIsNone(child.waits[-1])
        self.assertTrue(child.stdout.closed)


if __name__ == "__main__":
    unittest.main()
