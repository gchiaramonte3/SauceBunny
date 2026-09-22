"""Real generated OP1a/OP-Atom media, with independently audible microphones."""
import json
import math
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import aaf2
from graph import GraphTimeline
from mxf_info import inspect, inspect_many
from reader import fingerprint, ReaderError

BINS = Path(__file__).resolve().parents[1]/'src-tauri'/'binaries'
FFMPEG = BINS/'ffmpeg-aarch64-apple-darwin'
FFPROBE = BINS/'ffprobe-aarch64-apple-darwin'


def generate(path, atom=False):
    args = [str(FFMPEG), '-nostdin', '-v', 'error']
    if not atom:
        args += ['-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25:d=2']
    args += ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2']
    if not atom:
        args += ['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2',
                 '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'mpeg2video', '-pix_fmt', 'yuv422p']
    args += ['-c:a', 'pcm_s24le', '-t', '2', '-f', 'mxf_opatom' if atom else 'mxf', str(path)]
    subprocess.run(args, check=True, capture_output=True)


def linked_aaf(path, media, info):
    with aaf2.open(str(path), 'w') as file:
        comp = file.create.CompositionMob('OP1a fixture'); comp['UsageCode'].value = 'Usage_TopLevel'; file.content.mobs.append(comp)
        tc = comp.create_timeline_slot('25'); tc.segment = file.create.Timecode(fps=25, length=50)
        source = file.create.SourceMob('Linked microphones'); source.mob_id = aaf2.mobid.MobID(info['tracks'][0]['mob_id']); file.content.mobs.append(source)
        multiple = file.create.MultipleDescriptor(); multiple['SampleRate'].value = 25; multiple['Length'].value = 50
        locator = file.create.NetworkLocator(); locator['URLString'].value = media.as_uri(); multiple['Locator'].append(locator)
        source.descriptor = multiple
        for identity in info['tracks']:
            slot = source.create_timeline_slot('25', slot_id=identity['slot_id']); slot.segment = file.create.Filler(media_kind='sound', length=50)
            # Encoded MXF track numbers are NOT indices into a channel array.
            slot['PhysicalTrackNumber'].value = 0x16010300+identity['slot_id']
            desc = file.create.PCMDescriptor()
            for key, value in {'LinkedSlotID':slot.slot_id, 'Channels':1, 'SampleRate':25, 'AudioSamplingRate':48000,
                               'QuantizationBits':24, 'Length':50, 'BlockAlign':3, 'AverageBPS':144000}.items(): desc[key].value=value
            multiple['FileDescriptors'].append(desc)
            track = comp.create_sound_slot('25'); track.segment.components.append(source.create_source_clip(slot.slot_id, 10, 25, 'sound'))
            track.segment.components.append(file.create.Filler(media_kind='sound',length=25)); track.segment.length=50


class MxfTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sauce-mxf-test-'); self.root=Path(self.temp.name)
    def tearDown(self): self.temp.cleanup()

    def test_op1a_source_slots_select_distinct_real_audio_streams(self):
        path=self.root/'multi.mxf'; generate(path); info=inspect(path)
        self.assertEqual(len(info['tracks']),2)
        indices=[]
        for track, frequency in zip(info['tracks'], (440,880)):
            selector=f'i:{track["material_track_id"]}'
            probe=json.loads(subprocess.check_output([str(FFPROBE),'-v','error','-select_streams',selector,'-show_streams','-of','json',str(path)]))
            self.assertEqual(len(probe['streams']),1); stream=probe['streams'][0]
            self.assertEqual(stream['codec_name'],'pcm_s24le'); indices.append(stream['index'])
            data=subprocess.check_output([str(FFMPEG),'-v','error','-ss','0.4','-i',str(path),'-map',f'0:{selector}',
                                          '-t','0.2','-af','pan=mono|c0=c0','-c:a','pcm_s16le','-f','s16le','pipe:1'])
            samples=[int.from_bytes(data[i:i+2],'little',signed=True) for i in range(0,len(data),2)]
            self.assertEqual(len(samples),9600)
            crossings=sum(a <= 0 < b for a,b in zip(samples,samples[1:]))
            self.assertAlmostEqual(crossings/0.2,frequency,delta=5)
            self.assertGreater(math.sqrt(sum(s*s for s in samples)/len(samples)),1000)
        self.assertEqual(indices,[1,2])
        aaf=self.root/'linked.aaf'; linked_aaf(aaf,path,info)
        with aaf2.open(str(aaf),'r') as file: manifest=GraphTimeline(file).manifest(fingerprint(aaf))
        sources=manifest['graph']['sources']; self.assertEqual(len(sources),2)
        self.assertEqual([s['slot_id'] for s in sources],[t['slot_id'] for t in info['tracks']])
        self.assertTrue(all(s['sample_count']==96000 and s['sample_width']==3 and s['channels']==1 and s['channel']==0 for s in sources))
        self.assertTrue(all(s['locators']==[path.as_uri()] for s in sources))
        self.assertTrue(all(p['numerator']/p['denominator']==19200 for p in manifest['graph']['positions']))

    def test_opatom_and_renamed_media_keep_the_package_identity(self):
        path=self.root/'mono.mxf'; generate(path,atom=True); before=inspect(path)
        self.assertEqual(len(before['tracks']),1)
        renamed=self.root/'renamed.mxf'; path.rename(renamed)
        after=inspect(renamed); self.assertEqual(before['tracks'],after['tracks']); self.assertEqual(before['fingerprint'],after['fingerprint'])
        self.assertTrue(after['tracks'][0]['aligned'])

    def test_sparse_mxf_over_64_gib_only_reads_header_and_fingerprint_windows(self):
        path = self.root/'large.mxf'; generate(path); before = inspect(path)
        with path.open('r+b') as stream: stream.truncate(65 * 1024**3)
        after = inspect(path)
        self.assertEqual(before['tracks'], after['tracks'])
        self.assertNotEqual(before['fingerprint'], after['fingerprint'])
        self.assertLess(path.stat().st_blocks * 512, 4 * 1024 * 1024)

    def test_ambiguous_descriptor_does_not_guess_audio_format(self):
        path=self.root/'multi.mxf'; generate(path); info=inspect(path); aaf=self.root/'linked.aaf'; linked_aaf(aaf,path,info)
        with aaf2.open(str(aaf),'rw') as file:
            source=next(file.content.sourcemobs()); descriptors=list(source.descriptor['FileDescriptors'].value)
            descriptors[1]['LinkedSlotID'].value=descriptors[0]['LinkedSlotID'].value
        with aaf2.open(str(aaf),'r') as file: data=GraphTimeline(file).manifest(fingerprint(aaf))
        self.assertTrue(all(l['availability']=='unsupported' for l in data['graph']['lanes']))
        self.assertFalse(data['graph']['sources'])

    def test_malformed_header_and_missing_media_return_per_file_errors(self):
        bad=self.root/'bad.mxf'; bad.write_bytes(b'not an MXF')
        result=inspect_many([str(bad),str(self.root/'missing.mxf')])
        self.assertEqual(result['schema_version'],1)
        self.assertTrue(all('error' in f and not f.get('tracks') for f in result['files']))

    def test_stop_during_header_inspection_does_not_continue_the_batch(self):
        with patch('mxf_info.inspect', side_effect=ReaderError('cancelled','Stopped')) as inspect_file:
            with self.assertRaises(ReaderError) as error:
                inspect_many(['first.mxf','second.mxf'])
        self.assertEqual(error.exception.code,'cancelled')
        self.assertEqual(inspect_file.call_count,1)


if __name__ == '__main__': unittest.main()
