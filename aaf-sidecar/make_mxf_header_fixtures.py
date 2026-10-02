"""Write the header-only MXF fixtures the native Rust reader is tested against.

Each fixture is the first 8 KiB of an FFmpeg-generated MXF: the partition pack
and complete header metadata, without the essence. `expected.json` records what
this sidecar's full pyaaf2 parser (`mxf_info.inspect`) reports for the complete
file, so the Rust tests compare against the reference parser rather than a
hand-typed answer. Run from aaf-sidecar with the test venv:

    ../node_modules/.cache/aaf-tests/bin/python make_mxf_header_fixtures.py
"""
from pathlib import Path
import json
import subprocess
import tempfile
from aaf2.auid import AUID
from mxf_info import inspect
from reader import ReaderError
from test_mxf import FFMPEG, FFPROBE, generate

OUT = Path(__file__).resolve().parent.parent / 'src-tauri/src/commands/aaf/fixtures'
HEAD = 8192


def encoded(value):
    raw = AUID(value).bytes_be
    return raw[8:] + raw[:8]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    expected = {}
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        for name, atom in (('opatom', True), ('op1a', False)):
            generate(root / f'{name}.mxf', atom=atom)
        legacy = (root / 'opatom.mxf').read_bytes().replace(
            encoded('01030202-0200-0000-060e-2b3404010101'), encoded('78e1ebe1-6cef-11d2-807d-006008143e6f'))
        (root / 'legacy.mxf').write_bytes(legacy)
        for name in ('opatom', 'op1a', 'legacy'):
            path = root / f'{name}.mxf'
            (OUT / f'{name}.mxf-head').write_bytes(path.read_bytes()[:HEAD])
            expected[name] = inspect(path)['tracks']
    (OUT / 'expected.json').write_text(json.dumps(expected, indent=2, sort_keys=True) + '\n')
    pictures()


def pictures():
    """DNxHD picture fixtures with a start timecode: a picture-only OP-Atom at
    23.976 and an OP1a at 29.97 drop-frame with one PCM track.
    `picture-expected.json` records the reference parser's audio identities
    (or its error, for the picture-only file) and what ffprobe reports for the
    complete file, so the picture facts are pinned against an independent reader."""
    expected = {}
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        runs = {
            'picture-opatom': ['-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=24000/1001', '-t', '1', '-c:v', 'dnxhd', '-b:v', '36M',
                               '-pix_fmt', 'yuv422p', '-timecode', '01:00:00:00', '-f', 'mxf_opatom'],
            'picture-op1a': ['-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30000/1001', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
                             '-t', '1', '-map', '0:v', '-map', '1:a', '-c:v', 'dnxhd', '-b:v', '45M', '-pix_fmt', 'yuv422p', '-c:a', 'pcm_s24le',
                             '-timecode', '00:59:59;28', '-f', 'mxf'],
        }
        for name, args in runs.items():
            path = root / f'{name}.mxf'
            subprocess.run([str(FFMPEG), '-nostdin', '-v', 'error', *args, str(path)], check=True, capture_output=True)
            (OUT / f'{name}.mxf-head').write_bytes(path.read_bytes()[:HEAD])
            try:
                tracks = inspect(path)['tracks']
            except ReaderError as error:
                tracks = str(error)
            probe = json.loads(subprocess.run([str(FFPROBE), '-v', 'error', '-select_streams', 'v:0', '-show_streams', '-show_format',
                                               '-of', 'json', str(path)], check=True, capture_output=True, text=True).stdout)
            video = probe['streams'][0]
            expected[name] = {'tracks': tracks, 'width': video['width'], 'height': video['height'], 'r_frame_rate': video['r_frame_rate'],
                              'nb_frames': int(video.get('nb_frames') or video.get('duration_ts')),
                              'timecode': video.get('tags', {}).get('timecode') or probe['format'].get('tags', {}).get('timecode')}
    (OUT / 'picture-expected.json').write_text(json.dumps(expected, indent=2, sort_keys=True) + '\n')


if __name__ == '__main__':
    main()
