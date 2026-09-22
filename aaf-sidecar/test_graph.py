"""Generated AAF graph fixtures. No production media is changed or required."""
from fractions import Fraction
from pathlib import Path
import io
import json
import subprocess
import sys
import tempfile
import unittest
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

if __name__=='__main__': unittest.main()
