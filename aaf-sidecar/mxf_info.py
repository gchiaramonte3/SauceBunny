"""Read bounded MXF header identities only. Never decode or modify essence.

FFmpeg's MXF demuxer assigns AVStream.id from the MaterialPackage track ID.
Resolve that track's SourceClip to its SourcePackage/slot instead of assuming
that a source slot equals an FFmpeg stream index. The native caller then uses
ffprobe's i:<track-id> stream selector and validates the actual decoded format.
"""
from pathlib import Path
from aaf2 import mxf
from reader import fail, fingerprint, ReaderError


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
        if segment.data.get('DataDef') != 'DataDef_Sound':
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
        if len(slots) != 1 or slots[0].resolve_ref('Segment').data.get('DataDef') != 'DataDef_Sound':
            fail('MXF audio source slot is missing or ambiguous.', 'invalid_media')
        # Nonzero material/source origins need an additional time transform.
        # Do not apply an AAF offset to a different MXF time origin silently.
        aligned = not any((track.data.get('Origin', 0), slots[0].data.get('Origin', 0), clip.data.get('StartTime', 0)))
        tracks.append({'material_track_id': track.data['SlotID'], 'mob_id': str(mob_id),
                       'slot_id': slot_id, 'aligned': aligned})
    if len(tracks) > 256:
        fail('MXF exceeds 256 audio streams.', 'limit_exceeded')
    if fingerprint(path) != before:
        fail('MXF changed during inspection.', 'source_changed')
    return {'path': str(path), 'fingerprint': before, 'tracks': tracks}


def inspect_many(paths):
    if not 1 <= len(paths) <= 256:
        fail('Inspect at most 256 MXFs per batch.', 'limit_exceeded')
    results = []
    for path in paths:
        try:
            results.append(inspect(path))
        except ReaderError as error:
            if error.code == 'cancelled':
                raise
            results.append({'path': path, 'error': str(error)})
        except Exception:
            # Third-party header parsing can raise generic exceptions for bad
            # strong references. Never expose tracebacks or accept partial data.
            results.append({'path': path, 'error': 'MXF header could not be read safely.'})
    return {'schema_version': 1, 'files': results}
