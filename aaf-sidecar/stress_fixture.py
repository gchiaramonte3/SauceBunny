"""Generate an isolated 50-lane AAF for packaged playback/transcription QA.

Input is a generated mono 48 kHz PCM WAV, never production audio. Every lane
has its original physical track number; the last lane supplies a second date
to exercise mixed BWF dates. No existing output is overwritten.
"""
import argparse
import io
import struct
import wave
from pathlib import Path

import aaf2


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--speech', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists(): raise ValueError('Choose a new fixture filename')
    with wave.open(str(args.speech), 'rb') as source:
        assert (source.getnchannels(), source.getsampwidth(), source.getframerate()) == (1, 2, 48000)
        pcm = source.readframes(source.getnframes())
    samples = 960960  # 480 frames at 24000/1001, exactly 20.02 seconds.
    pcm = (pcm + bytes(samples * 2))[:samples * 2]
    rate, duration = '24000/1001', 480
    with aaf2.open(str(args.output), 'w') as file:
        comp = file.create.CompositionMob('Generated 50-mic verification')
        comp['UsageCode'].value = 'Usage_TopLevel'; file.content.mobs.append(comp)
        clock = comp.create_timeline_slot(rate)
        clock.segment = file.create.Timecode(fps=24, length=duration)
        clock.segment.start = 86400
        for index in range(1, 51):
            buf = io.BytesIO()
            with wave.open(buf, 'wb') as output:
                output.setnchannels(1); output.setsampwidth(2); output.setframerate(48000); output.writeframes(pcm)
            blob = buf.getvalue()
            bext = bytearray(602)
            bext[320:330] = b'2026-08-01' if index < 50 else b'2026-08-02'
            blob = blob[:36] + b'bext' + struct.pack('<I', len(bext)) + bext + blob[36:]
            blob = blob[:4] + struct.pack('<I', len(blob) - 8) + blob[8:]
            source = file.create.SourceMob(f'Generated audio {index}')
            file.content.mobs.append(source)
            essence, source_slot = source.create_essence(rate, 'sound')
            source_slot.segment.length = duration
            descriptor = file.create.WAVEDescriptor()
            descriptor['Summary'].value = list(blob[:44]); descriptor['SampleRate'].value = 48000
            descriptor['Length'].value = samples; source.descriptor = descriptor
            essence.open('w').write(blob)
            master = file.create.MasterMob(f'Test Mic {index:02}')
            master.comments['TRK1'] = f'Test Mic {index:02}'; file.content.mobs.append(master)
            slot = master.create_timeline_slot(rate)
            slot.segment = source.create_source_clip(1, 0, duration, 'sound')
            track = comp.create_sound_slot(rate)
            track['PhysicalTrackNumber'].value = index
            track.segment.components.append(master.create_source_clip(slot.slot_id, 0, duration, 'sound'))
            track.segment.length = duration
    print(args.output)


if __name__ == '__main__': main()
