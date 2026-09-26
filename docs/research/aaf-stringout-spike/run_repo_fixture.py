"""Approaches B and C against the repo's OWN grouped_fixture (aaf-sidecar/test_graph.py),
plain and with the nested-alternatives shape from test_nested_alternatives_inside_an_unselected_branch.

One cut per available choice on every root track; every frame verified through GraphTimeline.
Run with PYTHONPATH=<repo>/aaf-sidecar PYTHONDONTWRITEBYTECODE=1.
"""
from fractions import Fraction
from pathlib import Path
import json
import shutil
import sys

import aaf2
from aaf2.components import Selector, SourceClip
import reader
from graph import GraphTimeline
from test_graph import grouped_fixture

sys.path.insert(0, str(Path(__file__).parent))
from write_stringout import Cut, write_stringout  # noqa: E402

SPF = Fraction(48000) / Fraction(24000, 1001)
ROOT = Path(__file__).parent / 'out' / 'repo-fixture'


def manifest(path, sequence_id=None):
    with aaf2.open(str(path), 'r') as f:
        return GraphTimeline(f, sequence_id).manifest(reader.fingerprint(path))


def clip_at(track, frame):
    return next((c for c in track['clips'] if c['start_frame'] <= frame < c['start_frame'] + c['duration_frames']), None)


def pos(clip, frame):
    p = clip['source_sample_position']
    return Fraction(p['numerator'], p['denominator']) + (frame - clip['start_frame']) * SPF


def choices(seg):
    """Every (mob, slot) a Selector subtree can play, following nested Selectors."""
    if isinstance(seg, SourceClip):
        return [(str(seg.mob_id), seg.slot_id)]
    if isinstance(seg, Selector):
        out = choices(seg['Selected'].value)
        for alt in seg['Alternates'].value:
            out += choices(alt)
        return out
    return []


def expected(original, root_slot, master_id, frame):
    lanes = {l['track_id']: l for l in original['graph']['lanes']}
    for track in original['tracks']:
        lane = lanes[track['id']]
        if track['id'] != str(root_slot) and lane['parent_track_id'] != str(root_slot):
            continue
        clip = clip_at(track, frame)
        if clip and clip['kind'] == 'audio' and clip['master_id'] == master_id:
            return clip['source_id'], pos(clip, frame)
    return None


def run(name, nested):
    work = ROOT / name
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    src = work / 'group.aaf'
    grouped_fixture(src, alternatives=3, roots=2, frames=240)
    for wav in work.glob('*.wav'):
        wav.unlink()                        # offline, like media on an unmounted NEXIS
    if nested:                              # same edit as test_graph.py's nested-alternatives test
        with aaf2.open(str(src), 'rw') as f:
            track = next(s for s in next(f.content.toplevel()).slots if s.segment.media_kind == 'Sound')
            outer = track.segment.components[1]
            alts = list(outer['Alternates'].value)
            inner = f.create.Selector(media_kind='sound', length=outer.length)
            inner['Selected'].value = alts[0].copy()
            inner['Alternates'].append(alts[1].copy())
            outer['Alternates'].value = [inner]
    with aaf2.open(str(src), 'r') as f:
        seq = next(f.content.toplevel())
        seq_id = str(seq.mob_id)
        roots = [(s.slot_id, s.segment.components[1]) for s in seq.slots if s.segment.media_kind.lower() == 'sound']
        cuts, at = [], 5
        for root_slot, selector in roots:
            for index, (mob_id, slot_id) in enumerate(dict.fromkeys(choices(selector))):
                cuts.append(Cut(person=f'P{root_slot}-{index}', root_slot=root_slot, master_id=mob_id,
                                master_slot=slot_id, seq_in=at, seq_out=at + 40, text=f'cut {len(cuts)}'))
                at = 5 + (at + 17) % 150
    original = manifest(src, seq_id)
    results = {}
    for approach in 'BC':
        out = work / f'stringout_{approach}.aaf'
        report = write_stringout(src, out, seq_id, cuts, approach)
        m = manifest(out, report['sequence_id'])
        tracks = {t['id']: t for t in m['tracks']}
        checked = bad = 0
        for cut, entry in zip(cuts, report['cuts']):
            track = tracks[str(report['tracks'][cut.person])]
            for frame in range(cut.seq_in, cut.seq_out):
                want = expected(original, cut.root_slot, cut.master_id, frame)
                got = clip_at(track, entry['out_in'] + frame - cut.seq_in)
                checked += 1
                if want is None or got is None or (got.get('source_id'), pos(got, entry['out_in'] + frame - cut.seq_in)) != want:
                    bad += 1
        with aaf2.open(str(out), 'r') as f:
            essence = len(list(f.content.essencedata))
        results[approach] = {'cuts': len(cuts), 'frames_checked': checked, 'frames_mismatched': bad,
                             'selector_swaps': [e['selector_swaps'] for e in report['cuts']],
                             'essence_data': essence, 'bytes': out.stat().st_size, 'reader_lanes': len(m['tracks'])}
    return results


if __name__ == '__main__':
    print(json.dumps({'plain': run('plain', False), 'nested': run('nested', True)}, indent=1))
