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
import tempfile
from aaf2.auid import AUID
from mxf_info import inspect
from test_mxf import generate

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


if __name__ == '__main__':
    main()
