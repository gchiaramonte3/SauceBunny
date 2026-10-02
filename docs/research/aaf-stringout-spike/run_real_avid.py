"""Approaches B and C on REAL Media Composer exports (OTIO + LibAAF sample AAFs, MC 8.6 - 23.12).

These carry Avid-private metadata (MobAttributeList trees, Audio Pan with Avid* parameters,
Pulldown/EdgeCode tracks, marker attributes). For each file: pick the first audio track's first
MasterMob clip, cut a range inside it, write the string-out, and verify every frame resolves to the
same source sample through the repo's GraphTimeline. Also deep-compare the copied mobs.
Run with PYTHONPATH=<repo>/aaf-sidecar PYTHONDONTWRITEBYTECODE=1.
"""
from fractions import Fraction
from pathlib import Path
import json
import sys

import aaf2
from aaf2.components import SourceClip, Sequence, OperationGroup, Selector

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / 'tools'))
from write_stringout import Cut, write_stringout  # noqa: E402
import verify_stringout as V  # noqa: E402
from deep_compare import same  # noqa: E402

FILES = [HERE / 'otio-repo/tests/sample_data' / n for n in ('one_audio_clip.aaf', 'multitrack.aaf', 'test_muted_clip.aaf')]
FILES += [HERE / 'refs/LibAAF/test/aaf' / n for n in ('MC_Markers.aaf', 'MC_TC_23.976.aaf', 'MC_TC_29.97_DF.aaf',
                                                      'MC_Audio_Pan.aaf', 'MC_Fades.aaf', 'MC_Audio_Levels.aaf',
                                                      'MC_Audio_Warp.aaf', 'MC_Metadata.aaf', 'MC_Track_Solo_Mute.aaf')]


def first_master_clip(seg, at=0):
    """(sequence frame, SourceClip -> MasterMob) of the first real clip under seg."""
    if isinstance(seg, SourceClip):
        return (at, seg) if isinstance(seg.mob, aaf2.mobs.MasterMob) else None
    if isinstance(seg, OperationGroup):
        for inp in seg['InputSegments'].value:
            hit = first_master_clip(inp, at)
            if hit:
                return hit
    if isinstance(seg, Selector):
        return first_master_clip(seg['Selected'].value, at)
    if isinstance(seg, Sequence):
        for child in seg.components:
            hit = first_master_clip(child, at)
            if hit:
                return hit
            at += child.length
    return None


def main():
    results = {}
    for path in FILES:
        name = path.name
        try:
            with aaf2.open(str(path)) as f:
                seq = next(f.content.toplevel())
                seq_id = str(seq.mob_id)
                product = [i['ProductName'].value for i in f.header['IdentificationList'].value][-1]
                hit = None
                for slot in seq.slots:
                    if slot.segment.media_kind.lower() == 'sound':
                        hit = first_master_clip(slot.segment)
                        if hit:
                            root = slot.slot_id
                            break
                if not hit:
                    results[name] = {'skipped': 'no audio clip'}
                    continue
                at, clip = hit
                length = max(1, min(24, clip.length // 3))          # middle third: clear of head/tail fades
                start = at + (clip.length - length) // 2
                cut = Cut(person='SPEAKER', root_slot=root, master_id=str(clip.mob_id), master_slot=clip.slot_id,
                          seq_in=start, seq_out=start + length, text='real Avid file')
            try:
                original = V.manifest(path, seq_id)
            except TypeError as error:
                results[name] = {'product': product, 'reader_cannot_open_original': str(error)}
                original = None
            row = results.get(name, {'product': product})
            for approach in 'BC':
                out = HERE / 'out' / 'real' / f'{path.stem}_{approach}.aaf'
                out.parent.mkdir(parents=True, exist_ok=True)
                if out.exists():
                    out.unlink()
                report = write_stringout(path, out, seq_id, [cut], approach)
                m = V.manifest(out, report['sequence_id'])
                track = next(t for t in m['tracks'] if t['id'] == str(report['tracks']['SPEAKER']))
                bad = None
                if original:
                    spf = Fraction(48000) / Fraction(original['edit_rate']['numerator'], original['edit_rate']['denominator'])
                    bad = 0
                    for frame in range(cut.seq_in, cut.seq_out):
                        want = V.expected_for(original, cut.__dict__, spf, frame)
                        got = V.clip_at(track, frame - cut.seq_in)
                        if not got or (got.get('source_id'), V.position(got, frame - cut.seq_in, spf)) != want[:2]:
                            bad += 1
                with aaf2.open(str(path)) as s, aaf2.open(str(out)) as o:
                    top = {str(t.mob_id) for t in o.content.toplevel()}
                    diffs = sum(len(same(s.content.mobs.get(mm.mob_id), mm)) for mm in o.content.mobs if str(mm.mob_id) not in top)
                    essence = len(list(o.content.essencedata))
                row[approach] = {'frames': cut.seq_out - cut.seq_in, 'mismatched': bad, 'mobs_copied': report['copied_mobs'],
                                 'mob_differences': diffs, 'essence_data': essence, 'bytes': out.stat().st_size,
                                 'warnings': m['warnings'], 'writer_warnings': report['warnings']}
            results[name] = row
        except Exception as error:  # report, do not hide
            results[name] = {'error': f'{type(error).__name__}: {error}'}
    print(json.dumps(results, indent=1))


if __name__ == '__main__':
    main()
