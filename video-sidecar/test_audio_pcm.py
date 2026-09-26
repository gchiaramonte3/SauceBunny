"""Real resampling with synthetic packets; no media library, weights or device."""
import contextlib
from fractions import Fraction
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import av
import numpy as np

from audio_pcm import Audio, WindowBuffer
from audio_ast import SAMPLE_RATE, WINDOW_SAMPLES


def frame(start, samples=1024, rate=44100, channels=2, value=.25):
    result = av.AudioFrame.from_ndarray(np.full((channels, samples), value, dtype=np.float32),
        format="fltp", layout="stereo" if channels == 2 else "mono")
    result.sample_rate = rate
    result.time_base = Fraction(1, rate)
    result.pts = start
    return result


class AudioPcmTests(unittest.TestCase):
    def decode(self, frames, origin=0, duration=60_000_000, streams=1, track_index=0):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        path = Path(temp.name) / "source.wav"
        path.write_bytes(b"fixture")
        tracks = [SimpleNamespace(thread_count=0) for _ in range(streams)]
        container = Mock(streams=SimpleNamespace(audio=tracks))
        container.decode.return_value = iter(frames)
        with patch("av.open", return_value=container), contextlib.closing(Audio(path, track_index, origin, duration)) as audio:
            with contextlib.closing(audio.windows()) as windows:
                result = list(windows)
        container.close.assert_called_once()
        return result, audio, container

    def test_real_resampling_is_bounded_and_carries_an_unpadded_tail(self):
        total = 44100 * 23 + 321
        frames = (frame(i, min(1024, total - i)) for i in range(0, total, 1024))
        rows, audio, _ = self.decode(frames)
        self.assertEqual([row.start_us for row in rows], [0, 10_000_000, 20_000_000])
        self.assertEqual([len(row.pcm) for row in rows[:2]], [WINDOW_SAMPLES] * 2)
        self.assertEqual(sum(len(row.pcm) for row in rows), total * SAMPLE_RATE // 44100)
        self.assertLessEqual(audio.maximum_retained_samples, WINDOW_SAMPLES)
        # Match libswresample's standard equal-power stereo-to-mono matrix.
        self.assertTrue(all(np.allclose(row.pcm, .25 * 2 ** .5, atol=1e-5) for row in rows))

    def test_nonzero_origin_fractional_pts_and_clip_edges_round_only_once(self):
        rate = 44100
        anchor = 147001
        origin = round(Fraction(anchor, rate) * 1_000_000) + 3000
        rows, _, _ = self.decode([frame(anchor, rate * 2)], origin=origin, duration=1_000_017)
        self.assertEqual(len(rows), 1)
        self.assertTrue(0 <= rows[0].start_us <= 63)
        self.assertTrue(1_000_017 - 63 <= rows[0].end_us <= 1_000_017)
        self.assertEqual(rows[0].end_us - rows[0].start_us, round(len(rows[0].pcm) * 1_000_000 / SAMPLE_RATE))

    def test_gap_flushes_both_resampler_and_window_instead_of_joining_regions(self):
        rows, _, _ = self.decode([frame(0, 44100), frame(44100 * 3, 44100)])
        self.assertEqual([(r.start_us, r.end_us) for r in rows], [(0, 1_000_000), (3_000_000, 4_000_000)])

    def test_single_sample_gap_at_exact_rate_is_not_hidden_as_rounding(self):
        rows, _, _ = self.decode([frame(0, 1600, rate=16000, channels=1),
                                  frame(1601, 1600, rate=16000, channels=1)])
        self.assertEqual([(r.start_us, r.end_us) for r in rows], [(0, 100_000), (100_062, 200_062)])

    def test_coarse_packet_timestamps_do_not_accumulate_rounding_drift(self):
        def frames(anchor_ms):
            for index in range(1000):
                packet = frame(index * 1024)
                packet.time_base = Fraction(1, 1000)
                packet.pts = anchor_ms + round(Fraction(index * 1024, 44100) * 1000)
                yield packet
        for anchor_ms in [0, 3333]:
            with self.subTest(anchor_ms=anchor_ms):
                rows, _, _ = self.decode(frames(anchor_ms), origin=anchor_ms * 1000)
                self.assertEqual([r.start_us for r in rows], [0, 10_000_000, 20_000_000])
                expected = (1000 * 1024 * SAMPLE_RATE // 44100) * Fraction(1_000_000, SAMPLE_RATE)
                self.assertEqual(rows[-1].end_us, round(expected))

    def test_coarse_timestamps_still_preserve_real_gaps_and_reject_overlaps(self):
        for second_ms in [105, 95]:
            packets = [frame(0, 4410), frame(0, 4410)]
            for packet, pts in zip(packets, [0, second_ms]):
                packet.time_base, packet.pts = Fraction(1, 1000), pts
            if second_ms < 100:
                with self.assertRaisesRegex(ValueError, "overlap"):
                    self.decode(packets)
            else:
                rows, _, _ = self.decode(packets)
                self.assertEqual([(r.start_us, r.end_us) for r in rows], [(0, 100_000), (105_000, 205_000)])

    def test_decoding_stops_at_video_end_without_reading_unrelated_audio_tail(self):
        def frames():
            yield frame(0, 44100)
            yield frame(44100, 44100)
            raise AssertionError("Decoded past the requested video range")
        rows, _, _ = self.decode(frames(), duration=1_000_000)
        self.assertEqual(rows[0].end_us, 1_000_000)

    def test_changing_sample_format_starts_a_new_resampling_region(self):
        rows, _, _ = self.decode([frame(0, 44100), frame(48000, 48000, rate=48000)])
        self.assertEqual([(r.start_us, r.end_us) for r in rows], [(0, 1_000_000), (1_000_000, 2_000_000)])

    def test_no_audio_is_distinct_from_an_invalid_track(self):
        rows, audio, _ = self.decode([], streams=0)
        self.assertEqual(rows, [])
        self.assertIsNone(audio.stream)
        with self.assertRaisesRegex(ValueError, "selected audio track"):
            self.decode([], streams=1, track_index=1)

    def test_selected_audio_stream_is_the_only_one_decoded(self):
        _, _, container = self.decode([frame(0)], streams=2, track_index=1)
        container.decode.assert_called_once_with(container.streams.audio[1])

    def test_malformed_timestamps_overlap_and_nonfinite_audio_fail_loudly(self):
        missing = frame(0)
        missing.pts = None
        for frames in [[missing], [frame(0), frame(100)], [frame(0, value=float("nan"))]]:
            with self.subTest(frames=frames), self.assertRaises(ValueError):
                self.decode(frames)

    def test_no_padding_for_audio_outside_requested_source_range(self):
        rows, _, _ = self.decode([frame(0, 44100), frame(44100 * 4, 44100)],
                                  origin=2_000_000, duration=1_000_000)
        self.assertEqual(rows, [])

    def test_window_results_do_not_alias_reused_storage(self):
        buffer = WindowBuffer(Fraction(0), Fraction(30))
        first = list(buffer.append(np.ones(WINDOW_SAMPLES), Fraction(0)))[0]
        second = list(buffer.append(np.zeros(WINDOW_SAMPLES), Fraction(10)))[0]
        self.assertTrue(np.all(first.pcm == 1))
        self.assertTrue(np.all(second.pcm == 0))
        self.assertEqual(buffer.maximum_retained_samples, WINDOW_SAMPLES)

    @unittest.skipUnless(os.environ.get("AUDIO_TEST_FFMPEG"), "Needs explicitly supplied real FFmpeg")
    def test_real_aac_edit_list_nonzero_origin_and_gap(self):
        with tempfile.TemporaryDirectory() as directory:
            for gap in [False, True]:
                path = Path(directory) / ("gap.mov" if gap else "offset.mov")
                audio_filter = "aselect=between(t\\,0\\,2)+between(t\\,4\\,6)," if gap else ""
                subprocess.run([os.environ["AUDIO_TEST_FFMPEG"], "-nostdin", "-v", "error",
                    "-f", "lavfi", "-i", "color=s=64x64:r=24:d=8",
                    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=8",
                    "-filter_complex", f"[0:v]setpts=PTS+3/TB[v];[1:a]{audio_filter}asetpts=PTS+3/TB[a]",
                    "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-threads:v", "1",
                    "-c:a", "aac", "-avoid_negative_ts", "disabled", str(path)],
                    check=True, capture_output=True, timeout=30)
                with contextlib.closing(Audio(path, 0, 3_000_000, 8_000_000)) as audio:
                    rows = list(audio.windows())
                self.assertTrue(rows)
                self.assertTrue(0 <= rows[0].start_us <= 63)
                if gap:
                    self.assertEqual(len(rows), 2)
                    self.assertLess(rows[0].end_us, 2_100_000)
                    self.assertTrue(3_900_000 <= rows[1].start_us <= 4_100_000)
                    self.assertTrue(5_900_000 <= rows[1].end_us <= 6_100_000)
                else:
                    self.assertEqual(len(rows), 1)
                    self.assertTrue(7_999_000 <= rows[0].end_us <= 8_000_000)


if __name__ == "__main__":
    unittest.main()
