"""Generated AAF graph fixtures. No production media is changed or required."""
from fractions import Fraction
from pathlib import Path
import io
import json
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
import wave
import aaf2
import reader
from graph import GraphTimeline
from test_reader import fixture


def grouped_fixture(path, *, embedded=False, alternatives=3, roots=1, rate='24000/1001', multiple=False, frames=48, audible=False):
    """Two-channel files with unequal channels catch accidental mixdown/routing."""
    hz = 48000
    samples = reader.round_sample(Fraction(frames*hz, 1)/Fraction(rate))
    data = b''.join((1200).to_bytes(2,'little',signed=True) + (-2400).to_bytes(2,'little',signed=True) for _ in range(samples))
    if audible:
        import math
        data = b''.join(round(1800*math.sin(i/hz*math.tau*220)).to_bytes(2,'little',signed=True)
                        + round(3000*math.sin(i/hz*math.tau*440)).to_bytes(2,'little',signed=True) for i in range(samples))
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wav:
        wav.setnchannels(2); wav.setsampwidth(2); wav.setframerate(hz); wav.writeframes(data)
    with aaf2.open(str(path),'w') as file:
        comp = file.create.CompositionMob('Group fixture'); comp['UsageCode'].value = 'Usage_TopLevel'; file.content.mobs.append(comp)
        timecode = comp.create_timeline_slot(rate); timecode.segment = file.create.Timecode(fps=24, length=frames); timecode.segment.start = 86400
        for root in range(roots):
            choices = []
            for branch in range(alternatives+1):
                source = file.create.SourceMob(f'Recorder {root}-{branch}'); file.content.mobs.append(source)
                slot = source.create_timeline_slot(rate); slot['PhysicalTrackNumber'].value = 2
                slot.segment = file.create.Filler(media_kind='sound',length=frames)
                if embedded:
                    desc = file.create.WAVEDescriptor(); desc['Summary'].value = list(buf.getvalue()[:44]); desc['SampleRate'].value = hz; desc['Length'].value = samples
                    essence = file.create.EssenceData(); essence.mob_id = source.mob_id; file.content.essencedata.append(essence); essence.open('w').write(buf.getvalue())
                else:
                    desc = file.create.PCMDescriptor()
                    for key,value in {'Channels':2,'BlockAlign':4,'SampleRate':hz,'AudioSamplingRate':hz,'AverageBPS':hz*4,'QuantizationBits':16,'Length':samples}.items(): desc[key].value=value
                    wavpath = path.parent/f'microphone-{root}-{branch}.wav'; wavpath.write_bytes(buf.getvalue())
                    loc = file.create.NetworkLocator(); loc['URLString'].value = wavpath.as_uri(); desc['Locator'].append(loc)
                source.descriptor=desc
                master = file.create.MasterMob(f'Roll {root}-{branch}'); master.comments['TRK1']=f'Mic {root}-{branch}'; file.content.mobs.append(master)
                ms = master.create_timeline_slot(rate); ms.segment=source.create_source_clip(slot.slot_id,0,frames,'sound')
                choices.append(master.create_source_clip(ms.slot_id,3,frames-6,'sound'))
            selector = file.create.Selector(media_kind='sound',length=frames-6)
            selector['Selected'].value=choices[0]; selector['Alternates'].extend(choices[1:])
            track = comp.create_sound_slot(rate); track['PhysicalTrackNumber'].value=root+1
            track.segment.components.extend([file.create.Filler(media_kind='sound',length=3), selector, file.create.Filler(media_kind='sound',length=3)])
            track.segment.length=frames
        if multiple:
            other=comp.copy(); other.mob_id=aaf2.mobid.MobID.new(); other.name='Other sequence'; file.content.mobs.append(other)


DNXHD = '0e040201-0204-0100-060e-2b3404010101'


def picture_chain(file, rate, clip_name, tape_name, tc_start, tape_offset, frames=400):
    """Tape SourceMob (timecode slot) <- file SourceMob (CDCI) <- MasterMob."""
    tape = file.create.SourceMob(tape_name); tape.descriptor = file.create.TapeDescriptor(); file.content.mobs.append(tape)
    tape_slot = tape.create_timeline_slot(rate); tape_slot.segment = file.create.Filler(media_kind='picture', length=frames*10)
    tc_slot = tape.create_timeline_slot(rate); tc_slot['PhysicalTrackNumber'].value = 1
    tc_slot.segment = file.create.Timecode(fps=24, length=frames*10); tc_slot.segment.start = tc_start
    media = file.create.SourceMob(clip_name + '.new.01'); file.content.mobs.append(media)
    desc = file.create.CDCIDescriptor()
    for key, raw in {'StoredWidth': 1920, 'StoredHeight': 1080, 'FrameLayout': 'FullFrame', 'SampleRate': rate,
                     'Length': frames, 'ComponentWidth': 8, 'HorizontalSubsampling': 2,
                     'VideoLineMap': [42, 0], 'ImageAspectRatio': '16/9'}.items():
        desc[key].value = raw
    desc['Compression'].value = aaf2.auid.AUID(DNXHD)
    media.descriptor = desc
    media_slot = media.create_timeline_slot(rate); media_slot.segment = tape.create_source_clip(tape_slot.slot_id, tape_offset, frames, 'picture')
    master = file.create.MasterMob(clip_name); file.content.mobs.append(master)
    master_slot = master.create_timeline_slot(rate); master_slot.segment = media.create_source_clip(media_slot.slot_id, 0, frames, 'picture')
    return master, master_slot, media


def add_picture_track(path, *, kind='picture', wrap=None):
    """V1: 3 frames of filler, 20 frames of A from 10, 22 frames of B, 3 of filler."""
    rate = '24000/1001'
    with aaf2.open(str(path), 'rw') as file:
        comp = next(file.content.toplevel())
        a, a_slot, media_a = picture_chain(file, rate, 'Interview A', 'TAPE A', 86400, 500)
        b, b_slot, media_b = picture_chain(file, rate, 'Interview B', 'TAPE B', 90000, 0)
        clip_a = a.create_source_clip(a_slot.slot_id, 10, 20, 'picture')
        clip_b = b.create_source_clip(b_slot.slot_id, 0, 22, 'picture')
        if wrap:
            clip_b = wrap(file, clip_b, clip_a)
        track = comp.create_timeline_slot(rate); track['PhysicalTrackNumber'].value = 1; track.name = 'V1'
        sequence = file.create.Sequence(media_kind=kind)
        sequence.components.extend([file.create.Filler(media_kind=kind, length=3), clip_a, clip_b, file.create.Filler(media_kind=kind, length=3)])
        track.segment = sequence
        return {'a': str(a.mob_id), 'b': str(b.mob_id), 'media_a': str(media_a.mob_id), 'media_b': str(media_b.mob_id)}


def mute(file, segment, media_kind='sound', scope=False):
    """How Avid writes a muted clip: a Selector selecting Filler, real clip in Alternates."""
    muted = file.create.Selector(media_kind=media_kind, length=segment.length)
    if scope:
        silence = file.create.ScopeReference(); silence.media_kind = media_kind; silence.length = segment.length
        silence['RelativeScope'].value = 0; silence['RelativeSlot'].value = 1
    else:
        silence = file.create.Filler(media_kind=media_kind, length=segment.length)
    muted['Selected'].value = silence; muted['Alternates'].append(segment)
    return muted


class GraphTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='sauce-graph-'); self.root=Path(self.temp.name)
    def tearDown(self): self.temp.cleanup()
    def read(self,path):
        with aaf2.open(str(path),'r') as file: return GraphTimeline(file).manifest(reader.fingerprint(path))
    def test_offline_groups_keep_selected_branch_alternatives_trims_and_gaps(self):
        path=self.root/'group.aaf'; grouped_fixture(path)
        for wav in self.root.glob('*.wav'): wav.unlink()
        data=self.read(path)
        self.assertEqual(len(data['tracks']),4); self.assertEqual(len(data['graph']['sources']),4)
        self.assertEqual([t['name'] for t in data['tracks']],['Mic 0-0','Mic 0-1','Mic 0-2','Mic 0-3'])
        self.assertTrue(all(l['availability']=='offline' for l in data['graph']['lanes']))
        self.assertEqual([c['kind'] for c in data['tracks'][1]['clips']],['gap','audio','gap'])
        self.assertEqual(data['graph']['positions'][0]['numerator'],6006)
        self.assertTrue(all(s['channel']==1 and s['channels']==2 for s in data['graph']['sources']))
        self.assertEqual(data['graph']['lanes'][1]['parent_track_id'],data['tracks'][0]['id'])
        self.assertEqual([t['id'] for t in data['tracks']],[t['id'] for t in self.read(path)['tracks']])
    def test_98_lanes_are_distinct_and_not_subject_to_64_root_limit(self):
        path=self.root/'98.aaf'; grouped_fixture(path,roots=14,alternatives=6)
        data=self.read(path)
        self.assertEqual(len(data['tracks']),98); self.assertEqual(len({t['id'] for t in data['tracks']}),98)
        self.assertEqual(sum(l['parent_track_id'] is None for l in data['graph']['lanes']),14)
    def test_expanded_lane_limit_and_cycles_are_bounded_failures(self):
        path=self.root/'too-many.aaf'; grouped_fixture(path,roots=37,alternatives=6)
        with self.assertRaises(reader.ReaderError) as error: self.read(path)
        self.assertEqual(error.exception.code,'limit_exceeded')
        path=self.root/'cycle.aaf'; grouped_fixture(path,alternatives=0)
        with aaf2.open(str(path),'rw') as file:
            comp=next(file.content.toplevel()); track=next(s for s in comp.slots if s.segment.media_kind=='Sound')
            track.segment=comp.create_source_clip(track.slot_id,0,48,'sound')
        with self.assertRaises(reader.ReaderError) as error: self.read(path)
        self.assertEqual(error.exception.code,'invalid_media')
    def test_embedded_multichannel_isolated_by_source_slot(self):
        path=self.root/'embedded.aaf'; grouped_fixture(path,embedded=True)
        with aaf2.open(str(path),'r') as file:
            timeline=GraphTimeline(file)
            for track in timeline.tracks:
                data=b''.join(timeline.blocks(track,3,42))
                self.assertEqual(data,(-2400).to_bytes(2,'little',signed=True)*(42*2002))
    def test_marker_whose_described_slots_has_no_data_does_not_fail_the_import(self):
        # Media Composer 23.12 writes a span marker on the timecode track with
        # DescribedSlots present but empty. pyaaf2 will not WRITE a property
        # with no data, so the fixture blanks it in memory before reading.
        path=self.root/'markers.aaf'; grouped_fixture(path)
        with aaf2.open(str(path),'rw') as file:
            comp=next(file.content.toplevel()); slot=comp.create_timeline_slot('24000/1001')
            markers=file.create.Sequence(media_kind='DescriptiveMetadata')
            marker=file.create.DescriptiveMarker(); marker['Position'].value=12; marker['Comment'].value='Span on the timecode track'
            marker['DescribedSlots'].value={1}; markers.components.append(marker); slot.segment=markers
            file.dictionary.lookup_datadef('DescriptiveMetadata').name='Descriptive Metadata'
        with aaf2.open(str(path),'r') as file:
            comp=next(file.content.toplevel())
            blank=next(s for s in comp.slots if s.segment.media_kind.lower()=='descriptive metadata')
            next(iter(blank.segment.components))['DescribedSlots'].data=None
            data=GraphTimeline(file).manifest(reader.fingerprint(path))
        self.assertEqual(data['graph']['markers'],[{'position':12,'comment':'Span on the timecode track','described_slots':[],'attributes':{}}])
    def test_legacy_embedded_track_ids_and_bytes_unchanged(self):
        path=self.root/'legacy.aaf'; fixture(path)
        with aaf2.open(str(path),'r') as file:
            old=reader.Timeline(file); new=GraphTimeline(file)
            self.assertEqual(old.tracks[0]['id'],new.tracks[0]['id'])
            self.assertEqual(b''.join(old.blocks(old.tracks[0],0,10)),b''.join(new.blocks(new.tracks[0],0,10)))
    def test_multiple_sequences_offer_explicit_choice_and_structured_error(self):
        path=self.root/'multi.aaf'; grouped_fixture(path,multiple=True)
        base=[sys.executable,str(Path(reader.__file__))]
        result=subprocess.run(base+['sequences','--input',str(path)],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr); choices=json.loads(result.stdout); self.assertEqual(len(choices),2)
        result=subprocess.run(base+['inspect','--graph','--input',str(path)],capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0); self.assertIn('choose_sequence',result.stderr); self.assertNotIn('Traceback',result.stderr)
        result=subprocess.run(base+['inspect','--graph','--input',str(path),'--sequence',choices[1]['id']],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
    def test_a_bin_with_more_than_64_sequences_can_be_chosen_from_and_opened(self):
        path=self.root/'bin.aaf'; grouped_fixture(path)
        with aaf2.open(str(path),'rw') as file:
            wanted=str(next(file.content.toplevel()).mob_id)
            for index in range(70):
                extra=file.create.CompositionMob(f'Extra {index}'); extra['UsageCode'].value='Usage_TopLevel'; file.content.mobs.append(extra)
        base=[sys.executable,str(Path(reader.__file__))]
        result=subprocess.run(base+['sequences','--input',str(path)],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr); self.assertEqual(len(json.loads(result.stdout)),71)
        with aaf2.open(str(path),'r') as file:
            self.assertEqual(GraphTimeline(file,wanted).manifest(reader.fingerprint(path))['graph']['sequence_id'],wanted)
    def test_unsupported_operation_is_not_silence_or_a_whole_file_rejection(self):
        path=self.root/'effect.aaf'; grouped_fixture(path)
        with aaf2.open(str(path),'rw') as file:
            track=next(s for s in next(file.content.toplevel()).slots if s.segment.media_kind=='Sound')
            op=file.create.OperationDef('11111111-1111-1111-1111-111111111111','Unknown time effect'); op.media_kind='sound'; op['NumberInputs'].value=0; file.dictionary.register_def(op)
            wrapped=file.create.OperationGroup(op,length=3,media_kind='sound')
            track.segment.components[0]=wrapped
        data=self.read(path)
        self.assertEqual(data['tracks'][0]['clips'][0]['kind'],'unavailable')
        self.assertEqual(data['tracks'][0]['clips'][1]['kind'],'audio')

    def test_nested_alternatives_inside_an_unselected_branch_are_discovered(self):
        path=self.root/'nested.aaf'; grouped_fixture(path,alternatives=2)
        with aaf2.open(str(path),'rw') as file:
            track=next(s for s in next(file.content.toplevel()).slots if s.segment.media_kind=='Sound')
            outer=track.segment.components[1]
            choices=list(outer['Alternates'].value)
            inner=file.create.Selector(media_kind='sound',length=42)
            inner['Selected'].value=choices[0].copy(); inner['Alternates'].append(choices[1].copy())
            outer['Alternates'].value=[inner]
        data=self.read(path)
        self.assertEqual(len(data['tracks']),3)
        self.assertEqual([t['name'] for t in data['tracks']],['Mic 0-0','Mic 0-1','Mic 0-2'])
        self.assertEqual(len({t['id'] for t in data['tracks']}),3)

    def test_linked_wave_summary_and_descriptor_edit_rate(self):
        path=self.root/'summary.aaf'; grouped_fixture(path,alternatives=0)
        with aaf2.open(str(path),'rw') as file:
            source=next(file.content.sourcemobs()); old=source.descriptor
            desc=file.create.WAVEDescriptor(); desc['Summary'].value=list((self.root/'microphone-0-0.wav').read_bytes()[:44])
            desc['SampleRate'].value='24000/1001'; desc['Length'].value=48
            desc['Locator'].extend([loc.copy() for loc in old['Locator'].value]); source.descriptor=desc
        source=self.read(path)['graph']['sources'][0]
        self.assertEqual((source['sample_count'],source['sample_rate'],source['sample_width'],source['channel']),(96096,48000,2,1))

    def test_transition_preserves_timing_and_only_disables_overlap(self):
        path=self.root/'transition.aaf'; grouped_fixture(path,alternatives=0)
        with aaf2.open(str(path),'rw') as file:
            track=next(s for s in next(file.content.toplevel()).slots if s.segment.media_kind=='Sound')
            original=track.segment.components[1]['Selected'].value
            left=original.copy(); left.length=24; right=original.copy(); right.start=20; right.length=28
            transition=file.create.Transition(media_kind='sound',length=4)
            transition['CutPoint'].value=2
            op=file.create.OperationDef('11111111-1111-1111-1111-111111111112','Test crossfade'); op.media_kind='sound'; op['NumberInputs'].value=2; file.dictionary.register_def(op)
            transition['OperationGroup'].value=file.create.OperationGroup(op,length=4,media_kind='sound')
            track.segment.components.value=[left,transition,right]; track.segment.length=48
        clips=self.read(path)['tracks'][0]['clips']
        self.assertEqual([(c['kind'],c['start_frame'],c['duration_frames']) for c in clips],[('audio',0,20),('unavailable',20,4),('audio',24,24)])

    def test_legacy_sound_and_picture_slots_are_read(self):
        path=self.root/'legacy-kinds.aaf'; grouped_fixture(path,alternatives=0)
        add_picture_track(path, kind='LegacyPicture')
        with aaf2.open(str(path),'rw') as file:
            track=next(s for s in next(file.content.toplevel()).slots if s.segment.media_kind=='Sound')
            for component in [track.segment,*track.segment.components]: component.media_kind='LegacySound'
        with aaf2.open(str(path),'r') as file:
            kinds=sorted(s.segment.media_kind for s in next(file.content.toplevel()).slots)
        self.assertIn('LegacySound',kinds); self.assertIn('LegacyPicture',kinds)
        data=self.read(path)
        self.assertEqual([t['name'] for t in data['tracks']],['Mic 0-0'])
        self.assertEqual([c['kind'] for c in data['tracks'][0]['clips']],['gap','audio','gap'])
        self.assertEqual(len(data['graph']['picture_tracks']),1)
        self.assertEqual([c['name'] for c in data['graph']['picture_tracks'][0]['clips']],['Interview A','Interview B'])

    def test_muted_clip_is_silence_not_a_group(self):
        for scope in (False, True):
            with self.subTest(scope=scope):
                path=self.root/f'muted-{scope}.aaf'; grouped_fixture(path,alternatives=2)
                with aaf2.open(str(path),'rw') as file:
                    track=next(s for s in next(file.content.toplevel()).slots if s.segment.media_kind=='Sound')
                    clip=track.segment.components[1]['Selected'].value.copy()
                    track.segment.components[1]=mute(file,clip,scope=scope)
                data=self.read(path)
                self.assertEqual(len(data['tracks']),1)
                self.assertEqual([c['kind'] for c in data['tracks'][0]['clips']],['gap','gap','gap'])
                self.assertTrue(all(l['parent_track_id'] is None for l in data['graph']['lanes']))
                self.assertIn('Muted clip in Avid: it plays as silence here too.',data['tracks'][0]['warnings'])

    def test_picture_clips_are_metadata_with_tape_timecode_and_descriptor(self):
        path=self.root/'picture.aaf'; grouped_fixture(path,alternatives=0); ids=add_picture_track(path)
        data=self.read(path); picture=data['graph']['picture_tracks']
        self.assertEqual(len(picture),1)
        self.assertEqual((picture[0]['name'],picture[0]['physical_track_number']),('V1',1))
        a,b=picture[0]['clips']
        self.assertEqual((a['start_frame'],a['duration_frames'],a['kind']),(3,20,'clip'))
        self.assertEqual((b['start_frame'],b['duration_frames']),(23,22))
        self.assertEqual((a['name'],a['master_mob_id'],a['file_mob_id'],a['tape_name']),('Interview A',ids['a'],ids['media_a'],'TAPE A'))
        self.assertEqual((b['name'],b['master_mob_id'],b['file_mob_id'],b['tape_name']),('Interview B',ids['b'],ids['media_b'],'TAPE B'))
        # Tape timecode + the tape offset the file mob starts at + the clip's source in.
        self.assertEqual((a['source_start_frame'],a['source_timecode_fps'],a['source_drop_frame']),(86400+500+10,24,False))
        self.assertEqual(b['source_start_frame'],90000)
        self.assertEqual(a['descriptor'],{'kind':'CDCIDescriptor','sample_rate':'24000/1001','stored_width':1920,
            'stored_height':1080,'frame_layout':'FullFrame','compression':DNXHD})
        self.assertFalse(a['group']); self.assertIsNone(a['effect'])
        # Picture never becomes an audio lane or a source to relink.
        self.assertEqual(len(data['tracks']),1); self.assertEqual(len(data['graph']['sources']),1)

    def test_picture_group_records_the_selected_angle_and_muted_picture_is_not_a_group(self):
        def group(file, clip_b, clip_a):
            selector=file.create.Selector(media_kind='picture',length=clip_b.length)
            other=clip_a.copy(); other.length=clip_b.length
            selector['Selected'].value=clip_b; selector['Alternates'].append(other); return selector
        path=self.root/'picture-group.aaf'; grouped_fixture(path,alternatives=0); add_picture_track(path,wrap=group)
        clip=self.read(path)['graph']['picture_tracks'][0]['clips'][1]
        self.assertEqual((clip['kind'],clip['group'],clip['name'],clip['tape_name']),('clip',True,'Interview B','TAPE B'))
        path=self.root/'picture-muted.aaf'; grouped_fixture(path,alternatives=0)
        add_picture_track(path,wrap=lambda file,clip_b,clip_a: mute(file,clip_b,'picture'))
        data=self.read(path)
        clip=data['graph']['picture_tracks'][0]['clips'][1]
        self.assertEqual((clip['kind'],clip['group'],clip['name'],clip['start_frame']),('muted',False,'Interview B',23))
        self.assertEqual(len(data['tracks']),1)

    def test_picture_clip_count_is_bounded_without_failing_audio(self):
        import picture
        path=self.root/'picture-bound.aaf'; grouped_fixture(path,alternatives=0); add_picture_track(path)
        with unittest.mock.patch.object(picture,'MAX_PICTURE_CLIPS',1):
            data=self.read(path)
        self.assertEqual(len(data['graph']['picture_tracks'][0]['clips']),1)
        self.assertIn('A picture track has more clips than are read. The rest of its cuts are not shown.',data['warnings'])
        with unittest.mock.patch.object(picture,'MAX_PICTURE_STEPS',3):
            data=self.read(path)
        self.assertEqual(data['graph']['picture_tracks'][0]['clips'],[])
        self.assertIn('The picture tracks are too complex to read fully. Audio is not affected.',data['warnings'])
        self.assertEqual([c['kind'] for c in data['tracks'][0]['clips']],['gap','audio','gap'])

if __name__=='__main__': unittest.main()
