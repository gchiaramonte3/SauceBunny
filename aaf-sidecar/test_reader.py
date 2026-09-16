"""Synthetic, local-only fixtures. No user media or network is needed."""
from fractions import Fraction
import hashlib
import io
import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave

import aaf2
import reader


def fixture(path, *, rate='24000/1001', gap=True, origin=0, drop=False, raw=False):
    fps = Fraction(rate)
    sample_count = reader.round_sample(Fraction(12,1)*48000/fps)
    pcm = b''.join(((i % 2000)-1000).to_bytes(3,'little',signed=True) for i in range(sample_count))
    buf = io.BytesIO()
    with wave.open(buf,'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(3); wav.setframerate(48000)
        wav.writeframes(pcm)
    blob = buf.getvalue()
    with aaf2.open(str(path),'w') as file:
        source = file.create.SourceMob('Synthetic essence')
        file.content.mobs.append(source)
        essence, source_slot = source.create_essence(rate,'sound')
        source_slot.segment.length = 12
        if raw:
            descriptor = file.create.PCMDescriptor()
            for k,v in {'Channels':1,'BlockAlign':3,'SampleRate':48000,'AverageBPS':144000,'QuantizationBits':24,'AudioSamplingRate':48000,'Length':sample_count}.items():
                descriptor[k].value = v
        else:
            descriptor = file.create.WAVEDescriptor()
            descriptor['Summary'].value = list(blob[:44])
            descriptor['SampleRate'].value = 48000
            descriptor['Length'].value = sample_count
        source.descriptor = descriptor
        essence.open('w').write(pcm if raw else blob)
        master = file.create.MasterMob('Synthetic microphone')
        master.comments['TRK1'] = 'ALPHA'
        file.content.mobs.append(master)
        ms = master.create_timeline_slot(rate)
        ms.segment = source.create_source_clip(1,0,12,'sound')
        comp = file.create.CompositionMob('Synthetic sequence')
        comp['UsageCode'].value = 'Usage_TopLevel'
        file.content.mobs.append(comp)
        ts = comp.create_timeline_slot(rate)
        ts.segment = file.create.Timecode(fps=30 if drop else 24,drop=drop,length=12)
        ts.segment.start = 1613255
        track = comp.create_sound_slot(rate)
        track.origin = origin
        track['PhysicalTrackNumber'].value = 1
        track.segment.components.append(master.create_source_clip(ms.slot_id,2,4,'sound'))
        if gap:
            track.segment.components.append(file.create.Filler(media_kind='sound',length=2))
        track.segment.components.append(master.create_source_clip(ms.slot_id,6,4,'sound'))
        track.segment.length = 10 if gap else 8
        return str(track.slot_id),pcm


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sauce-aaf-test-')
        self.root = Path(self.temp.name)
        self.aaf = self.root/'sample.aaf'
        self.track_id,self.pcm = fixture(self.aaf)

    def tearDown(self):
        self.temp.cleanup()

    def command(self, *args):
        return subprocess.run([sys.executable,str(Path(reader.__file__)),'--version'] if not args else [sys.executable,str(Path(reader.__file__)),*args],capture_output=True,text=True,timeout=15)

    def test_inspect_names_rational_timing_and_gaps(self):
        result = self.command('inspect','--input',str(self.aaf))
        self.assertEqual(result.returncode,0,result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data['schema_version'],1)
        self.assertEqual(data['start_frame'],1613255)
        self.assertEqual(data['edit_rate'],{'numerator':24000,'denominator':1001})
        self.assertEqual(data['tracks'][0]['name'],'ALPHA')
        self.assertEqual(data['tracks'][0]['physical_track_number'],1)
        self.assertNotEqual(data['tracks'][0]['id'],'1')
        self.assertEqual([c['kind'] for c in data['tracks'][0]['clips']],['audio','gap','audio'])
        self.assertEqual(data['tracks'][0]['clips'][0]['source_start_sample'],4004)

    def test_physical_track_number_is_not_slot_id_or_audio_order(self):
        with aaf2.open(str(self.aaf), 'rw') as file:
            next(file.content.toplevel()).slot_at(int(self.track_id))['PhysicalTrackNumber'].value = 7
        result = self.command('inspect', '--input', str(self.aaf))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['tracks'][0]['physical_track_number'], 7)

    def test_missing_track_number_is_unknown_not_slot_id(self):
        with aaf2.open(str(self.aaf), 'rw') as file:
            del next(file.content.toplevel()).slot_at(int(self.track_id))['PhysicalTrackNumber']
        result = self.command('inspect', '--input', str(self.aaf))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(json.loads(result.stdout)['tracks'][0]['physical_track_number'])

    def test_index_extents_reproduce_pcm_and_keep_exact_positions(self):
        result = self.command('index','--input',str(self.aaf))
        self.assertEqual(result.returncode,0,result.stderr)
        data = json.loads(result.stdout)
        with self.aaf.open('rb') as file, aaf2.open(str(self.aaf),'r') as parsed:
            timeline = reader.Timeline(parsed)
            for key, source in data['sources'].items():
                content = bytearray()
                for offset, count in source['extents']:
                    file.seek(offset); content.extend(file.read(count))
                self.assertEqual(content, timeline.essence[key].open('r').read())
        self.assertEqual(data['tracks'][0]['clips'][0]['source_sample_position'], {'numerator':4004,'denominator':1})

    def test_extents_cover_short_mini_and_fragmented_normal_streams(self):
        for size in (65, 511, 3500, 4097, 24000):
            path = self.root / f'sectors-{size}.cfb'
            expected = bytes(index % 251 for index in range(size))
            with path.open('w+b') as file:
                storage = aaf2.cfb.CompoundFileBinary(file, 'wb+')
                stream = storage.open('/audio', 'w')
                stream.write(expected[:size//2])
                storage.open('/interruption', 'w').write(b'x'*10000)
                stream.write(expected[size//2:]); storage.close()
            with path.open('rb') as file:
                storage = aaf2.cfb.CompoundFileBinary(file, 'rb')
                runs = reader.stream_extents(storage.open('/audio','r'))
                actual = bytearray()
                for offset, count in runs:
                    file.seek(offset); actual.extend(file.read(count))
                self.assertEqual(actual, expected)

    def test_exact_extraction_handles_and_silence(self):
        out,peaks = self.root/'excerpt.wav',self.root/'peaks.json'
        result = self.command('extract','--input',str(self.aaf),'--track',self.track_id,'--start-frame','2','--duration-frames','6','--output',str(out),'--peaks-output',str(peaks))
        self.assertEqual(result.returncode,0,result.stderr)
        with wave.open(str(out),'rb') as wav:
            self.assertEqual(wav.getnframes(),6*2002)
            actual = wav.readframes(wav.getnframes())
        expected = self.pcm[4*2002*3:6*2002*3]+bytes(2*2002*3)+self.pcm[6*2002*3:8*2002*3]
        self.assertEqual(actual,expected)
        p = json.loads(peaks.read_text())
        self.assertLessEqual(len(p['peaks']),reader.PEAK_BUCKETS)
        self.assertTrue(any(low<0 and high>0 for low,high in p['peaks']))
        self.assertTrue(any(low==high==0 for low,high in p['peaks']))

    def test_full_waveform_no_audio_file(self):
        out = self.root/'waveform.json'
        result = self.command('peaks','--input',str(self.aaf),'--track',self.track_id,'--output',str(out))
        self.assertEqual(result.returncode,0,result.stderr)
        data = json.loads(out.read_text())
        self.assertEqual(data['sample_count'],10*2002)
        self.assertTrue(data['peaks'])
        self.assertLessEqual(len(data['peaks']),2048)
        self.assertEqual(list(self.root.glob('*.wav')),[])

    def test_raw_pcm_descriptor(self):
        raw = self.root/'raw.aaf'
        fixture(raw,raw=True)
        result = self.command('inspect','--input',str(raw))
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout)['tracks'][0]['sample_width'],3)

    def test_fractional_samples_and_drop_frame(self):
        path = self.root/'ntsc.aaf'
        track,_ = fixture(path,rate='30000/1001',drop=True)
        data = json.loads(self.command('inspect','--input',str(path)).stdout)
        self.assertTrue(data['drop_frame'])
        out = self.root/'ntsc.wav'
        result = self.command('extract','--input',str(path),'--track',track,'--start-frame','1','--duration-frames','8','--output',str(out))
        self.assertEqual(result.returncode,0,result.stderr)
        with wave.open(str(out),'rb') as wav:
            self.assertEqual(wav.getnframes(),reader.round_sample(Fraction(9*48000*1001,30000))-reader.round_sample(Fraction(48000*1001,30000)))

    def test_existing_outputs_and_source_preserved(self):
        output = self.root/'existing.wav'
        output.write_bytes(b'leave me alone')
        initial = hashlib.sha256(self.aaf.read_bytes()).hexdigest()
        result = self.command('extract','--input',str(self.aaf),'--track',self.track_id,'--start-frame','0','--duration-frames','2','--output',str(output))
        self.assertEqual(result.returncode,2)
        self.assertEqual(output.read_bytes(),b'leave me alone')
        self.assertEqual(hashlib.sha256(self.aaf.read_bytes()).hexdigest(),initial)
        self.assertEqual(list(self.root.glob('*.partial')),[])

    def test_source_change_guard(self):
        result = self.command('inspect','--input',str(self.aaf),'--expected-fingerprint','old')
        self.assertEqual(result.returncode,2)
        self.assertEqual(json.loads(result.stderr)['error']['code'],'source_changed')

    def test_invalid_range_and_track(self):
        for track,start,duration in [('missing','0','2'),(self.track_id,'-1','2'),(self.track_id,'9','2'),(self.track_id,'0','0')]:
            result = self.command('extract','--input',str(self.aaf),'--track',track,'--start-frame',start,'--duration-frames',duration,'--output',str(self.root/'out.wav'))
            self.assertEqual(result.returncode,2,result.stdout)
            self.assertFalse((self.root/'out.wav').exists())

    def test_nonzero_origin_rejected(self):
        path = self.root/'origin.aaf'
        fixture(path,origin=24)
        result = self.command('inspect','--input',str(path))
        self.assertEqual(result.returncode,2)
        self.assertIn('Non-zero slot origins',result.stderr)

    def test_same_output_paths_rejected(self):
        output = self.root/'same.wav'
        result = self.command('extract','--input',str(self.aaf),'--track',self.track_id,'--start-frame','0','--duration-frames','2','--output',str(output),'--peaks-output',str(output))
        self.assertEqual(result.returncode,2)
        self.assertFalse(output.exists())

    def test_output_publication_race_never_overwrites(self):
        output = self.root/'race.wav'
        with self.assertRaises(FileExistsError):
            with reader.pending_file(output) as pending:
                pending.write_bytes(b'generated')
                output.write_bytes(b'other writer')
        self.assertEqual(output.read_bytes(),b'other writer')

    def test_eof_exact_and_no_duplicate_handles(self):
        output = self.root/'eof.wav'
        result = self.command('extract','--input',str(self.aaf),'--track',self.track_id,'--start-frame','9','--duration-frames','1','--output',str(output))
        self.assertEqual(result.returncode,0,result.stderr)
        with wave.open(str(output),'rb') as wav:
            self.assertEqual(wav.readframes(wav.getnframes()),self.pcm[9*2002*3:10*2002*3])

    def test_multiple_compositions_rejected(self):
        with aaf2.open(str(self.aaf),'rw') as file:
            second = file.create.CompositionMob('Another composition')
            second['UsageCode'].value = 'Usage_TopLevel'
            file.content.mobs.append(second)
        result = self.command('inspect','--input',str(self.aaf))
        self.assertEqual(result.returncode,2)
        self.assertIn('multiple top-level',result.stderr)

    def test_unhandled_effect_is_not_silently_flattened(self):
        with aaf2.open(str(self.aaf),'rw') as file:
            track = next(file.content.toplevel()).slot_at(int(self.track_id))
            child = track.segment.components.pop(0)
            definition = file.create.OperationDef('98a6de90-cb1a-47ce-8bfc-44c8462bd2ab','Unsupported fixture effect')
            definition.media_kind = 'sound'; definition.number_inputs = 1
            file.dictionary.register_def(definition)
            effect = file.create.OperationGroup(definition,length=child.length,media_kind='sound')
            effect.segments.append(child)
            track.segment.components.insert(0,effect)
        result = self.command('inspect','--input',str(self.aaf))
        self.assertEqual(result.returncode,2)
        self.assertIn('audio effect is not supported',result.stderr)

    def test_static_gain_warns_and_preserves_raw_samples(self):
        with aaf2.open(str(self.aaf),'rw') as file:
            track = next(file.content.toplevel()).slot_at(int(self.track_id))
            child = track.segment.components.pop(0)
            definition = file.create.OperationDef('9d2ea894-0968-11d3-8a38-0050040ef7d2','Audio Gain')
            definition.media_kind = 'sound'; definition.number_inputs = 1
            file.dictionary.register_def(definition)
            effect = file.create.OperationGroup(definition,length=child.length,media_kind='sound')
            effect.segments.append(child)
            track.segment.components.insert(0,effect)
        result = self.command('inspect','--input',str(self.aaf))
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('clip gain is not applied',json.loads(result.stdout)['tracks'][0]['warnings'][0])

    def test_cyclic_source_rejected(self):
        with aaf2.open(str(self.aaf),'rw') as file:
            master = next(file.content.mastermobs())
            master.slots[0].segment.mob = master
            master.slots[0].segment.slot_id = master.slots[0].slot_id
        result = self.command('inspect','--input',str(self.aaf))
        self.assertEqual(result.returncode,2)
        self.assertIn('cyclic',result.stderr)

    def test_extract_duration_cap(self):
        with aaf2.open(str(self.aaf),'r') as file:
            timeline = reader.Timeline(file)
            with patch.object(reader,'MAX_EXTRACT_SECONDS',0):
                args = type('Args',(),{'input':str(self.aaf),'expected_fingerprint':None,'command':'extract','track':self.track_id,'start_frame':0,'duration_frames':1,'output':str(self.root/'too-long.wav'),'peaks_output':None})()
                with self.assertRaisesRegex(reader.ReaderError,'limited to 10 minutes'):
                    reader.run(args)

    def test_offline_source_rejected_without_following_locator(self):
        with aaf2.open(str(self.aaf),'rw') as file:
            file.content.essencedata.clear()
        result = self.command('inspect','--input',str(self.aaf))
        self.assertEqual(result.returncode,2)
        self.assertFalse(result.stdout)

    def test_invalid_riff_extent_rejected(self):
        with aaf2.open(str(self.aaf),'rw') as file:
            stream = next(iter(file.content.essencedata)).open('rw')
            stream.seek(4); stream.write(b'\0\0\0\0')
        result = self.command('inspect','--input',str(self.aaf))
        self.assertEqual(result.returncode,2)
        self.assertIn('RIFF length',result.stderr)

    def test_cancel_cleanup(self):
        destination = self.root/'cancelled.wav'
        with self.assertRaises(reader.ReaderError):
            with reader.pending_file(destination) as pending:
                pending.write_bytes(b'partial')
                reader.cancelled(signal.SIGTERM,None)
        self.assertFalse(destination.exists())
        self.assertEqual(list(self.root.glob('*.partial')),[])

    def test_bounds_and_peak_chunk_independence(self):
        with aaf2.open(str(self.aaf),'r') as file:
            with patch.object(reader,'MAX_TRACKS',0):
                with self.assertRaises(reader.ReaderError):
                    reader.Timeline(file)
        a,b = reader.Peaks(12,3),reader.Peaks(12,3)
        data = self.pcm[:36]
        a.add(data); a.flush()
        b.add(data[:9]); b.add(data[9:]); b.flush()
        self.assertEqual(a.values,b.values)


if __name__ == '__main__':
    unittest.main()
