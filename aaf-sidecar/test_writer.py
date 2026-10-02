"""AAF edit writer. Generated, linked (no essence) fixtures shaped like Media
Composer's "Link to (Don't Export) Media" exports. No media is needed."""
from fractions import Fraction
from pathlib import Path
import json
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import aaf2
import reader
import writer
from graph import GraphTimeline
from test_graph import grouped_fixture

RATE = '24000/1001'
SPF = Fraction(48000) / Fraction(RATE)            # 2002 samples per frame
RECORDERS = ('R1', 'R2', 'R3')
CAMS = ('CAM A', 'CAM B')
LEAD, SEG1, SEG2, TAIL = 48, 300, 400, 52         # sequence: filler, group seg, group seg, filler
GROUP_IN = (1000, 6000)                          # where each segment sits in the recorders
PICK1, PICK2 = (0, 0), (1, 2)                    # selected recorder per audio track, per segment


def chain(f, name, kind, channel, length, url, legacy):
    """Tape SourceMob -> file SourceMob (linked MXF) -> MasterMob slot."""
    tape = f.create.SourceMob(name + ' tape'); tape.descriptor = f.create.TapeDescriptor(); f.content.mobs.append(tape)
    ts = tape.create_timeline_slot(RATE); ts.segment = f.create.SourceClip(media_kind=kind, length=length)
    ts['PhysicalTrackNumber'].value = channel
    fm = f.create.SourceMob(name); f.content.mobs.append(fm)
    if kind.lower().endswith('sound'):
        d = f.create.PCMDescriptor()
        for k, v in {'Channels': 1, 'BlockAlign': 3, 'SampleRate': 48000, 'AudioSamplingRate': 48000,
                     'AverageBPS': 144000, 'QuantizationBits': 24, 'Length': int(length * SPF)}.items():
            d[k].value = v
    else:
        d = f.create.CDCIDescriptor()
        for k, v in {'StoredWidth': 1920, 'StoredHeight': 1080, 'FrameLayout': 'FullFrame', 'VideoLineMap': [42, 0],
                     'ImageAspectRatio': '16/9', 'ComponentWidth': 8, 'HorizontalSubsampling': 2,
                     'SampleRate': RATE, 'Length': length}.items():
            d[k].value = v
    loc = f.create.NetworkLocator(); loc['URLString'].value = url; d['Locator'].append(loc); fm.descriptor = d
    fs = fm.create_timeline_slot(RATE); fs['PhysicalTrackNumber'].value = channel
    fs.segment = tape.create_source_clip(ts.slot_id, 0, length, kind)
    return fm, fs


def master(f, name, tracks, length, legacy=False):
    mm = f.create.MasterMob(name); f.content.mobs.append(mm)
    for kind, channel in tracks:
        kind = ('Legacy' + kind.capitalize()) if legacy else kind
        fm, fs = chain(f, name, kind, channel, length, f'file://NEXIS/Avid%20MediaFiles/MXF/1/{name}{channel}.mxf', legacy)
        ms = mm.create_timeline_slot(RATE); ms['PhysicalTrackNumber'].value = channel
        ms.segment = fm.create_source_clip(fs.slot_id, 0, length, kind)
    return mm


def selector(f, kind, clips, pick, start, length):
    made = [mob.create_source_clip(slot, start, length, kind) for mob, slot in clips]
    sel = f.create.Selector(media_kind=kind, length=length)
    sel['Selected'].value = made[pick]
    sel['Alternates'].value = [c for i, c in enumerate(made) if i != pick]
    return sel


def avid_fixture(path, *, legacy=False, pan=True, transition=False, name='Kitchen'):
    """TC, V1 and A1/A2 of inline group Selectors (two segments with different
    angles), A2 inside a constant Audio Pan, and one editor marker on A1."""
    sound, picture = ('LegacySound', 'LegacyPicture') if legacy else ('sound', 'picture')
    info = {}
    with aaf2.open(str(path), 'w') as f:
        pan_op = f.create.OperationDef('9d2ea893-0968-11d3-8a38-0050040ef7d2', 'Audio Pan')
        pan_op.media_kind = 'sound'; pan_op['NumberInputs'].value = 1; pan_op['IsTimeWarp'].value = False
        pan_op['Bypass'].value = 0; pan_op['OperationCategory'].value = 'OperationCategory_Effect'
        pan_param = f.create.ParameterDef('e4962322-2267-11d3-8a4c-0050040ef7d2', 'Pan', 'Pan', f.dictionary.lookup_typedef('Rational'))
        f.dictionary.register_def(pan_param); pan_op['ParametersDefined'].append(pan_param); f.dictionary.register_def(pan_op)
        recs = [master(f, f'{name} {r}', [('sound', 1), ('sound', 2)], 24000, legacy) for r in RECORDERS]
        cams = [master(f, f'{name} {c}', [('picture', 1)], 24000, legacy) for c in CAMS]
        info['recorders'] = [str(m.mob_id) for m in recs]; info['cams'] = [str(m.mob_id) for m in cams]
        comp = f.create.CompositionMob(f'{name} edit'); comp['UsageCode'].value = 'Usage_TopLevel'; f.content.mobs.append(comp)
        total = LEAD + SEG1 + SEG2 + TAIL
        tc = comp.create_timeline_slot(RATE); tc.segment = f.create.Timecode(fps=24, drop=False, length=total)
        tc.segment.start = 86400 * 18; tc['PhysicalTrackNumber'].value = 1
        v1 = comp.create_empty_sequence_slot(RATE, media_kind=picture); v1['PhysicalTrackNumber'].value = 1
        pics = [(m, m.slots[0].slot_id) for m in cams]
        v1.segment.components.extend([f.create.Filler(media_kind=picture, length=LEAD),
            selector(f, picture, pics, 0, GROUP_IN[0], SEG1), selector(f, picture, pics, 1, GROUP_IN[1], SEG2),
            f.create.Filler(media_kind=picture, length=TAIL)])
        v1.segment.length = total
        info['V1'] = v1.slot_id
        for channel in (1, 2):
            track = comp.create_empty_sequence_slot(RATE, media_kind=sound); track['PhysicalTrackNumber'].value = channel
            alts = [(m, m.slots[channel - 1].slot_id) for m in recs]
            parts = [f.create.Filler(media_kind=sound, length=LEAD),
                     selector(f, sound, alts, PICK1[channel - 1], GROUP_IN[0], SEG1),
                     selector(f, sound, alts, PICK2[channel - 1], GROUP_IN[1], SEG2),
                     f.create.Filler(media_kind=sound, length=TAIL)]
            if transition and channel == 1:
                # A 10-frame dissolve between the two group segments.
                t = f.create.Transition(media_kind=sound, length=10); t['CutPoint'].value = 5
                op = f.create.OperationDef('11111111-1111-1111-1111-111111111112', 'Test crossfade')
                op.media_kind = 'sound'; op['NumberInputs'].value = 2; f.dictionary.register_def(op)
                t['OperationGroup'].value = f.create.OperationGroup(op, length=10, media_kind='sound')
                parts[2] = selector(f, sound, alts, PICK2[0], GROUP_IN[1] - 10, SEG2 + 10)
                parts.insert(2, t)
            track.segment.components.extend(parts); track.segment.length = total
            info[f'A{channel}'] = track.slot_id
            if pan and channel == 2:
                seq = track.segment
                op = f.create.OperationGroup(pan_op, length=total, media_kind='sound')
                track.segment = op; op['InputSegments'].append(seq)
                op['Parameters'].append(f.create.ConstantValue(pan_param, aaf2.rational.AAFRational('1/2')))
        info['sequence_id'] = str(comp.mob_id); info['total'] = total
    return info


def nested_fixture(path, shape):
    """One sound track holding a group inside a group. `selected`: the inner
    group is the outer group's chosen option; `unselected`: it is an
    alternate the editor did not choose. Returns the recorders' mob ids."""
    with aaf2.open(str(path), 'w') as f:
        recs = [master(f, f'Nested {r}', [('sound', 1)], 24000) for r in RECORDERS]
        comp = f.create.CompositionMob('Nested edit'); comp['UsageCode'].value = 'Usage_TopLevel'; f.content.mobs.append(comp)
        tc = comp.create_timeline_slot(RATE); tc.segment = f.create.Timecode(fps=24, drop=False, length=SEG1)
        tc.segment.start = 86400; tc['PhysicalTrackNumber'].value = 1
        track = comp.create_empty_sequence_slot(RATE, media_kind='sound'); track['PhysicalTrackNumber'].value = 1
        clip = lambda m: m.create_source_clip(m.slots[0].slot_id, GROUP_IN[0], SEG1, 'sound')
        inner = f.create.Selector(media_kind='sound', length=SEG1)
        outer = f.create.Selector(media_kind='sound', length=SEG1)
        if shape == 'selected':
            inner['Selected'].value = clip(recs[0]); inner['Alternates'].value = [clip(recs[2])]
            outer['Selected'].value = inner; outer['Alternates'].value = [clip(recs[1])]
        else:
            inner['Selected'].value = clip(recs[1]); inner['Alternates'].value = [clip(recs[2])]
            outer['Selected'].value = clip(recs[0]); outer['Alternates'].value = [inner]
        track.segment.components.append(outer); track.segment.length = SEG1
        return {'sequence_id': str(comp.mob_id), 'A1': track.slot_id, 'recorders': [str(m.mob_id) for m in recs],
                'angle': f"{recs[2].mob_id}:{recs[2].slots[0].slot_id}"}


class WriterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sauce-writer-'); self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def source(self, name='source.aaf', **options):
        path = self.root / name
        return path, avid_fixture(path, name=Path(name).stem, **options)

    def request(self, path, info, segments, *, approach='C', tracks=None, out='out.aaf', **extra):
        request = {'schema_version': 1, 'name': 'SO_E104_Rosa_v01', 'edit_rate': RATE,
                   'start_timecode_frames': 86400, 'approach': approach,
                   'sources': [{'id': 's1', 'aaf_path': str(path), 'sequence_id': info['sequence_id']}],
                   'tracks': tracks or [{'kind': 'picture', 'physical_track_number': 1, 'source_slots': {'s1': info['V1']}},
                                        {'kind': 'sound', 'physical_track_number': 1, 'source_slots': {'s1': info['A1']}},
                                        {'kind': 'sound', 'physical_track_number': 2, 'source_slots': {'s1': info['A2']}}],
                   'segments': segments, 'output_path': str(self.root / out)}
        request.update(extra)
        return request

    def read(self, path, sequence_id=None):
        with aaf2.open(str(path), 'r') as f:
            return GraphTimeline(f, sequence_id).manifest(reader.fingerprint(Path(path)))

    def main(self, manifest):
        """Tracks that play, without the group alternates the reader offers."""
        return [t for t in manifest['tracks'] if not t.get('parent_track_id')]

    def top(self, f):
        return next(f.content.toplevel())

    def played(self, manifest, track_id, frame):
        track = next(t for t in manifest['tracks'] if t['id'] == str(track_id))
        clip = next(c for c in track['clips'] if c['start_frame'] <= frame < c['start_frame'] + c['duration_frames'])
        if clip['kind'] != 'audio':
            return clip['kind']
        pos = clip['source_sample_position']
        return clip['master_id'], Fraction(pos['numerator'], pos['denominator']) + (frame - clip['start_frame']) * SPF

    def test_cut_list_lands_every_frame_on_the_source_frame(self):
        path, info = self.source()
        cuts = [(LEAD + 10, LEAD + 120), (LEAD + SEG1 - 20, LEAD + SEG1 + 30), (LEAD + SEG1 + 200, LEAD + SEG1 + 260)]
        result = writer.write_edit(self.request(path, info, [{'kind': 'source', 'source': 's1', 'in_frame': a, 'out_frame': b} for a, b in cuts]))
        self.assertTrue(result['verify']['ok'])
        self.assertEqual(result['duration_frames'], sum(b - a for a, b in cuts))
        self.assertEqual(result['verify']['frames_checked'], 3 * result['duration_frames'])
        original, out = self.read(path), self.read(result['output'], result['sequence_id'])
        cursor = 0
        a1 = next(t for t in result['tracks'] if t['label'] == 'A1')['slot_id']
        for a, b in cuts:   # independent of the writer's own check
            for frame in (a, b - 1):
                self.assertEqual(self.played(out, a1, cursor + frame - a), self.played(original, info['A1'], frame))
            cursor += b - a
        self.assertEqual((out['start_frame'], out['duration_frames']), (86400, cursor))
        with aaf2.open(result['output'], 'r') as f:
            self.assertEqual(len(list(f.content.essencedata)), 0)
            self.assertEqual(len(list(f.content.toplevel())), 1)
            with aaf2.open(str(path), 'r') as src:
                src_ids = {str(m.mob_id) for m in src.content.mobs}
            copied = {str(m.mob_id) for m in f.content.mobs} - {result['sequence_id']}
            self.assertTrue(copied and copied <= src_ids)                    # never re-minted
            for track in (self.top(f).slot_at(t['slot_id']) for t in result['tracks']):
                self.assertTrue(all(c.length > 0 for c in track.segment.components))
                self.assertEqual(sum(c.length for c in track.segment.components), cursor)

    def test_gaps_are_filler_on_every_track_and_timecode_runs_through(self):
        path, info = self.source()
        segments = [{'kind': 'source', 'source': 's1', 'in_frame': LEAD, 'out_frame': LEAD + 50}, {'kind': 'gap', 'frames': 24},
                    {'kind': 'source', 'source': 's1', 'in_frame': LEAD + 60, 'out_frame': LEAD + 100}]
        result = writer.write_edit(self.request(path, info, segments))
        out = self.read(result['output'], result['sequence_id'])
        for track in self.main(out):
            self.assertEqual([(c['kind'], c['start_frame'], c['duration_frames']) for c in track['clips']],
                             [('audio', 0, 50), ('gap', 50, 24), ('audio', 74, 40)])
        with aaf2.open(result['output'], 'r') as f:
            top = self.top(f)
            tc = next(s.segment for s in top.slots if isinstance(s.segment, aaf2.components.Timecode))
            self.assertEqual((tc.start, tc.length, tc.fps, tc.drop), (86400, 114, 24, False))
            v1 = top.slot_at(result['tracks'][0]['slot_id']).segment
            self.assertEqual([type(c).__name__ for c in v1.components], ['Selector', 'Filler', 'Selector'])
            self.assertEqual(v1.components[1].media_kind, 'Picture')

    def test_mute_silences_one_track_only(self):
        path, info = self.source()
        request = self.request(path, info, [{'kind': 'source', 'source': 's1', 'in_frame': LEAD, 'out_frame': LEAD + 100}],
                               mutes=[{'segment_index': 0, 'track_index': 2, 'from_frame': 10, 'to_frame': 40}])
        result = writer.write_edit(request)
        out = self.read(result['output'], result['sequence_id'])
        clips = {t['physical_track_number']: [(c['kind'], c['start_frame'], c['duration_frames']) for c in t['clips']] for t in self.main(out)}
        self.assertEqual(clips[2], [('audio', 0, 10), ('gap', 10, 30), ('audio', 40, 60)])
        self.assertEqual(clips[1], [('audio', 0, 100)])

    def test_markers_round_trip_through_the_reader_and_the_avid_text(self):
        path, info = self.source()
        markers = [{'frame': 0, 'track_index': 1, 'name': 'Rosa', 'comment': 'Opens on the breakup\tline', 'color': 'red'},
                   {'frame': 70, 'track_index': 0, 'name': 'Story', 'comment': 'Picture note', 'color': 'Cyan'}]
        result = writer.write_edit(self.request(path, info, [{'kind': 'source', 'source': 's1', 'in_frame': LEAD, 'out_frame': LEAD + 100}],
                                                markers=markers))
        self.assertEqual(result['markers'], 2)
        out = self.read(result['output'], result['sequence_id'])
        got = sorted((m['position'], m['comment'], m['attributes']['_ATN_CRM_USER'], m['attributes']['_ATN_CRM_COLOR'], m['described_slots'])
                     for m in out['graph']['markers'])
        slots = {t['index']: t['slot_id'] for t in result['tracks']}
        self.assertEqual(got, [(0, 'Opens on the breakup\tline', 'Rosa', 'Red', [slots[1]]), (70, 'Picture note', 'Story', 'Cyan', [slots[0]])])
        text = Path(result['markers_output']).read_text(encoding='utf-8')
        self.assertEqual(text, 'Rosa\t01:00:00:00\tA1\tred\tOpens on the breakup line\t1\n'
                               'Story\t01:00:02:22\tV1\tcyan\tPicture note\t1\n')
        self.assertTrue(result['markers_output'].endswith('out - Avid markers.txt'))

    def test_approach_c_keeps_the_group_and_the_chosen_angle(self):
        path, info = self.source()
        # Second group segment: A2 plays R3 and V1 plays CAM B.
        result = writer.write_edit(self.request(path, info, [{'kind': 'source', 'source': 's1', 'in_frame': LEAD + SEG1 + 5, 'out_frame': LEAD + SEG1 + 50}]))
        with aaf2.open(result['output'], 'r') as f:
            top = self.top(f)
            a2 = top.slot_at(result['tracks'][2]['slot_id']).segment.components[0]
            self.assertEqual(value_name(a2), 'OperationGroup')                       # constant pan kept
            sel = a2['InputSegments'].value[0]
            self.assertEqual(value_name(sel), 'Selector')
            self.assertEqual(str(sel['Selected'].value.mob_id), info['recorders'][2])
            self.assertEqual(len(sel['Alternates'].value), 2)
            self.assertEqual((sel['Selected'].value.start, sel.length), (GROUP_IN[1] + 5, 45))
            v1 = top.slot_at(result['tracks'][0]['slot_id']).segment.components[0]
            self.assertEqual(str(v1['Selected'].value.mob_id), info['cams'][1])
            for mob_id in info['recorders'] + info['cams']:                            # every angle travels with it
                self.assertIsNotNone(f.content.mobs.get(aaf2.mobid.MobID(mob_id)))

    def test_picture_keeps_its_groups_while_each_sound_track_is_the_clip_that_plays(self):
        # String Outs' default: V1 stays a switchable multigroup, and each
        # person's audio is their own mic, not a group of every lav.
        path, info = self.source()
        tracks = [{'kind': 'picture', 'physical_track_number': 1, 'source_slots': {'s1': info['V1']}, 'approach': 'C'},
                  {'kind': 'sound', 'physical_track_number': 1, 'source_slots': {'s1': info['A1']}}]
        result = writer.write_edit(self.request(path, info, [{'kind': 'source', 'source': 's1', 'in_frame': LEAD + SEG1 + 5, 'out_frame': LEAD + SEG1 + 50}],
                                                approach='B', tracks=tracks))
        self.assertTrue(result['verify']['ok'])
        with aaf2.open(result['output'], 'r') as f:
            top = self.top(f)
            v1 = top.slot_at(result['tracks'][0]['slot_id']).segment.components[0]
            self.assertEqual(value_name(v1), 'Selector')
            self.assertEqual(str(v1['Selected'].value.mob_id), info['cams'][1])
            self.assertEqual([str(a.mob_id) for a in v1['Alternates'].value], [info['cams'][0]])
            a1 = top.slot_at(result['tracks'][1]['slot_id']).segment.components[0]
            self.assertEqual(value_name(a1), 'SourceClip')
            self.assertEqual(str(a1.mob_id), info['recorders'][PICK2[0]])
        bad = self.request(path, info, [{'kind': 'source', 'source': 's1', 'in_frame': LEAD, 'out_frame': LEAD + 10}],
                           tracks=[dict(tracks[1], approach='D')])
        with self.assertRaises(reader.ReaderError):
            writer.validate(bad)

    def test_an_angle_that_cannot_be_cut_is_left_out_of_its_group_not_the_export(self):
        # HEAT 2: one camera of the V1 multigroup is slow motion (a Motion
        # Control time warp). Keep groups used to refuse the whole export.
        path, info = self.source()
        with aaf2.open(str(path), 'rw') as f:
            warp = f.create.OperationDef('11111111-1111-1111-1111-111111111199', 'Motion Control')
            warp.media_kind = 'picture'; warp['NumberInputs'].value = 1; warp['IsTimeWarp'].value = True; f.dictionary.register_def(warp)
            top = next(f.content.toplevel())
            group = top.slot_at(info['V1']).segment.components[2]
            slow = group['Alternates'].value[0]
            wrapped = f.create.OperationGroup(warp, length=slow.length, media_kind='picture')
            group['Alternates'].value = []
            wrapped['InputSegments'].append(slow)
            group['Alternates'].append(wrapped)
        result = writer.write_edit(self.request(path, info, [{'kind': 'source', 'source': 's1', 'in_frame': LEAD + SEG1 + 5, 'out_frame': LEAD + SEG1 + 50}]))
        self.assertTrue(result['verify']['ok'])
        self.assertTrue(any('Motion Control changes speed' in w and 'left out of its group' in w for w in result['warnings']), result['warnings'])
        with aaf2.open(result['output'], 'r') as f:
            v1 = self.top(f).slot_at(result['tracks'][0]['slot_id']).segment.components[0]
            self.assertEqual(value_name(v1), 'Selector')
            self.assertEqual(str(v1['Selected'].value.mob_id), info['cams'][1])
            self.assertEqual(v1['Alternates'].value, [])
            # The slow camera's clip is not copied just because the attempt reached it.
            self.assertIsNone(f.content.mobs.get(aaf2.mobid.MobID(info['cams'][0])))

    def featured(self, info, recorder, channel=1):
        """A1's layout plus a track of its own for one group angle: `recorder`
        on `channel`, as a person who is an alternate in the group."""
        angle = f"{info['recorders'][recorder]}:{channel}"
        return [{'kind': 'sound', 'physical_track_number': 1, 'source_slots': {'s1': info['A1']}},
                {'kind': 'sound', 'physical_track_number': 2, 'source_slots': {'s1': info['A1']}, 'choices': {'s1': [angle]}}]

    def test_a_featured_angle_gets_its_own_track_and_keeps_the_group(self):
        path, info = self.source()
        cuts = [(LEAD + 10, LEAD + 60), (LEAD + SEG1 + 20, LEAD + SEG1 + 80)]
        result = writer.write_edit(self.request(path, info, [{'kind': 'source', 'source': 's1', 'in_frame': a, 'out_frame': b} for a, b in cuts],
                                                tracks=self.featured(info, 2)))
        self.assertTrue(result['verify']['ok'])
        out = self.read(result['output'], result['sequence_id'])
        a1, a2 = (t['slot_id'] for t in result['tracks'])
        # The group's own track still plays the editor's angle; the new one plays R3 in both groups.
        self.assertEqual(self.played(out, a1, 0)[0], info['recorders'][0])
        self.assertEqual(self.played(out, a1, 50)[0], info['recorders'][1])
        self.assertEqual(self.played(out, a2, 0), (info['recorders'][2], (GROUP_IN[0] + 10) * SPF))
        self.assertEqual(self.played(out, a2, 50), (info['recorders'][2], (GROUP_IN[1] + 20) * SPF))
        with aaf2.open(result['output'], 'r') as f:
            sel = self.top(f).slot_at(a2).segment.components[0]
            self.assertEqual(value_name(sel), 'Selector')                          # still switchable in Avid
            self.assertEqual(str(sel['Selected'].value.mob_id), info['recorders'][2])
            self.assertEqual(sorted(str(a.mob_id) for a in sel['Alternates'].value), sorted(info['recorders'][:2]))

    def test_approach_b_takes_a_featured_angle_to_its_master_clip(self):
        path, info = self.source()
        result = writer.write_edit(self.request(path, info, [{'kind': 'source', 'source': 's1', 'in_frame': LEAD + SEG1 - 10, 'out_frame': LEAD + SEG1 + 10}],
                                                approach='B', tracks=self.featured(info, 2)))
        self.assertTrue(result['verify']['ok'])
        with aaf2.open(result['output'], 'r') as f:
            clips = list(self.top(f).slot_at(result['tracks'][1]['slot_id']).segment.components)
            self.assertEqual([value_name(c) for c in clips], ['SourceClip', 'SourceClip'])
            self.assertEqual([str(c.mob_id) for c in clips], [info['recorders'][2]] * 2)
            self.assertEqual([c.start for c in clips], [GROUP_IN[0] + SEG1 - 10, GROUP_IN[1]])

    def test_a_featured_track_is_silent_outside_the_groups(self):
        path, info = self.source()
        # Five frames of the lead filler, then the first group; an angle no group offers plays nothing.
        cut = [{'kind': 'source', 'source': 's1', 'in_frame': LEAD - 5, 'out_frame': LEAD + 5}]
        result = writer.write_edit(self.request(path, info, cut, tracks=self.featured(info, 2)))
        out = self.read(result['output'], result['sequence_id'])
        a2 = result['tracks'][1]['slot_id']
        self.assertEqual(self.played(out, a2, 0), 'gap')
        self.assertEqual(self.played(out, a2, 5)[0], info['recorders'][2])
        nowhere = self.featured(info, 2)
        nowhere[1]['choices'] = {'s1': ['urn:smpte:umid:060a2b34.01010105.01010f10.13000000.00000000.00000000.00000000.00000000:1']}
        result = writer.write_edit(self.request(path, info, cut, tracks=nowhere, out='nowhere.aaf'))
        self.assertTrue(result['verify']['ok'])
        out = self.read(result['output'], result['sequence_id'])
        self.assertEqual({self.played(out, result['tracks'][1]['slot_id'], frame) for frame in range(10)}, {'gap'})

    def nested(self, shape, approach='C'):
        path = self.root / f'nested-{shape}.aaf'
        info = nested_fixture(path, shape)
        tracks = [{'kind': 'sound', 'physical_track_number': 1, 'source_slots': {'s1': info['A1']}, 'choices': {'s1': [info['angle']]}}]
        request = self.request(path, info, [{'kind': 'source', 'source': 's1', 'in_frame': 10, 'out_frame': 40}], approach=approach,
                               tracks=tracks, out=f'nested-{shape}-{approach}.aaf')
        return info, request

    def test_an_angle_in_a_group_nested_in_the_chosen_option_is_found(self):
        for approach in ('B', 'C'):
            info, request = self.nested('selected', approach)
            result = writer.write_edit(request)
            self.assertTrue(result['verify']['ok'])
            out = self.read(result['output'], result['sequence_id'])
            self.assertEqual(self.played(out, result['tracks'][0]['slot_id'], 0), (info['recorders'][2], (GROUP_IN[0] + 10) * SPF))

    def test_an_angle_in_a_group_nested_in_an_unchosen_option_is_refused_not_written_silent(self):
        _, request = self.nested('unselected')
        with self.assertRaises(reader.ReaderError) as caught:
            writer.write_edit(request)
        self.assertIn('unselected angle of another group', str(caught.exception))
        self.assertFalse(Path(request['output_path']).exists())

    def test_choices_are_refused_unless_they_name_a_source_the_track_uses(self):
        path, info = self.source()
        cut = [{'kind': 'source', 'source': 's1', 'in_frame': LEAD, 'out_frame': LEAD + 5}]
        for choices in ({'s2': ['x:1']}, {'s1': []}, {'s1': 'x:1'}, {'s1': [7]}):
            tracks = self.featured(info, 2); tracks[1]['choices'] = choices
            with self.assertRaises(reader.ReaderError, msg=json.dumps(choices)):
                writer.write_edit(self.request(path, info, cut, tracks=tracks))

    def test_approach_b_points_at_the_master_clip_channel(self):
        path, info = self.source()
        result = writer.write_edit(self.request(path, info, [{'kind': 'source', 'source': 's1', 'in_frame': LEAD + SEG1 - 10, 'out_frame': LEAD + SEG1 + 10}], approach='B'))
        with aaf2.open(result['output'], 'r') as f:
            top = self.top(f)
            a1 = list(top.slot_at(result['tracks'][1]['slot_id']).segment.components)
            self.assertEqual([value_name(c) for c in a1], ['SourceClip', 'SourceClip'])
            self.assertEqual([str(c.mob_id) for c in a1], [info['recorders'][0], info['recorders'][1]])
            self.assertEqual([c.start for c in a1], [GROUP_IN[0] + SEG1 - 10, GROUP_IN[1]])
            self.assertEqual(sum(1 for _ in f.content.compositionmobs()), 1)

    def test_several_source_aafs_and_shared_mobs_are_copied_once(self):
        first, one = self.source('one.aaf')
        second, two = self.source('two.aaf')
        request = self.request(first, one, [{'kind': 'source', 'source': 's1', 'in_frame': LEAD, 'out_frame': LEAD + 30},
                                            {'kind': 'source', 'source': 's2', 'in_frame': LEAD + 5, 'out_frame': LEAD + 25},
                                            {'kind': 'source', 'source': 's3', 'in_frame': LEAD + 40, 'out_frame': LEAD + 50}],
                               tracks=[{'kind': 'sound', 'physical_track_number': 1, 'source_slots': {'s1': one['A1'], 's2': two['A1'], 's3': one['A1']}},
                                       {'kind': 'picture', 'physical_track_number': 1, 'source_slots': {'s2': two['V1']}}])
        request['sources'] += [{'id': 's2', 'aaf_path': str(second), 'sequence_id': two['sequence_id']},
                               {'id': 's3', 'aaf_path': str(first), 'sequence_id': one['sequence_id']}]
        result = writer.write_edit(request)
        out = self.read(result['output'], result['sequence_id'])
        masters = [c['master_id'] for c in out['tracks'][0]['clips']]
        self.assertEqual(masters, [one['recorders'][0], two['recorders'][0], one['recorders'][0]])
        with aaf2.open(result['output'], 'r') as f:
            ids = [str(m.mob_id) for m in f.content.mobs]
            self.assertEqual(len(ids), len(set(ids)))
            v1 = self.top(f).slot_at(result['tracks'][1]['slot_id']).segment
            self.assertEqual([(value_name(c), c.length) for c in v1.components], [('Filler', 30), ('Selector', 20), ('Filler', 10)])

    def test_a_cut_inside_a_transition_is_refused_and_writes_nothing(self):
        path, info = self.source(transition=True)
        window = LEAD + SEG1 - 10     # the dissolve occupies [window, window + 10)
        for a, b in ((window + 3, window + 40), (window - 30, window + 4)):
            with self.assertRaises(reader.ReaderError) as error:
                writer.write_edit(self.request(path, info, [{'kind': 'source', 'source': 's1', 'in_frame': a, 'out_frame': b}]))
            self.assertEqual(error.exception.code, 'transition_split')
            self.assertIn('Segment 1 on A1', str(error.exception))
            self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['source.aaf'])
        # A bite that holds the whole dissolve keeps it.
        result = writer.write_edit(self.request(path, info, [{'kind': 'source', 'source': 's1', 'in_frame': window - 20, 'out_frame': window + 30}]))
        with aaf2.open(result['output'], 'r') as f:
            a1 = self.top(f).slot_at(result['tracks'][1]['slot_id']).segment
            self.assertEqual([value_name(c) for c in a1.components], ['Selector', 'Transition', 'Selector'])

    def test_legacy_data_definitions_are_kept_and_read(self):
        path, info = self.source(legacy=True, pan=False)
        result = writer.write_edit(self.request(path, info, [{'kind': 'source', 'source': 's1', 'in_frame': LEAD, 'out_frame': LEAD + 40}, {'kind': 'gap', 'frames': 5}]))
        self.assertEqual([t['data_def'] for t in result['tracks']], ['LegacyPicture', 'LegacySound', 'LegacySound'])
        with aaf2.open(result['output'], 'r') as f:
            a1 = self.top(f).slot_at(result['tracks'][1]['slot_id']).segment
            self.assertEqual(a1.components[-1].media_kind, 'LegacySound')
        self.assertEqual(len(self.main(self.read(result['output'], result['sequence_id']))), 2)

    def test_grouped_fixture_offline_group_selector(self):
        path = self.root / 'group.aaf'; grouped_fixture(path)
        with aaf2.open(str(path), 'r') as f:
            top = self.top(f); seq = str(top.mob_id)
            sound = next(s.slot_id for s in top.slots if reader.media_kind(s.segment) == 'sound')
        request = self.request(path, {'sequence_id': seq}, [{'kind': 'source', 'source': 's1', 'in_frame': 0, 'out_frame': 20}],
                               tracks=[{'kind': 'sound', 'physical_track_number': 1, 'source_slots': {'s1': sound}}])
        request['start_timecode_frames'] = 0
        result = writer.write_edit(request)
        out = self.read(result['output'], result['sequence_id'])
        self.assertEqual([c['kind'] for c in out['tracks'][0]['clips']], ['gap', 'audio'])
        self.assertEqual(len(out['tracks']), 4)                  # the group's alternates still offered

    def test_the_self_check_catches_a_wrong_frame_and_publishes_nothing(self):
        """Break test: shift every trimmed start by one unit inside the writer.
        The structure is plausible; only a frame-by-frame re-read can tell."""
        path, info = self.source()
        real = writer.trim_units
        with patch.object(writer, 'trim_units', lambda *args: real(*args) + 1):
            with self.assertRaises(reader.ReaderError) as error:
                writer.write_edit(self.request(path, info, [{'kind': 'source', 'source': 's1', 'in_frame': LEAD, 'out_frame': LEAD + 30}],
                                               markers=[{'frame': 1, 'track_index': 1, 'name': 'x', 'comment': 'y', 'color': 'Red'}]))
        self.assertEqual(error.exception.code, 'verify_failed')
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['source.aaf'])
        # A dropped mute is caught too: build with the mute ignored, check with it.
        original = writer.build
        def ignore_mutes(spec, *args):
            return original(dict(spec, mutes={}), *args)
        with patch.object(writer, 'build', ignore_mutes):
            with self.assertRaises(reader.ReaderError) as error:
                writer.write_edit(self.request(path, info, [{'kind': 'source', 'source': 's1', 'in_frame': LEAD, 'out_frame': LEAD + 30}],
                                               mutes=[{'segment_index': 0, 'track_index': 1, 'from_frame': 3, 'to_frame': 5}]))
        self.assertEqual(error.exception.code, 'verify_failed')
        self.assertIn('A1 at frame 3', str(error.exception))

    def test_requests_are_validated_strictly(self):
        path, info = self.source()
        good = [{'kind': 'source', 'source': 's1', 'in_frame': LEAD, 'out_frame': LEAD + 30}]
        bad = [
            dict(output_path='relative.aaf'),
            dict(segments=[{'kind': 'source', 'source': 's1', 'in_frame': 30, 'out_frame': 30}]),
            dict(segments=[{'kind': 'source', 'source': 's1', 'in_frame': -1, 'out_frame': 3}]),
            dict(segments=[{'kind': 'source', 'source': 'nope', 'in_frame': 0, 'out_frame': 3}]),
            dict(segments=[{'kind': 'gap', 'frames': True}]),
            dict(segments=[{'kind': 'source', 'source': 's1', 'in_frame': 0, 'out_frame': info['total'] + 1}]),
            dict(approach='A'),
            dict(tracks=[{'kind': 'sound', 'physical_track_number': 1, 'source_slots': {'s1': info['A1']}}] * 2),
            dict(tracks=[{'kind': 'sound', 'physical_track_number': n, 'source_slots': {}} for n in range(1, 258)]),
            dict(tracks=[{'kind': 'sound', 'physical_track_number': 1, 'source_slots': {'s1': info['V1']}}]),
            dict(markers=[{'frame': 30, 'track_index': 0, 'name': 'n', 'comment': 'c', 'color': 'Red'}]),
            dict(markers=[{'frame': 0, 'track_index': 0, 'color': 'Chartreuse'}]),
            dict(mutes=[{'segment_index': 0, 'track_index': 1, 'from_frame': 20, 'to_frame': 31}]),
            dict(edit_rate='25'),
            dict(sources=[{'id': 's1', 'aaf_path': str(path), 'sequence_id': 'not-a-mob'}]),
        ]
        for change in bad:
            request = self.request(path, info, good)
            request.update(change)
            with self.subTest(change=list(change)):
                with self.assertRaises(reader.ReaderError) as error:
                    writer.write_edit(request)
                self.assertEqual(error.exception.code, 'invalid_input', str(error.exception))
        request = self.request(path, info, [{'kind': 'gap', 'frames': 1}] * (writer.MAX_SEGMENTS + 1))
        with self.assertRaises(reader.ReaderError):
            writer.validate(request)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['source.aaf'])

    def test_cli_writes_atomically_and_refuses_an_existing_output(self):
        path, info = self.source()
        request_path = self.root / 'request.json'
        request_path.write_text(json.dumps(self.request(path, info, [{'kind': 'source', 'source': 's1', 'in_frame': LEAD, 'out_frame': LEAD + 30}])))
        command = [sys.executable, str(Path(reader.__file__)), 'write-edit', '--request', str(request_path)]
        done = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        result = json.loads(done.stdout)
        self.assertEqual((result['schema_version'], result['duration_frames'], result['verify']['ok']), (1, 30, True))
        self.assertEqual(result['edit_rate'], {'numerator': 24000, 'denominator': 1001})
        again = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(again.returncode, 2)
        self.assertEqual(json.loads(again.stderr)['error']['code'], 'invalid_output')
        self.assertFalse([p for p in self.root.iterdir() if p.name.endswith('.partial')])
        self.assertEqual(self.read(self.root / 'out.aaf', result['sequence_id'])['duration_frames'], 30)

    def test_drop_frame_timecode_text(self):
        self.assertEqual(writer.timecode(1800, 30, True), '00:01:00;02')
        self.assertEqual(writer.timecode(17982, 30, True), '00:10:00;00')
        self.assertEqual(writer.timecode(86400 + 58, 24, False), '01:00:02:10')


def value_name(component):
    return type(component).__name__


if __name__ == '__main__':
    unittest.main()
