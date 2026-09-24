"""Read bounded MXF header identities only. Never decode or modify essence.

FFmpeg's MXF demuxer assigns AVStream.id from the MaterialPackage track ID.
Resolve that track's SourceClip to its SourcePackage/slot instead of assuming
that a source slot equals an FFmpeg stream index. The native caller then uses
ffprobe's i:<track-id> stream selector and validates the actual decoded format.
"""
from pathlib import Path
import json
import queue
import sys
import threading
import time
from aaf2 import mxf
from reader import fail, fingerprint, ReaderError

SOUND_DEFS = {'DataDef_Sound', 'DataDef_LegacySound'}


class Header(mxf.MXFFile):
    def __init__(self, path):
        self.objects, self.local_tags = {}, {}
        self.preface = self.header_partition_size = self.header_operation_pattern = None
        self.path, self.ama, self.aaf = str(path), False, None
        size = path.stat().st_size
        with path.open('rb') as stream:
            for count, (key, length) in enumerate(mxf.iter_kl(stream)):
                raw = key.bytes_be
                # Stop before any essence or body/footer partition is read.
                if raw[:13] == bytes.fromhex('060e2b34020501010d01020101') and raw[13] in (3, 4):
                    break
                if raw[:12] == bytes.fromhex('060e2b34010201010d010301'):
                    break
                if count >= 20000 or stream.tell() > 64*1024*1024 or length > 4*1024*1024 or stream.tell()+length > size:
                    fail('MXF header exceeds safe inspection limits.', 'invalid_media')
                if key == mxf.AUID('060e2b34-0205-0101-0d01-020101050100'):
                    self.local_tags = self.read_primer(stream, length)
                elif raw[:13] == bytes.fromhex('060e2b34020501010d01020101') and raw[13] == 2:
                    self.read_header(stream, length)
                else:
                    obj = self.read_object(stream, key, length)
                    if obj:
                        obj.root = self
                        self.objects[obj.instance_id] = obj
                    if isinstance(obj, mxf.MXFPreface):
                        self.preface = obj
        if not self.preface:
            fail('MXF header has no readable package metadata.', 'invalid_media')


def inspect(path):
    path = Path(path)
    before = fingerprint(path)
    header = Header(path)
    packages = list(header.packages())
    materials = [p for p in packages if isinstance(p, mxf.MXFMaterialPackage)]
    if len(materials) != 1:
        fail('MXF must contain one unambiguous material package.', 'unsupported_media')
    tracks = []
    for track in materials[0].iter_strong_refs('Slots'):
        segment = track.resolve_ref('Segment')
        if segment.data.get('DataDef') not in SOUND_DEFS:
            continue
        children = list(segment.iter_strong_refs('Components')) if isinstance(segment, mxf.MXFSequence) else [segment]
        if len(children) != 1 or not isinstance(children[0], mxf.MXFSourceClip):
            fail('MXF audio track contains unsupported nested edits.', 'unsupported_media')
        clip = children[0]
        mob_id, slot_id = clip.data['SourceID'], clip.data['SourceMobSlotID']
        sources = [p for p in packages if isinstance(p, mxf.MXFSourcePackage) and p.mob_id == mob_id]
        if len(sources) != 1:
            fail('MXF audio source package is missing or ambiguous.', 'invalid_media')
        slots = [s for s in sources[0].iter_strong_refs('Slots') if s.data.get('SlotID') == slot_id]
        if len(slots) != 1 or slots[0].resolve_ref('Segment').data.get('DataDef') not in SOUND_DEFS:
            fail('MXF audio source slot is missing or ambiguous.', 'invalid_media')
        # Nonzero material/source origins need an additional time transform.
        # Do not apply an AAF offset to a different MXF time origin silently.
        aligned = not any((track.data.get('Origin', 0), slots[0].data.get('Origin', 0), clip.data.get('StartTime', 0)))
        tracks.append({'material_track_id': track.data['SlotID'], 'mob_id': str(mob_id),
                       'slot_id': slot_id, 'aligned': aligned})
    if len(tracks) > 256:
        fail('MXF exceeds 256 audio streams.', 'limit_exceeded')
    if not tracks:
        fail('MXF header has no recognized audio source mappings. The media is not confirmed to be a wrong recording; export diagnostics for this file.', 'unsupported_media')
    if fingerprint(path) != before:
        fail('MXF changed during inspection.', 'source_changed')
    return {'path': str(path), 'fingerprint': before, 'tracks': tracks}


def inspect_many(paths):
    if not 1 <= len(paths) <= 256:
        fail('Inspect at most 256 MXFs per batch.', 'limit_exceeded')
    tasks, finished = queue.Queue(), queue.Queue()
    stopped, output_lock = threading.Event(), threading.Lock()
    for index, path in enumerate(paths):
        tasks.put((index, path))

    def report(path, phase, **details):
        with output_lock:
            print('AAF_MXF_EVENT ' + json.dumps({'path': str(path), 'phase': phase, **details}), file=sys.stderr, flush=True)

    def worker():
        while not stopped.is_set():
            try:
                index, path = tasks.get_nowait()
            except queue.Empty:
                return
            started = time.monotonic()
            report(path, 'start')
            try:
                result = inspect(path)
            except ReaderError as error:
                if error.code == 'cancelled':
                    stopped.set()
                    finished.put((index, error))
                    return
                result = {'path': path, 'error': str(error)}
            except Exception:
                result = {'path': path, 'error': 'MXF header could not be read safely.'}
            report(path, 'finish', elapsed_ms=round((time.monotonic()-started)*1000),
                   tracks=len(result.get('tracks', [])), error=result.get('error'))
            finished.put((index, result))

    # Header I/O overlaps at most two files. Daemon workers let SIGTERM unwind
    # the main reader immediately even if a disconnected mount blocks a read.
    # No worker writes media/cache files; the native owner commits results.
    results = [None] * len(paths)
    for _ in range(min(2, len(paths))):
        threading.Thread(target=worker, daemon=True).start()
    try:
        for _ in paths:
            index, result = finished.get()
            if isinstance(result, ReaderError):
                raise result
            results[index] = result
    finally:
        stopped.set()
    return {'schema_version': 1, 'files': results}
