"""Verify string-out AAFs: metadata-only, references intact, and every cut resolves (through the
repo's own GraphTimeline) to the same source sample the ORIGINAL sequence plays at the cut's in-point.

Run with PYTHONPATH=<repo>/aaf-sidecar and PYTHONDONTWRITEBYTECODE=1.
"""
from fractions import Fraction
from pathlib import Path
import json
import sys

import aaf2
from aaf2.components import SourceReference
import reader
from graph import GraphTimeline

DESCRIPTIVE_METADATA = '01030201-1000-0000-060e-2b3404010101'


def manifest(path, sequence_id=None):
    with aaf2.open(str(path), 'r') as f:
        return GraphTimeline(f, sequence_id).manifest(reader.fingerprint(Path(path)))


def clip_at(track, frame):
    for clip in track['clips']:
        if clip['start_frame'] <= frame < clip['start_frame'] + clip['duration_frames']:
            return clip
    return None


def position(clip, frame, spf):
    pos = clip['source_sample_position']
    return Fraction(pos['numerator'], pos['denominator']) + (frame - clip['start_frame']) * spf


def expected_for(original, cut, spf, frame=None):
    """Where the ORIGINAL sequence plays cut.person at `frame`: root lane if selected, else its branch lane."""
    frame = cut['seq_in'] if frame is None else frame
    lanes = {l['track_id']: l for l in original['graph']['lanes']}
    for track in original['tracks']:
        lane = lanes[track['id']]
        is_root = track['id'] == str(cut['root_slot'])
        is_branch = (lane['parent_track_id'] == str(cut['root_slot'])
                     and lane['branch_id'] == f"{cut['master_id']}:{cut['master_slot']}")
        if not (is_root or is_branch):
            continue
        clip = clip_at(track, frame)
        if clip and clip['kind'] == 'audio' and clip['master_id'] == cut['master_id']:
            return clip['source_id'], position(clip, frame, spf), track['id']
    raise AssertionError(f"original sequence does not play {cut['person']} at {frame}")


def integrity(path, source_path):
    with aaf2.open(str(path), 'r') as f, aaf2.open(str(source_path), 'r') as src:
        mobs = {str(m.mob_id): m for m in f.content.mobs}
        src_ids = {str(m.mob_id) for m in src.content.mobs}
        dangling, refs = [], 0
        for mob in f.content.mobs:
            for item, _ in mob.walk_references(topdown=True):
                if isinstance(item, SourceReference) and item.mob_id is not None and item.mob_id.int != 0:
                    refs += 1
                    target = mobs.get(str(item.mob_id))
                    if target is None or item.slot_id not in {s.slot_id for s in target.slots}:
                        dangling.append((str(item.mob_id), item.slot_id))
        top = [m for m in f.content.toplevel()]
        copied = [i for i in mobs if i not in {str(t.mob_id) for t in top}]
        markers = []
        for slot in top[0].slots:
            seg = slot.segment
            if seg.datadef is not None and str(seg.datadef.auid) == DESCRIPTIVE_METADATA:
                for m in seg.components:
                    markers.append({'slot': slot.slot_id, 'phys': slot['PhysicalTrackNumber'].value,
                                    'position': m['Position'].value, 'described': sorted(m['DescribedSlots'].value),
                                    'comment': m['Comment'].value[:48]})
        media_kinds = sorted({slot.segment.media_kind for slot in top[0].slots
                              if slot.segment.datadef is not None and str(slot.segment.datadef.auid) == DESCRIPTIVE_METADATA})
        locators = sorted({l['URLString'].value for m in f.content.sourcemobs() if m.descriptor is not None
                           for l in (m.descriptor['Locator'].value if 'Locator' in m.descriptor else [])})
        return {'essence_data': len(list(f.content.essencedata)), 'mobs': len(mobs), 'references': refs,
                'dangling': dangling, 'copied_ids_all_from_source': all(i in src_ids for i in copied),
                'marker_count': len(markers), 'markers': markers, 'marker_media_kind_name': media_kinds,
                'sample_locator': locators[0] if locators else None,
                'identification': [(i['ProductName'].value) for i in f.header['IdentificationList'].value]}


def main(source, outputs, cuts_path, spf=Fraction(48000) / Fraction(24000, 1001)):
    original = manifest(source, json.loads(Path(source + '.json').read_text())['sequence_id'])
    cuts = json.loads(Path(cuts_path).read_text())
    summary = {}
    for out in outputs:
        info = integrity(out, source)
        with aaf2.open(out, 'r') as f:
            seq_id = str(next(f.content.toplevel()).mob_id)
        m = manifest(out, seq_id)
        tracks = {t['id']: t for t in m['tracks']}
        lanes = m['graph']['lanes']
        report = json.loads(Path(out + '.report.json').read_text())
        rows = []
        for cut, entry in zip(cuts, report['cuts']):
            want_source, want_pos, lane = expected_for(original, cut, spf)
            track = tracks[str(report['tracks'][cut['person']])]
            got = clip_at(track, entry['out_in'])
            got_source = got.get('source_id') if got else None
            got_pos = position(got, entry['out_in'], spf) if got and got['kind'] == 'audio' else None
            alternates = [l for l in lanes if l['parent_track_id'] == track['id']]
            # Every frame of the cut, not just the in-point.
            frames = list(range(cut['seq_in'], cut['seq_out']))
            mismatched = 0
            for f_ in frames:
                ws, wp, _ = expected_for(original, cut, spf, f_)
                g = clip_at(track, entry['out_in'] + f_ - cut['seq_in'])
                if not g or g.get('source_id') != ws or position(g, entry['out_in'] + f_ - cut['seq_in'], spf) != wp:
                    mismatched += 1
            rows.append({'person': cut['person'], 'out_track': track['physical_track_number'],
                         'out_in': entry['out_in'], 'expected_sample': str(want_pos), 'got_sample': str(got_pos),
                         'same_source_mob_slot': got_source == want_source, 'same_sample': got_pos == want_pos,
                         'frames_checked': len(frames), 'frames_mismatched': mismatched,
                         'group_alternate_lanes_on_track': len(alternates)})
        summary[Path(out).name] = {'bytes': Path(out).stat().st_size, 'integrity': info,
                                   'reader_tracks': len(m['tracks']), 'reader_markers': len(m['graph']['markers']),
                                   'reader_warnings': m['warnings'], 'cuts': rows}
    print(json.dumps(summary, indent=1, default=str))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[3:], sys.argv[2])
