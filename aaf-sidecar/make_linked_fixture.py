"""Build-only generated PCM fixtures for packaged-app checks. No private media."""
from pathlib import Path
from fractions import Fraction
import argparse
import json
import subprocess
import aaf2
from test_graph import grouped_fixture


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--directory',required=True)
    parser.add_argument('--ffmpeg',required=True)
    parser.add_argument('--ffprobe',required=True)
    args=parser.parse_args()
    root=Path(args.directory)
    root.mkdir(parents=True,exist_ok=False)
    grouped_fixture(root/'Linked BWF fixture.aaf',alternatives=0,frames=480,audible=True)
    wave=root/'microphone-0-0.wav'
    bwf=root/'recording.bwf'
    subprocess.run([args.ffmpeg,'-v','error','-i',str(wave),'-c:a','pcm_s16le','-write_bext','1',
        '-metadata','origination_date=2026-08-01','-metadata','origination_time=12:00:00','-f','wav',str(bwf)],check=True)
    with aaf2.open(str(root/'Linked BWF fixture.aaf'),'rw') as file:
        next(file.content.sourcemobs()).descriptor['Locator'][0]['URLString'].value=bwf.as_uri()
    # Avid-style OP-Atom PCM, with a source UMID that genuinely matches the AAF.
    mxf=root/'recording.mxf'
    subprocess.run([args.ffmpeg,'-v','error','-i',str(wave),'-af','pan=mono|c0=c1','-c:a','pcm_s24le','-f','mxf_opatom',str(mxf)],check=True)
    probe=json.loads(subprocess.check_output([args.ffprobe,'-v','error','-show_streams','-show_format','-of','json',str(mxf)]))
    audio=next(stream for stream in probe['streams'] if stream.get('codec_type')=='audio')
    # OP-Atom pads to container edit units. Describe the actual media length,
    # while keeping the requested source trims/timeline duration unchanged.
    mxf_samples=int(Fraction(audio['duration_ts'])*Fraction(audio['time_base'])*48000)
    umid=probe.get('format',{}).get('tags',{}).get('file_package_umid')
    if not umid:
        umid=next(stream['tags']['file_package_umid'] for stream in probe['streams'] if 'file_package_umid' in stream.get('tags',{}))
    package=aaf2.mobid.MobID('urn:smpte:umid:'+umid.removeprefix('0x'))
    grouped_fixture(root/'Linked MXF fixture.aaf',alternatives=0,frames=480,audible=True)
    with aaf2.open(str(root/'Linked MXF fixture.aaf'),'rw') as file:
        source=next(file.content.sourcemobs()); old=source.mob_id; source.mob_id=package
        source.slots[0]['PhysicalTrackNumber'].value=1
        for master in file.content.mastermobs():
            for slot in master.slots:
                if isinstance(slot.segment,aaf2.components.SourceClip) and slot.segment.mob_id==old: slot.segment.mob_id=package
        desc=source.descriptor
        for key,value in {'Channels':1,'BlockAlign':3,'AverageBPS':48000*3,'QuantizationBits':24,'Length':mxf_samples}.items(): desc[key].value=value
        desc['Locator'][0]['URLString'].value=mxf.as_uri()
    grouped_fixture(root/'Embedded stereo fixture.aaf',embedded=True,alternatives=2,frames=480,audible=True)
    print(root)


if __name__=='__main__': main()
