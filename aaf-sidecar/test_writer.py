"""AAF edit writer. Generated, linked (no essence) fixtures shaped like Media
Composer's "Link to (Don't Export) Media" exports. No media is needed."""
from fractions import Fraction
import math
from pathlib import Path
from types import SimpleNamespace
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import aaf2
from aaf2.components import Selector, SourceClip
from aaf2.misc import TaggedValueHelper
from picture import is_muted
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


def chain(f, name, kind, channel, length, url, legacy, rate=RATE):
    """Tape SourceMob -> file SourceMob (linked MXF) -> MasterMob slot."""
    tape = f.create.SourceMob(name + ' tape'); tape.descriptor = f.create.TapeDescriptor(); f.content.mobs.append(tape)
    ts = tape.create_timeline_slot(rate); ts.segment = f.create.SourceClip(media_kind=kind, length=length)
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
                     'SampleRate': rate, 'Length': length}.items():
            d[k].value = v
    loc = f.create.NetworkLocator(); loc['URLString'].value = url; d['Locator'].append(loc); fm.descriptor = d
    fs = fm.create_timeline_slot(rate); fs['PhysicalTrackNumber'].value = channel
    fs.segment = tape.create_source_clip(ts.slot_id, 0, length, kind)
    return fm, fs


def master(f, name, tracks, length, legacy=False, rate=RATE):
    mm = f.create.MasterMob(name); f.content.mobs.append(mm)
    for kind, channel in tracks:
        kind = ('Legacy' + kind.capitalize()) if legacy else kind
        fm, fs = chain(f, name, kind, channel, length, f'file://NEXIS/Avid%20MediaFiles/MXF/1/{name}{channel}.mxf', legacy, rate)
        ms = mm.create_timeline_slot(rate); ms['PhysicalTrackNumber'].value = channel
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


GROUP_LENGTH, GROUP_IN_SLOT = 4000, 100           # the group clip's length, and where the edit cuts into it


def group_clip_fixture(path):
    """V1, A1 and A2 cut from one Media Composer group clip: a CompositionMob
    whose Selectors hold every angle, one of them a submaster, as HEAT 2's V1
    does. The show also holds a clip nothing refers to. As in Media
    Composer's own export, the mob the edit cuts from is the group's sync mob,
    which names the group clip a bin shows with a `_MATCH` attribute; that
    group clip refers back to it, and nothing on the timeline refers to the
    group clip. A master clip's `_MATCH` names a mob the show does not hold."""
    with aaf2.open(str(path), 'w') as f:
        recs = [master(f, f'Show {r}', [('sound', 1), ('sound', 2)], 24000) for r in ('R1', 'R2', 'R3', 'R4')]
        cams = [master(f, f'Show {c}', [('picture', 1)], 24000) for c in CAMS]
        unused = master(f, 'Show unused', [('sound', 1)], 24000)
        sub = f.create.CompositionMob('Show submaster'); f.content.mobs.append(sub)
        sub_slot = sub.create_timeline_slot(RATE)
        sub_slot.segment = recs[3].create_source_clip(recs[3].slots[0].slot_id, 0, 24000, 'sound')
        group = f.create.CompositionMob('Show group'); f.content.mobs.append(group)
        picture = group.create_timeline_slot(RATE)
        picture.segment = selector(f, 'picture', [(m, m.slots[0].slot_id) for m in cams], 0, 1000, GROUP_LENGTH)
        sound = []
        for channel in (1, 2):
            slot = group.create_timeline_slot(RATE)
            slot.segment = selector(f, 'sound', [(m, m.slots[channel - 1].slot_id) for m in recs[:3]], channel - 1, 1000, GROUP_LENGTH)
            slot.segment['Alternates'].append(sub.create_source_clip(sub_slot.slot_id, 1000, GROUP_LENGTH, 'sound'))
            sound.append(slot.slot_id)
        clip = f.create.CompositionMob('Show group clip'); clip['UsageCode'].value = 'Usage_LowerLevel'
        f.content.mobs.append(clip)
        clip.create_timeline_slot(RATE).segment = group.create_source_clip(picture.slot_id, 0, GROUP_LENGTH, 'picture')
        match(f, group, clip.mob_id)
        nowhere = aaf2.mobid.MobID.new()
        match(f, recs[0], nowhere)
        comp = f.create.CompositionMob('Show edit'); comp['UsageCode'].value = 'Usage_TopLevel'; f.content.mobs.append(comp)
        total = LEAD + SEG1 + TAIL
        tc = comp.create_timeline_slot(RATE); tc.segment = f.create.Timecode(fps=24, drop=False, length=total)
        tc.segment.start = 86400 * 18; tc['PhysicalTrackNumber'].value = 1
        info = {'sequence_id': str(comp.mob_id), 'total': total, 'group': str(group.mob_id), 'submaster': str(sub.mob_id),
                'unused': str(unused.mob_id), 'group_clip': str(clip.mob_id), 'nowhere': str(nowhere), 'recorders': [str(m.mob_id) for m in recs], 'cams': [str(m.mob_id) for m in cams]}
        for name, kind, group_slot, number in (('V1', 'picture', picture.slot_id, 1), ('A1', 'sound', sound[0], 1),
                                               ('A2', 'sound', sound[1], 2)):
            track = comp.create_empty_sequence_slot(RATE, media_kind=kind); track['PhysicalTrackNumber'].value = number
            track.segment.components.extend([f.create.Filler(media_kind=kind, length=LEAD),
                                             group.create_source_clip(group_slot, GROUP_IN_SLOT, SEG1, kind),
                                             f.create.Filler(media_kind=kind, length=TAIL)])
            track.segment.length = total
            info[name] = track.slot_id
    return info


def match(f, mob, target):
    """Media Composer's `_MATCH` mob attribute: a PortableObject naming another mob."""
    reference = f.create.from_name('Avid MC Mob Reference')
    reference['Mob Reference MobID'].value = target
    reference['Mob Reference Position'].value = 0
    attribute = f.create.TaggedValue('_MATCH', '__PortableObject')
    attribute['PortableObject'].value = reference
    mob['MobAttributeList'].append(attribute)


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

    def test_a_track_plays_its_override_across_a_segment_and_the_others_play_on(self):
        """A record track as a layer: A1 plays A2's mic from 150 frames later
        for the second segment alone, A2 is untouched, and the self-check
        compares A1 against what the override asked for."""
        path, info = self.source()
        segments = [{'kind': 'source', 'source': 's1', 'in_frame': LEAD, 'out_frame': LEAD + 40},
                    {'kind': 'source', 'source': 's1', 'in_frame': LEAD + 40, 'out_frame': LEAD + 100}]
        override = {'segment_index': 1, 'track_index': 1, 'source': 's1', 'slot': info['A2'], 'in_frame': LEAD + 190}
        result = writer.write_edit(self.request(path, info, segments, schema_version=2, overrides=[override],
                                                mutes=[{'segment_index': 1, 'track_index': 1, 'from_frame': 50, 'to_frame': 60}]))
        self.assertTrue(result['verify']['ok'])
        original, out = self.read(path), self.read(result['output'], result['sequence_id'])
        a1 = next(t for t in result['tracks'] if t['label'] == 'A1')['slot_id']
        a2 = next(t for t in result['tracks'] if t['label'] == 'A2')['slot_id']
        # First segment: A1 plays its own mic. Second: A2's mic from LEAD + 190, then the mute.
        self.assertEqual(self.played(out, a1, 10), self.played(original, info['A1'], LEAD + 10))
        self.assertEqual(self.played(out, a1, 40), self.played(original, info['A2'], LEAD + 190))
        self.assertEqual(self.played(out, a1, 89), self.played(original, info['A2'], LEAD + 239))
        self.assertEqual(self.played(out, a1, 92), 'gap')
        self.assertEqual(self.played(out, a2, 45), self.played(original, info['A2'], LEAD + 45))
        # Without version 2 the request is refused, never written as the segment's own audio.
        with self.assertRaises(reader.ReaderError):
            writer.write_edit(self.request(path, info, segments, overrides=[override], out='old.aaf'))
        self.assertFalse((self.root / 'old.aaf').exists())
        # An override past the end of its slot, or on a picture track, is refused.
        for bad in ({**override, 'in_frame': 10 ** 6}, {**override, 'slot': info['V1']}, {**override, 'slot': 'x'}):
            with self.assertRaises(reader.ReaderError):
                writer.write_edit(self.request(path, info, segments, schema_version=2, overrides=[bad], out='bad.aaf'))

    def test_a_track_that_carries_on_across_another_tracks_cut_is_one_clip(self):
        """A segment boundary falls wherever ANY track was cut. A2 and V1 carry
        on across A1's cut here, so Media Composer gets one clip on each, as
        String Outs draws them; a deliberate Add Edit (`cuts`) stays an edit,
        and a mute inside a joined run still lands where it was asked for."""
        path, info = self.source()
        segments = [{'kind': 'source', 'source': 's1', 'in_frame': LEAD, 'out_frame': LEAD + 40},
                    {'kind': 'source', 'source': 's1', 'in_frame': LEAD + 40, 'out_frame': LEAD + 100}]
        override = {'segment_index': 1, 'track_index': 1, 'source': 's1', 'slot': info['A2'], 'in_frame': LEAD + 190}

        def pieces(result, label):
            slot_id = next(t for t in result['tracks'] if t['label'] == label)['slot_id']
            with aaf2.open(result['output'], 'r') as f:
                return [(type(c).__name__ == 'Filler', c.length) for c in self.top(f).slot_at(slot_id).segment.components]
        joined = writer.write_edit(self.request(path, info, segments, schema_version=2, overrides=[override],
                                                mutes=[{'segment_index': 1, 'track_index': 2, 'from_frame': 10, 'to_frame': 20}]))
        self.assertTrue(joined['verify']['ok'])
        self.assertEqual(pieces(joined, 'A1'), [(False, 40), (False, 60)])
        self.assertEqual(pieces(joined, 'A2'), [(False, 50), (True, 10), (False, 40)])
        self.assertEqual(pieces(joined, 'V1'), [(False, 100)])
        cut = writer.write_edit(self.request(path, info, segments, schema_version=2, overrides=[override],
                                             cuts=[{'segment_index': 1, 'track_index': 2}], out='cut.aaf'))
        self.assertTrue(cut['verify']['ok'])
        self.assertEqual(pieces(cut, 'A2'), [(False, 40), (False, 60)])
        for bad in ([{'segment_index': 2, 'track_index': 0}], [{'segment_index': 0, 'track_index': 3}], ['x'], 'x'):
            with self.assertRaises(reader.ReaderError):
                writer.write_edit(self.request(path, info, segments, cuts=bad, out='bad.aaf'))

    def test_a_picture_track_plays_the_picture_of_its_audio_tracks_moment(self):
        """Two voices from different moments, stacked: V2 carries the picture
        of A2's moment over the second segment, the self-check compares it,
        and a group angle cannot be chosen on a picture track."""
        path, info = self.source()
        segments = [{'kind': 'source', 'source': 's1', 'in_frame': LEAD, 'out_frame': LEAD + 40},
                    {'kind': 'source', 'source': 's1', 'in_frame': LEAD + 40, 'out_frame': LEAD + 100}]
        tracks = [{'kind': 'sound', 'physical_track_number': 1, 'source_slots': {'s1': info['A1']}},
                  {'kind': 'sound', 'physical_track_number': 2, 'source_slots': {'s1': info['A2']}},
                  {'kind': 'picture', 'physical_track_number': 1, 'source_slots': {'s1': info['V1']}},
                  {'kind': 'picture', 'physical_track_number': 2, 'source_slots': {'s1': info['V1']}}]
        overrides = [{'segment_index': 1, 'track_index': 1, 'source': 's1', 'slot': info['A2'], 'in_frame': LEAD + 200},
                     {'segment_index': 1, 'track_index': 3, 'source': 's1', 'slot': info['V1'], 'in_frame': LEAD + 200}]
        mutes = [{'segment_index': 0, 'track_index': 3, 'from_frame': 0, 'to_frame': 40}]
        result = writer.write_edit(self.request(path, info, segments, tracks=tracks, schema_version=2, overrides=overrides, mutes=mutes))
        self.assertTrue(result['verify']['ok'])
        self.assertEqual([t['label'] for t in result['tracks']], ['A1', 'A2', 'V1', 'V2'])
        with aaf2.open(result['output'], 'r') as f:
            v2 = self.top(f).slot_at(result['tracks'][3]['slot_id']).segment
            self.assertEqual([type(c).__name__ for c in v2.components][0], 'Filler')
        with self.assertRaises(reader.ReaderError):
            writer.write_edit(self.request(path, info, segments, tracks=tracks, schema_version=2, out='bad.aaf',
                                           overrides=[{**overrides[1], 'choices': ['x:1']}]))

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

    def conformed(self, path, info, *, rates=('48000/1001', '60000/1001'), real_speed=True):
        """Segment 2's V1 group as HEAT 1's is: the cameras start on group
        frame 6001, two more run at 47.952 and 59.94 and play at real speed
        through Motion Control (SpeedRatio 1/2 and 2/5, placed as Media
        Composer places them, with the attributes it gives them), and the
        group records its angle order. With `real_speed` False the extra
        cameras run at the group's own rate, so the same SpeedRatio is slow
        motion."""
        G = GROUP_IN[1] + 1
        with aaf2.open(str(path), 'rw') as f:
            warp = f.create.OperationDef('6e5edbd3-5e2b-4f53-9c86-35c5b0a3a8f1', 'Motion Control')
            warp.media_kind = 'picture'; warp['NumberInputs'].value = 1; warp['IsTimeWarp'].value = True
            speed = f.create.ParameterDef('72559a80-24d7-11d3-8a50-0050040ef7d2', 'SpeedRatio', 'SpeedRatio', f.dictionary.lookup_typedef('Rational'))
            f.dictionary.register_def(speed); warp['ParametersDefined'].append(speed); f.dictionary.register_def(warp)
            group = self.top(f).slot_at(info['V1']).segment.components[2]
            plain = [group['Selected'].value, *group['Alternates'].value]
            for clip in plain:
                clip.start = G
            extra = []
            for rate in rates:
                ratio = Fraction(RATE) / Fraction(rate)
                camera = master(f, f'HFR {rate}', [('picture', 1)], 60000, rate=rate if real_speed else RATE)
                start = math.floor(G / ratio) if real_speed else G
                phase = math.ceil(start * ratio) / ratio - start if real_speed else 0
                clip = camera.create_source_clip(camera.slots[0].slot_id, start, math.ceil(phase + SEG2 / ratio), 'picture')
                inner = f.create.Sequence(media_kind='picture'); inner['Components'].append(clip); inner.length = clip.length
                # Media Composer's own (HEAT 1): the Sequence says which rate its frames are counted in.
                tags = TaggedValueHelper(inner['ComponentAttributeList'])
                tags['_MIXMATCH_RATE_NUM'], tags['_MIXMATCH_RATE_DENOM'] = map(int, rate.split('/'))
                op = f.create.OperationGroup(warp, length=SEG2, media_kind='picture')
                TaggedValueHelper(op['ComponentAttributeList'])['_MIXMATCH_MOTIONADAPTER'] = 2
                op['InputSegments'].append(inner)
                op['Parameters'].append(f.create.ConstantValue(speed, aaf2.rational.AAFRational(str(ratio))))
                extra.append(op)
                info.setdefault('hfr', []).append(str(camera.mob_id))
            # Angle order CAM A, CAM B, 47.952, 59.94; CAM B plays.
            group['Alternates'].value = [plain[1], *extra]
            TaggedValueHelper(group['ComponentAttributeList'])['_AAF_SELECTED'] = 1
        return G

    def test_a_camera_conformed_to_the_group_rate_keeps_its_place_in_the_group(self):
        # HEAT 1's V1 group has 75 angles and 45 are cameras like these. The
        # writer used to leave each one out with a warning, so Avid opened a
        # group of 30 (and HEAT 2's "slow-motion" camera was the same thing).
        path, info = self.source()
        G = self.conformed(path, info)
        result = writer.write_edit(self.request(path, info, [{'kind': 'source', 'source': 's1', 'in_frame': LEAD + SEG1 + 5, 'out_frame': LEAD + SEG1 + 50}]))
        self.assertTrue(result['verify']['ok'])
        self.assertGreaterEqual(result['verify']['groups_checked'], 1)
        self.assertFalse(any('left out' in w for w in result['warnings']), result['warnings'])
        with aaf2.open(result['output'], 'r') as f:
            v1 = self.top(f).slot_at(result['tracks'][0]['slot_id']).segment.components[0]
            self.assertEqual(value_name(v1), 'Selector')
            self.assertEqual(str(v1['Selected'].value.mob_id), info['cams'][1])
            self.assertEqual(v1['Selected'].value.start, G + 5)
            alternates = v1['Alternates'].value
            self.assertEqual([value_name(a) for a in alternates], ['SourceClip', 'OperationGroup', 'OperationGroup'])
            self.assertEqual(str(alternates[0].mob_id), info['cams'][0])
            self.assertEqual(writer.selected_index(v1, len(alternates)), 1)
            # Media Composer's trim: the head rounds down and the tail rounds
            # up, so 45 frames of 59.94 against a half-frame phase hold 113.
            for op, mob_id, ratio, rate in zip(alternates[1:], info['hfr'], (Fraction(1, 2), Fraction(2, 5)), (48000, 60000)):
                self.assertEqual(op.length, 45)
                self.assertEqual(Fraction(op['Parameters'].value[0].value), ratio)
                self.assertEqual(writer.attributes(op), (('_MIXMATCH_MOTIONADAPTER', '2'),))
                inner = op['InputSegments'].value[0]
                self.assertEqual(value_name(inner), 'Sequence')                       # Avid's one-clip Sequence
                # Without its rate, Media Composer counts the camera's frames at
                # the group's rate: wrong frames, then filler past the group's end.
                self.assertEqual(writer.attributes(inner), (('_MIXMATCH_RATE_DENOM', '1001'), ('_MIXMATCH_RATE_NUM', str(rate))))
                clip = inner.components[0]
                self.assertEqual(str(clip.mob_id), mob_id)
                first, last = math.floor((G + 5) / ratio), math.ceil((G + 50) / ratio)
                self.assertEqual((clip.start, clip.length, inner.length), (first, last - first, last - first))
            self.assertEqual(alternates[2]['InputSegments'].value[0].length, 113)
            for mob_id in info['hfr']:
                self.assertIsNotNone(f.content.mobs.get(aaf2.mobid.MobID(mob_id)))

    def test_playing_another_angle_moves_the_recorded_angle_and_keeps_the_order(self):
        # Avid lists a group's angles in order, without the one that plays,
        # and records where that one goes (_AAF_SELECTED). A copy that plays
        # another angle keeps the order and moves the index.
        path, info = self.source()
        with aaf2.open(str(path), 'rw') as f:
            group = self.top(f).slot_at(info['A1']).segment.components[2]          # R2 plays; R1, R3 alternate
            TaggedValueHelper(group['ComponentAttributeList'])['_AAF_SELECTED'] = 1
        result = writer.write_edit(self.request(path, info, [{'kind': 'source', 'source': 's1', 'in_frame': LEAD + SEG1 + 20, 'out_frame': LEAD + SEG1 + 80}],
                                                tracks=self.featured(info, 2)))
        self.assertTrue(result['verify']['ok'])
        with aaf2.open(result['output'], 'r') as f:
            top = self.top(f)
            kept, featured = (top.slot_at(t['slot_id']).segment.components[0] for t in result['tracks'])
            for sel, plays in ((kept, 1), (featured, 2)):
                angles, at = writer.angles_of(sel)
                self.assertEqual(at, plays)
                self.assertEqual([writer.angle_key(a)[0] for a in angles], info['recorders'])
                self.assertEqual(str(sel['Selected'].value.mob_id), info['recorders'][plays])

    def test_an_angle_that_changes_speed_stops_the_export_rather_than_leaving_the_group(self):
        path, info = self.source()
        self.conformed(path, info, rates=('48000/1001',), real_speed=False)
        with self.assertRaises(reader.ReaderError) as caught:
            writer.write_edit(self.request(path, info, [{'kind': 'source', 'source': 's1', 'in_frame': LEAD + SEG1 + 5, 'out_frame': LEAD + SEG1 + 50}]))
        self.assertIn('Angle 3 of 3 in this group cannot be copied exactly', str(caught.exception))
        self.assertIn('Motion Control changes speed', str(caught.exception))
        self.assertFalse((self.root / 'out.aaf').exists())

    def test_the_self_check_sees_an_angle_missing_from_a_group(self):
        path, info = self.source()
        self.conformed(path, info)
        result = writer.write_edit(self.request(path, info, [{'kind': 'source', 'source': 's1', 'in_frame': LEAD + SEG1 + 5, 'out_frame': LEAD + SEG1 + 50}]))
        with aaf2.open(str(path), 'r') as src, aaf2.open(result['output'], 'rw') as out:
            sources = {'s1': SimpleNamespace(identity='source', sequence=self.top(src))}
            top = out.content.mobs.get(aaf2.mobid.MobID(result['sequence_id']))
            self.assertGreaterEqual(writer.check_groups(top, sources, {}), 1)
            v1 = top.slot_at(result['tracks'][0]['slot_id']).segment.components[0]
            v1['Alternates'].value = v1['Alternates'].value[:-1]                    # Avid would open a group of 3
            with self.assertRaises(reader.ReaderError) as caught:
                writer.check_groups(top, sources, {})
            self.assertIn('do not match any group in the source', str(caught.exception))

    def test_the_self_check_sees_a_conform_lose_its_rate(self):
        """The trim of a conformed camera once dropped the `_MIXMATCH_RATE_*`
        attributes off its Sequence. Every frame still compared equal, since the
        reader counts by the clip's own slot, and Media Composer cut the wrong
        frames and substituted filler: only the group check can see it."""
        path, info = self.source()
        self.conformed(path, info)
        result = writer.write_edit(self.request(path, info, [{'kind': 'source', 'source': 's1', 'in_frame': LEAD + SEG1 + 5, 'out_frame': LEAD + SEG1 + 50}]))
        with aaf2.open(str(path), 'r') as src, aaf2.open(result['output'], 'rw') as out:
            sources = {'s1': SimpleNamespace(identity='source', sequence=self.top(src))}
            top = out.content.mobs.get(aaf2.mobid.MobID(result['sequence_id']))
            self.assertGreaterEqual(writer.check_groups(top, sources, {}), 1)
            v1 = top.slot_at(result['tracks'][0]['slot_id']).segment.components[0]
            inner = v1['Alternates'].value[-1]['InputSegments'].value[0]
            inner['ComponentAttributeList'].value = []
            with self.assertRaises(reader.ReaderError) as caught:
                writer.check_groups(top, sources, {})
            self.assertIn('do not match any group in the source', str(caught.exception))

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

    def kept_mute(self, approach='B', **extra):
        path, info = self.source()
        segments = [{'kind': 'source', 'source': 's1', 'in_frame': LEAD, 'out_frame': LEAD + 100}]
        mutes = [{'segment_index': 0, 'track_index': 2, 'from_frame': 10, 'to_frame': 40, 'keep': True}]
        return path, info, self.request(path, info, segments, approach=approach, mutes=mutes, **extra)

    def test_a_mute_the_editor_made_reaches_avid_as_its_muted_clip(self):
        """Read off Media Composer's own export of two muted clips (MUTE TEST,
        Media Composer 24.12, 2026-10-07): a Selector marked _DISABLE_CLIP_FLAG
        1 and _AAF_SELECTED 0, selecting Filler, with the clip untouched as its
        one alternate. Filler instead would leave nothing for Unmute Clip."""
        for approach in ('C', 'B'):
            with self.subTest(approach=approach):
                path, info, request = self.kept_mute(approach, out=f'kept-{approach}.aaf')
                kept = writer.write_edit(request)
                plain = writer.write_edit(dict(request, mutes=[], output_path=str(self.root / f'plain-{approach}.aaf')))
                self.assertTrue(kept['verify']['ok'])
                # It plays as silence, exactly where it did as filler.
                out = self.read(kept['output'], kept['sequence_id'])
                clips = {t['physical_track_number']: [(c['kind'], c['start_frame'], c['duration_frames']) for c in t['clips']] for t in self.main(out)}
                self.assertEqual(clips[2], [('audio', 0, 10), ('gap', 10, 30), ('audio', 40, 60)])
                with aaf2.open(kept['output'], 'r') as f, aaf2.open(plain['output'], 'r') as g:
                    slot = kept['tracks'][2]['slot_id']
                    wrappers = [c for c in self.top(f).slot_at(slot).segment.components if isinstance(c, Selector) and is_muted(c)]
                    self.assertEqual([w.length for w in wrappers], [30])
                    wrapper = wrappers[0]
                    # Media Composer's attributes, in its order and its encoding, byte for byte.
                    self.assertEqual([(t.name, t['Value'].data.hex()) for t in wrapper['ComponentAttributeList'].value], [
                        ('_DISABLE_CLIP_FLAG', '4c0007010100000000060e2b340104010101000000'),
                        ('_AAF_SELECTED', '4c0007010100000000060e2b340104010100000000')])
                    self.assertEqual((value_name(wrapper['Selected'].value), wrapper['Selected'].value.length, str(wrapper.media_kind)), ('Filler', 30, 'Sound'))
                    self.assertEqual(len(wrapper['Alternates'].value), 1)
                    # Unmuted, it plays what the edit without the mute plays there.
                    opened = writer.VerifyTimeline.open(f, kept['sequence_id'], 10000, opened=True)
                    unmuted = writer.VerifyTimeline.open(g, plain['sequence_id'], 10000)
                    track = lambda timeline, result: next(t for t in timeline.tracks if t['id'] == str(result['tracks'][2]['slot_id']))
                    self.assertEqual(list(writer.reader_frames(opened, track(opened, kept), 0, 100)),
                                     list(writer.reader_frames(unmuted, track(unmuted, plain), 0, 100)))

    def test_a_mute_nobody_made_is_still_filler(self):
        # A track with nobody on it in a clip is filler, as an Avid track the edit never touched.
        path, info, request = self.kept_mute()
        request['mutes'][0].pop('keep')
        result = writer.write_edit(request)
        with aaf2.open(result['output'], 'r') as f:
            parts = self.top(f).slot_at(result['tracks'][2]['slot_id']).segment.components
            self.assertFalse(any(isinstance(c, Selector) and is_muted(c) for c in parts))
            self.assertIn('Filler', [value_name(c) for c in parts])

    def test_the_self_check_opens_a_muted_clip(self):
        """Silence alone would pass a muted clip holding the wrong frames, or
        nothing: Unmute in Avid would bring back something else."""
        real = writer.mute_clip
        def late(component, dst, kind):
            first_clip(component).start += 1
            return real(component, dst, kind)
        def hollow(component, dst, kind):
            return real(dst.create.Filler(media_kind=kind, length=component.length), dst, kind)
        for broken in (late, hollow):
            with self.subTest(broken=broken.__name__):
                path, info, request = self.kept_mute(out=f'{broken.__name__}.aaf')
                with patch.object(writer, 'mute_clip', broken):
                    with self.assertRaises(reader.ReaderError) as error:
                        writer.write_edit(request)
                self.assertEqual(error.exception.code, 'verify_failed')
                self.assertIn('(muted)', str(error.exception))
                self.assertFalse((self.root / f'{broken.__name__}.aaf').exists())

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

    # ------------------------------------------------------------ group packs
    def grouped(self):
        path = self.root / 'group.aaf'
        return path, group_clip_fixture(path)

    def keep_picture(self, info):
        """String Outs' default: picture keeps its groups, sound is the clip that plays."""
        return [{'kind': 'picture', 'physical_track_number': 1, 'source_slots': {'s1': info['V1']}, 'approach': 'C'},
                {'kind': 'sound', 'physical_track_number': 1, 'source_slots': {'s1': info['A1']}},
                {'kind': 'sound', 'physical_track_number': 2, 'source_slots': {'s1': info['A2']}}]

    def bites(self):
        return [{'kind': 'source', 'source': 's1', 'in_frame': a, 'out_frame': b} for a, b in ((LEAD + 10, LEAD + 90), (LEAD + 200, LEAD + 260))]

    def packed(self, path, info, out, packs, approach='B', tracks='keep picture', segments=None):
        tracks = self.keep_picture(info) if tracks == 'keep picture' else tracks
        request = self.request(path, info, segments or self.bites(), approach=approach, tracks=tracks, out=out)
        if packs is not None:
            request['pack_dir'] = str(packs)
        return request

    def mob_ids(self, path):
        with aaf2.open(str(path), 'r') as f:
            return {str(key) for key in f.content.mobs.references}

    def plays(self, result):
        """Every frame of every track, as the reader and the picture walk see it."""
        manifest = self.read(result['output'], result['sequence_id'])
        with aaf2.open(result['output'], 'r') as f:
            top = f.content.mobs.get(aaf2.mobid.MobID(result['sequence_id']))
            picture = [list(writer.picture_frames(top.slot_at(t['slot_id']).segment, Fraction(RATE), 0, result['duration_frames']))
                       for t in result['tracks'] if t['kind'] == 'picture']
        return [t['clips'] for t in manifest['tracks']], picture

    def test_a_group_pack_export_is_the_full_export_mob_for_mob(self):
        path, info = self.grouped()
        for approach, tracks in (('B', 'keep picture'), ('C', None)):
            with self.subTest(approach=approach):
                packs = self.root / f'packs-{approach}'; packs.mkdir()
                full = writer.write_edit(self.packed(path, info, f'full-{approach}.aaf', None, approach, tracks))
                cold = writer.write_edit(self.packed(path, info, f'cold-{approach}.aaf', packs, approach, tracks))
                walked = []
                real = writer.check_references
                def recording(file, mobs, sources):
                    mobs = list(mobs); walked.append(len(mobs)); return real(file, mobs, sources)
                with patch.object(writer, 'check_references', recording):
                    warm = writer.write_edit(self.packed(path, info, f'warm-{approach}.aaf', packs, approach, tracks))
                self.assertIsNone(full['pack'])
                self.assertEqual((cold['pack'], warm['pack']), ({'built': True}, {'built': False}))
                self.assertEqual(walked, [1])                                   # only the new sequence is re-walked
                expected = self.mob_ids(full['output']) - {full['sequence_id']}
                self.assertTrue({info['group'], info['group_clip'], info['submaster'], *info['recorders'], *info['cams']} <= expected)
                self.assertNotIn(info['unused'], expected)
                # The pack is exactly the closure of the group clip, nothing else from the show.
                self.assertEqual(self.mob_ids(next(packs.glob('*.aaf'))), expected)
                for result in (cold, warm):
                    self.assertTrue(result['verify']['ok'])
                    self.assertEqual(self.mob_ids(result['output']) - {result['sequence_id']}, expected)
                    self.assertEqual((result['copied_mobs'], result['tracks']), (full['copied_mobs'], full['tracks']))
                    self.assertEqual(self.plays(result), self.plays(full))
                    with aaf2.open(result['output'], 'r') as f:
                        self.assertEqual([str(m.mob_id) for m in f.content.toplevel()], [result['sequence_id']])
                        self.assertEqual(len(list(f.content.essencedata)), 0)

    def test_the_comparison_and_the_self_check_catch_a_pack_missing_a_mob(self):
        """Break test for the test above: take one mob out of a built pack."""
        path, info = self.grouped()
        packs = self.root / 'packs'; packs.mkdir()
        full = writer.write_edit(self.packed(path, info, 'full.aaf', None))
        writer.write_edit(self.packed(path, info, 'cold.aaf', packs))
        pack = next(packs.glob('*.aaf'))
        # An angle nothing plays (the submaster's recorder): only mob-for-mob can see it go.
        drop_mob(pack, info['recorders'][3])
        short = writer.write_edit(self.packed(path, info, 'short.aaf', packs))
        self.assertNotEqual(self.mob_ids(short['output']) - {short['sequence_id']}, self.mob_ids(full['output']) - {full['sequence_id']})
        # The camera that plays: the self-check refuses it, nothing is published, the pack is not trusted again.
        drop_mob(pack, info['cams'][0])
        with self.assertRaises(reader.ReaderError) as error:
            writer.write_edit(self.packed(path, info, 'broken.aaf', packs))
        self.assertEqual(error.exception.code, 'verify_failed')
        self.assertFalse((self.root / 'broken.aaf').exists())
        self.assertEqual(list(packs.glob('*.aaf')), [])
        self.assertEqual(writer.write_edit(self.packed(path, info, 'rebuilt.aaf', packs))['pack'], {'built': True})

    def test_the_group_clip_avid_plays_a_group_through_travels_with_it(self):
        """Media Composer plays a group by following its sync mob's `_MATCH` to
        the group clip. Left behind, Avid refused to play the group: "PlayPipe::
        DoComp() encountered a missing mob" (HEAT 1, 2026-10-07)."""
        path, info = self.grouped()
        for packs in (None, self.root / 'packs'):
            with self.subTest(pack=packs is not None):
                if packs:
                    packs.mkdir()
                result = writer.write_edit(self.packed(path, info, f'out-{packs is not None}.aaf', packs, 'C', None))
                copied = self.mob_ids(result['output'])
                self.assertIn(info['group_clip'], copied)
                self.assertNotIn(info['nowhere'], copied)       # a chain ending outside the show, as Avid left it
                with aaf2.open(result['output'], 'r') as f:
                    group = f.content.mobs.get(aaf2.mobid.MobID(info['group']))
                    self.assertEqual([str(key) for key, slot in writer.mob_references(group) if slot is None], [info['group_clip']])
        # Break test: the same file without the group clip is refused by the self-check.
        broken = self.root / 'broken.aaf'
        broken.write_bytes(Path(result['output']).read_bytes())
        drop_mob(broken, info['group_clip'])
        with aaf2.open(str(path), 'r') as source, aaf2.open(str(broken), 'r') as out:
            with self.assertRaises(reader.ReaderError) as error:
                writer.check_references(out, out.content.mobs, [source])
        self.assertEqual(error.exception.code, 'verify_failed')
        self.assertIn(info['group_clip'], str(error.exception))

    def test_a_changed_source_gets_a_new_pack(self):
        path, info = self.grouped()
        packs = self.root / 'packs'; packs.mkdir()
        self.assertEqual(writer.write_edit(self.packed(path, info, 'one.aaf', packs))['pack'], {'built': True})
        self.assertEqual(writer.write_edit(self.packed(path, info, 'two.aaf', packs))['pack'], {'built': False})
        first = set(packs.glob('*.aaf'))
        stat = path.stat()
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
        self.assertEqual(writer.write_edit(self.packed(path, info, 'three.aaf', packs))['pack'], {'built': True})
        self.assertTrue(first < set(packs.glob('*.aaf')))
        self.assertEqual(len(list(packs.glob('*.aaf'))), 2)

    def test_a_half_written_pack_is_never_used(self):
        path, info = self.grouped()
        packs = self.root / 'packs'; packs.mkdir()
        # Killed between writing the pack and naming it: no pack, no leftover, no output.
        with patch.object(writer.os, 'replace', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                writer.write_edit(self.packed(path, info, 'crash.aaf', packs))
        self.assertEqual(list(packs.iterdir()), [])
        self.assertFalse((self.root / 'crash.aaf').exists())
        # A pack that fails its own check is never given its name either, and
        # the export never starts on it.
        with patch.object(writer, 'check_references', side_effect=reader.ReaderError('verify_failed', 'dangling')), \
                patch.object(writer, 'build', side_effect=AssertionError('the export started on an unchecked pack')):
            with self.assertRaises(reader.ReaderError):
                writer.write_edit(self.packed(path, info, 'unchecked.aaf', packs))
        self.assertEqual(list(packs.iterdir()), [])
        # Nor one whose file on disk lacks a mob the closure copied.
        real = writer.mob_closure
        with patch.object(writer, 'mob_closure', lambda *args: real(*args) + [info['unused']]):
            with self.assertRaises(reader.ReaderError) as error:
                writer.write_edit(self.packed(path, info, 'lost.aaf', packs))
        self.assertIn('lost a mob', str(error.exception))
        self.assertEqual(list(packs.iterdir()), [])
        # What a SIGKILL leaves behind, a temporary file holding part of a pack, is never opened.
        stray = packs / '.pack-killed.partial'
        stray.write_bytes(b'\0' * 4096)
        result = writer.write_edit(self.packed(path, info, 'after.aaf', packs))
        self.assertEqual(result['pack'], {'built': True})
        self.assertTrue(result['verify']['ok'])
        self.assertEqual(stray.read_bytes(), b'\0' * 4096)

    def test_mobs_from_a_pack_are_neither_copied_nor_walked(self):
        # The whole point of a pack: its mobs are not looked up in the source
        # again. Copying nothing is not enough; walking them is the cost.
        path, info = self.grouped()
        with aaf2.open(str(path), 'r') as src, aaf2.open() as dst:
            copied = writer.mob_closure(src, dst, [info['group']])
            self.assertTrue({info['group'], info['submaster'], *info['cams']} <= set(copied))
            looked = []
            mobs = src.content.mobs
            view = SimpleNamespace(content=SimpleNamespace(mobs=SimpleNamespace(get=lambda key: looked.append(key) or mobs.get(key))))
            self.assertEqual(writer.mob_closure(view, dst, [info['group'], info['recorders'][0]], frozenset(copied)), [])
            self.assertEqual(looked, [])

    def test_an_edit_that_refers_to_no_group_builds_no_pack(self):
        path, info = self.grouped()
        packs = self.root / 'packs'; packs.mkdir()
        result = writer.write_edit(self.packed(path, info, 'b.aaf', packs, 'B', None))
        self.assertIsNone(result['pack'])
        self.assertEqual(list(packs.iterdir()), [])

    def test_write_edits_opens_each_source_once_and_one_bad_edit_loses_nothing(self):
        path, info = self.grouped()
        packs = self.root / 'packs'; packs.mkdir()
        past_the_end = [{'kind': 'source', 'source': 's1', 'in_frame': 0, 'out_frame': info['total'] + 1}]
        batch = {'schema_version': 1, 'edits': [self.packed(path, info, 'rosa.aaf', packs),
                                                 self.packed(path, info, 'bad.aaf', packs, segments=past_the_end),
                                                 self.packed(path, info, 'dev.aaf', packs, segments=self.bites()[:1])]}
        real = aaf2.open
        with patch.object(aaf2, 'open', side_effect=real) as opened:
            done = writer.write_edits(batch)
        self.assertEqual(sum(1 for call in opened.call_args_list if call.args[:1] == (str(path),)), 1)
        first, bad, last = done['results']
        self.assertEqual((first['pack'], last['pack']), ({'built': True}, {'built': False}))
        self.assertTrue(first['verify']['ok'] and last['verify']['ok'])
        self.assertEqual(bad, {'error': {'code': 'invalid_input', 'message': bad['error']['message']}})
        self.assertIn('past the end', bad['error']['message'])
        self.assertEqual(sorted(p.name for p in self.root.glob('*.aaf')), ['dev.aaf', 'group.aaf', 'rosa.aaf'])
        self.assertEqual(len(list(packs.glob('*.aaf'))), 1)
        # The command line, and a malformed batch refused as a whole.
        for edit, out in zip(batch['edits'], ('rosa 2.aaf', 'bad 2.aaf', 'dev 2.aaf')):
            edit['output_path'] = str(self.root / out)
        request_path = self.root / 'batch.json'
        request_path.write_text(json.dumps(batch))
        command = [sys.executable, str(Path(reader.__file__)), 'write-edits', '--request', str(request_path)]
        ran = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(ran.returncode, 0, ran.stderr)
        self.assertEqual([sorted(r) == ['error'] for r in json.loads(ran.stdout)['results']], [False, True, False])
        for wrong in ({'schema_version': 2, 'edits': batch['edits']}, {'schema_version': 1, 'edits': []}, []):
            with self.assertRaises(reader.ReaderError) as error:
                writer.write_edits(wrong)
            self.assertEqual(error.exception.code, 'invalid_input')

    def test_stop_ends_the_whole_batch(self):
        path, info = self.grouped()
        batch = {'schema_version': 1, 'edits': [self.packed(path, info, 'a.aaf', None), self.packed(path, info, 'b.aaf', None)]}
        with patch.object(writer.Session, 'write', side_effect=[{'output': 'a'}, reader.ReaderError('cancelled', 'Stopped.')]):
            with self.assertRaises(reader.ReaderError) as error:
                writer.write_edits(batch)
        self.assertEqual(error.exception.code, 'cancelled')

    def test_drop_frame_timecode_text(self):
        self.assertEqual(writer.timecode(1800, 30, True), '00:01:00;02')
        self.assertEqual(writer.timecode(17982, 30, True), '00:10:00;00')
        self.assertEqual(writer.timecode(86400 + 58, 24, False), '01:00:02:10')


def value_name(component):
    return type(component).__name__


def first_clip(component):
    """The first SourceClip under a component, depth first."""
    if isinstance(component, SourceClip):
        return component
    children = [value_of(component, 'Selected')] + [child for key in ('InputSegments', 'Components', 'Alternates') for child in (value_of(component, key) or [])]
    return next((found for found in (first_clip(child) for child in children if child is not None) if found is not None), None)


def value_of(component, key):
    return component[key].value if key in component else None


def drop_mob(path, mob_id):
    with aaf2.open(str(path), 'rw') as f:
        f.content.mobs.pop(aaf2.mobid.MobID(mob_id))


if __name__ == '__main__':
    unittest.main()
