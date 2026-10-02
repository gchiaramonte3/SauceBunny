"""Real codec fixtures are opt-in; generation never ships an external encoder."""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

import av
from media import Video


class DecoderTests(unittest.TestCase):
    def test_decode_failure_names_source_codec_and_stage(self):
        video = Video.__new__(Video)
        video.path = Path('/fixtures/Camera take.mts')
        video.stream = Mock()
        video.stream.codec_context.name = 'h264'
        video.container = Mock()
        video.container.decode.side_effect = av.error.NotImplementedError(78, 'avcodec_send_packet()')
        with self.assertRaisesRegex(ValueError, r'Source: Camera take.mts. Codec: h264. Stage: decoder preflight'):
            next(video.frames('decoder preflight'))

    @unittest.skipUnless(os.environ.get('VIDEO_CODEC_FIXTURE_FFMPEG'), 'Set a test-only encoder for AV1/AVC/AVCHD fixtures')
    def test_software_av1_and_avc_avchd_keep_original_frame_timing(self):
        with tempfile.TemporaryDirectory() as folder:
            for name, codec, extra in [('software-av1.mp4', 'libsvtav1', ['-preset', '13', '-svtav1-params', 'lp=2']),
                                      ('avc.mp4', 'libx264', ['-preset', 'ultrafast']),
                                      ('avchd.mts', 'libx264', ['-preset', 'ultrafast', '-mpegts_m2ts_mode', '1'])]:
                with self.subTest(codec=name):
                    path = Path(folder) / name
                    subprocess.run([os.environ['VIDEO_CODEC_FIXTURE_FFMPEG'], '-v', 'error', '-f', 'lavfi',
                                    '-i', 'testsrc2=size=96x64:rate=24000/1001', '-frames:v', '48',
                                    '-c:v', codec, *extra, '-threads', '2', str(path)], check=True)
                    video = Video(path)
                    try:
                        if codec == 'libsvtav1': self.assertEqual(video.stream.codec_context.name, 'libdav1d')
                        video.preflight()
                        pts = [float(frame.pts * frame.time_base) - video.origin for frame in video.frames()]
                        self.assertEqual(len(pts), 48)
                        self.assertAlmostEqual(pts[0], 0, places=5)
                        for index, timestamp in enumerate(pts):
                            self.assertAlmostEqual(timestamp, index * 1001 / 24000, places=4)
                    finally:
                        video.close()
