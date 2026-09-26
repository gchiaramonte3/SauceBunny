"""Read-only AAF inspection and embedded PCM extraction. Never opens locators."""
from __future__ import annotations
import argparse
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date
from fractions import Fraction
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import signal
import stat as file_stat
import struct
import sys
import tempfile
import threading
import time
import warnings
import wave

with warnings.catch_warnings():
    warnings.simplefilter('ignore', DeprecationWarning)
    import audioop
import aaf2

SCHEMA_VERSION = 1
MAX_TRACKS = 64
MAX_SEGMENTS = 10000
MAX_DEPTH = 16
MAX_DURATION_SECONDS = 24 * 60 * 60
MAX_EXTRACT_SECONDS = 600
BLOCK_BYTES = 192 * 1024
PEAK_BUCKETS = 2048


class ReaderError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def fail(message, code='unsupported_aaf'):
    raise ReaderError(code, message)


def value(obj, key, default=None):
    prop = obj.get(key)
    return prop.value if prop is not None else default


def rate_of(slot):
    try:
        rate = Fraction(str(slot.edit_rate))
    except (ValueError, ZeroDivisionError, AttributeError):
        fail('A timeline slot has an invalid edit rate.')
    if not 0 < rate <= 192000:
        fail('A timeline slot edit rate is outside the supported range.')
    if value(slot, 'Origin', 0) != 0:
        fail('Non-zero slot origins are not supported. Export a flattened AAF.')
    return rate


def round_sample(position):
    """Nearest integer, ties upward. One policy for every rational boundary."""
    return (position.numerator * 2 + position.denominator) // (2 * position.denominator)


def clean_name(text, fallback):
    name = ''.join(c for c in str(text or '') if c >= ' ' and c != '\x7f').strip()
    return name[:240] or fallback


def append_warning(warnings_list, message):
    if message not in warnings_list and len(warnings_list) < 32:
        warnings_list.append(message)


def fingerprint(path):
    stat = path.stat()
    if not file_stat.S_ISREG(stat.st_mode) or stat.st_size <= 0:
        fail('Choose a non-empty regular media file.', 'invalid_input')
    # AAF and MXF can be hundreds of GB. Identity reads only the head/tail,
    # using 64-bit offsets; source size is not a memory allocation budget.
    digest = hashlib.sha256(f'{stat.st_size}:{stat.st_mtime_ns}'.encode())
    with path.open('rb') as src:
        digest.update(src.read(65536))
        src.seek(max(0, stat.st_size-65536))
        digest.update(src.read(65536))
    return digest.hexdigest()


@dataclass
class PCM:
    source_id: str
    data_offset: int
    sample_count: int
    sample_rate: int
    sample_width: int
    time_reference: int | None
    recording_date: str | None = None
    recording_date_provenance: str = 'bwf-origination-date'
    channels: int = 1
    channel: int = 0


def pcm_layout(essence, descriptor=None):
    stream = essence.open('r')
    size = stream.dir.byte_size
    if isinstance(descriptor,aaf2.essence.PCMDescriptor):
        hz = Fraction(str(value(descriptor,'AudioSamplingRate')))
        channels = value(descriptor,'Channels')
        bits = value(descriptor,'QuantizationBits')
        align = value(descriptor,'BlockAlign')
        if hz.denominator != 1 or hz not in (44100,48000,96000) or not 1 <= channels <= 256 or bits not in (16,24,32):
            fail('Use PCM audio at 44.1, 48 or 96 kHz and 16, 24 or 32 bits.')
        if align != channels*bits//8 or size % align or value(descriptor,'Length') != size//align:
            fail('The embedded PCM descriptor does not match its samples.', 'invalid_media')
        return PCM(str(essence.mob_id),0,size//align,int(hz),bits//8,None,channels=channels)
    head = stream.read(12)
    if head[:4] != b'RIFF' or head[8:] != b'WAVE':
        fail('Only embedded PCM WAVE essence is supported. Export embedded WAV audio.')
    declared = struct.unpack('<I', head[4:8])[0]+8
    if declared != size:
        fail('An embedded WAVE stream has an inconsistent RIFF length.', 'invalid_media')
    cursor, fmt, data, time_reference, recording_date = 12, None, None, None, None
    for _ in range(256):
        if cursor == size:
            break
        if cursor+8 > size:
            fail('An embedded WAVE chunk is truncated.', 'invalid_media')
        stream.seek(cursor)
        tag, count = struct.unpack('<4sI', stream.read(8))
        if cursor+8+count > size:
            fail('An embedded WAVE chunk exceeds its stream.', 'invalid_media')
        if tag == b'fmt ':
            if fmt is not None or not 16 <= count <= 65536:
                fail('The embedded WAVE format is invalid.', 'invalid_media')
            fmt = struct.unpack('<HHIIHH', stream.read(16))
        elif tag == b'bext' and count >= 346:
            stream.seek(cursor+8+320)
            raw_date = stream.read(10).decode('ascii', errors='replace')
            try:
                # BWF permits alternate separators; reject malformed or zero dates.
                normalized = raw_date[:4]+'-'+raw_date[5:7]+'-'+raw_date[8:10]
                if raw_date[4] in '-_: .' and raw_date[7] in '-_: .':
                    recording_date = date.fromisoformat(normalized).isoformat()
            except ValueError:
                pass
            stream.seek(cursor+8+338)
            time_reference = struct.unpack('<Q', stream.read(8))[0]
        elif tag == b'data':
            if data is not None:
                fail('Multiple WAVE data chunks are not supported.')
            data = (cursor+8, count)
        cursor += 8+count
        # Python's standard wave writer omits a final odd-byte data pad.
        if cursor < size:
            cursor += count & 1
    else:
        fail('The embedded WAVE has too many chunks.', 'limit_exceeded')
    if fmt is None or data is None:
        fail('An embedded WAVE is missing its format or samples.', 'invalid_media')
    tag, channels, hz, byte_rate, align, bits = fmt
    if tag != 1 or not 1 <= channels <= 256 or bits not in (16, 24, 32) or hz not in (44100, 48000, 96000):
        fail('Use PCM WAV audio at 44.1, 48 or 96 kHz and 16, 24 or 32 bits.')
    if align != channels*bits//8 or byte_rate != hz*align or data[1] % align:
        fail('The embedded PCM sample layout is invalid.', 'invalid_media')
    return PCM(str(essence.mob_id), data[0], data[1]//align, hz, bits//8, time_reference, recording_date, channels=channels)


def timecode_segment(segment):
    if isinstance(segment, aaf2.components.Timecode):
        return segment
    if isinstance(segment, aaf2.components.Sequence):
        parts = list(segment.components)
        if len(parts) == 1 and isinstance(parts[0], aaf2.components.Timecode):
            return parts[0]
    return None


class Timeline:
    def __init__(self, file):
        self.file = file
        self.warnings = []
        self.sources = {}
        self.essence = {}
        self.expanded = 0
        for index, e in enumerate(file.content.essencedata):
            if index >= MAX_SEGMENTS:
                fail('Too many embedded streams.', 'limit_exceeded')
            self.essence[str(e.mob_id)] = e
        tops = []
        for mob in file.content.toplevel():
            tops.append(mob)
            if len(tops) > 1:
                fail('This AAF contains multiple top-level sequences. Export one sequence.')
        if not tops:
            fail('This AAF does not contain a top-level sequence.')
        self.mob = tops[0]
        slots = []
        for index,slot in enumerate(self.mob.slots):
            if index >= MAX_TRACKS*4:
                fail('The AAF contains too many timeline slots.', 'limit_exceeded')
            slots.append(slot)
        audio = [s for s in slots if s.segment.media_kind.lower() == 'sound']
        if not 0 < len(audio) <= MAX_TRACKS:
            fail('Choose an AAF with between 1 and 64 audio tracks.', 'limit_exceeded')
        self.rate = rate_of(audio[0])
        if self.rate > 120 or any(rate_of(s) != self.rate for s in audio):
            fail('Audio timeline tracks must use one shared video edit rate.')
        self.duration = max(s.segment.length for s in audio)
        if not 0 < Fraction(self.duration, 1)/self.rate <= MAX_DURATION_SECONDS:
            fail('The sequence must be longer than zero and no longer than 24 hours.', 'limit_exceeded')
        # Record timecode may sit directly in its slot or wrapped in a
        # one-component Sequence. A sequence can also carry auxiliary TC
        # tracks; the record track is the one numbered 1, so they no longer
        # make the whole import fail.
        timecodes = [(value(s, 'PhysicalTrackNumber'), t) for s in slots
                     for t in [timecode_segment(s.segment)]
                     if t is not None and rate_of(s) == self.rate and t.fps == math.ceil(self.rate)]
        self.start, self.fps, self.drop = 0, math.ceil(self.rate), False
        if timecodes:
            record = next((t for number, t in timecodes if number == 1), timecodes[0][1])
            self.start, self.fps, self.drop = record.start, record.fps, record.drop
            if any((t.start,t.fps,t.drop) != (self.start,self.fps,self.drop) for _, t in timecodes):
                append_warning(self.warnings, 'This sequence has more than one timecode track. The record timecode (track 1) is used.')
        else:
            append_warning(self.warnings, 'No matching record timecode was found. The timeline starts at zero.')
        self.tracks = [self.read_track(s) for s in audio]

    def source(self, mob):
        key = str(mob.mob_id)
        if key not in self.sources:
            if key not in self.essence:
                fail('Linked or offline media is not read. Re-export the AAF with embedded WAV audio.')
            self.sources[key] = pcm_layout(self.essence[key],value(mob,'EssenceDescription'))
            if not self.sources[key].recording_date:
                # Only explicit recording fields. AAF CreationTime describes
                # the edit/export and Finder timestamps describe the copy.
                for tag in ('RecordingDate', 'ShootDate', 'DateRecorded'):
                    tagged_date = mob.comments.get(tag)
                    raw_date = value(tagged_date, 'Value') if tagged_date is not None else None
                    if isinstance(raw_date, str):
                        try:
                            self.sources[key].recording_date = date.fromisoformat(raw_date.strip()).isoformat()
                            self.sources[key].recording_date_provenance = 'explicit-recording-date'
                            break
                        except ValueError:
                            pass
        return self.sources[key]

    def expand(self, seg, rate, start, duration, trail, warnings_list, depth=0):
        self.expanded += 1
        if depth > MAX_DEPTH or self.expanded > MAX_SEGMENTS:
            fail('The AAF source graph is too complex.', 'limit_exceeded')
        length = Fraction(seg.length, 1)/rate
        if start < 0 or duration < 0 or start+duration > length:
            fail('A source reference extends outside its timeline segment.', 'invalid_media')
        if not duration:
            return []
        if isinstance(seg, aaf2.components.Filler):
            return [{'kind':'gap', 'duration':duration}]
        if isinstance(seg, aaf2.components.Sequence):
            result, cursor = [], Fraction(0)
            for index, child in enumerate(seg.components):
                if index >= MAX_SEGMENTS:
                    fail('Too many sequence components.', 'limit_exceeded')
                if isinstance(child, aaf2.components.Transition):
                    fail('AAF transitions are not supported. Render fades before exporting.')
                child_duration = Fraction(child.length, 1)/rate
                left, right = max(start,cursor), min(start+duration,cursor+child_duration)
                if left < right:
                    result.extend(self.expand(child,rate,left-cursor,right-left,trail,warnings_list,depth+1))
                cursor += child_duration
            if cursor != length:
                fail('A sequence component length is inconsistent.', 'invalid_media')
            return result
        if isinstance(seg, aaf2.components.OperationGroup):
            operation = value(seg,'Operation')
            inputs = list(value(seg,'InputSegments',[]))
            if operation.name != 'Audio Gain' or len(inputs) != 1:
                fail('An audio effect is not supported. Render effects before exporting the AAF.')
            for param in value(seg,'Parameters',[]):
                if not isinstance(param,aaf2.misc.ConstantValue):
                    fail('Automated audio gain is not supported. Render it before exporting.')
            append_warning(warnings_list, 'Raw microphone audio: Avid clip gain is not applied.')
            return self.expand(inputs[0],rate,start,duration,trail,warnings_list,depth+1)
        if not isinstance(seg,aaf2.components.SourceClip):
            fail(f'Unsupported audio component: {type(seg).__name__}. Export a flattened AAF.')
        mob, slot = seg.mob, seg.slot
        if mob is None or slot is None:
            fail('The AAF contains missing or offline source references.', 'missing_media')
        key = (str(mob.mob_id),slot.slot_id)
        if key in trail:
            fail('The AAF contains a cyclic source reference.', 'invalid_media')
        source_rate = rate_of(slot)
        offset = Fraction(seg.start,1)/source_rate + start
        if offset < 0:
            fail('Negative source positions are not supported.', 'invalid_media')
        if str(mob.mob_id) in self.essence:
            pcm = self.source(mob)
            if pcm.channels != 1:
                fail('Multichannel embedded audio requires the graph importer.')
            if round_sample((offset+duration)*pcm.sample_rate) > pcm.sample_count:
                fail('A clip exceeds the embedded audio samples.', 'invalid_media')
            return [{'kind':'audio', 'duration':duration, 'source_id':pcm.source_id,
                     'source_start':offset, 'master_id':str(mob.mob_id),
                     'name':clean_name(mob.name,'Audio clip')}]
        children = self.expand(slot.segment,source_rate,offset,duration,trail+(key,),warnings_list,depth+1)
        if isinstance(mob,aaf2.mobs.MasterMob):
            names = {str(tag.value) for tag in value(mob,'UserComments',[]) if tag.name == 'TRK1'}
            owner = clean_name(next(iter(names)),'') if len(names) == 1 else ''
            for item in children:
                item.update(master_id=str(mob.mob_id),name=clean_name(mob.name,'Audio clip'),owner=owner)
        return children

    def read_track(self, slot):
        warnings_list = []
        attrs = {t.name:t.value for t in value(slot,'TimelineMobAttributeList',[])}
        if attrs.get('AudioMixerCompSolo') or attrs.get('AudioMixerCompMute'):
            append_warning(warnings_list, 'Track solo and mute are audition controls; all imported microphone tracks remain available.')
        pieces = self.expand(slot.segment,self.rate,Fraction(0),Fraction(slot.segment.length,1)/self.rate,(),warnings_list)
        if slot.segment.length < self.duration:
            pieces.append({'kind':'gap','duration':Fraction(self.duration-slot.segment.length,1)/self.rate})
        clips, cursor, formats, owners = [], Fraction(0), set(), set()
        for piece in pieces:
            start_frames, duration_frames = cursor*self.rate, piece['duration']*self.rate
            if start_frames.denominator != 1 or duration_frames.denominator != 1:
                fail('Nested audio edits do not land on sequence frames. Export a flattened AAF.')
            clip = {'start_frame':int(start_frames),'duration_frames':int(duration_frames),'kind':piece['kind'],'warnings':[]}
            if piece['kind'] == 'audio':
                pcm = self.sources[piece['source_id']]
                formats.add((pcm.sample_rate,pcm.sample_width))
                if piece.get('owner'):
                    owners.add(piece['owner'])
                source_samples = piece['source_start']*pcm.sample_rate
                clip.update(name=piece['name'],master_id=piece['master_id'],source_id=pcm.source_id,
                            source_start_sample=round_sample(source_samples),sample_rate=pcm.sample_rate,
                            source_sample_position={'numerator':source_samples.numerator,'denominator':source_samples.denominator})
            clips.append(clip)
            cursor += piece['duration']
        if len(formats) > 1:
            fail('One track contains different PCM formats. Re-export its audio at one sample rate and bit depth.')
        if len(owners) > 1:
            append_warning(warnings_list, 'This track contains different microphone names. Clip names are preserved; no speaker identity is assumed.')
        name = next(iter(owners)) if len(owners)==1 else clean_name(slot.name,f'Track {value(slot,"PhysicalTrackNumber",slot.slot_id)}')
        hz, width = next(iter(formats)) if formats else (48000,3)
        number = value(slot, 'PhysicalTrackNumber')
        number = number if isinstance(number, int) and number > 0 else None
        return {'id':str(slot.slot_id),'name':name,'physical_track_number':number,'clips':clips,'warnings':warnings_list,
                'sample_rate':hz,'sample_width':width,'duration_frames':self.duration}

    def manifest(self, source_fingerprint):
        return {'schema_version':SCHEMA_VERSION,'name':clean_name(self.mob.name,'AAF sequence'),
                'sequence_id':str(self.mob.mob_id),'edit_rate':{'numerator':self.rate.numerator,'denominator':self.rate.denominator},
                'start_frame':self.start,'duration_frames':self.duration,'timecode_fps':self.fps,'drop_frame':self.drop,
                'source_fingerprint':source_fingerprint,'tracks':self.tracks,'warnings':self.warnings,
                'recording_dates':[{'source_id':pcm.source_id,'date':pcm.recording_date,'provenance':pcm.recording_date_provenance}
                                   for pcm in self.sources.values() if pcm.recording_date]}

    def track(self, track_id):
        for track in self.tracks:
            if track['id'] == track_id:
                return track
        fail('The selected track is not present in this AAF.', 'invalid_track')

    def blocks(self, track, start_frame, duration_frames):
        hz, width = track['sample_rate'],track['sample_width']
        expected = round_sample(Fraction(start_frame+duration_frames,1)*hz/self.rate)-round_sample(Fraction(start_frame,1)*hz/self.rate)
        emitted = 0
        for clip in track['clips']:
            first = max(start_frame,clip['start_frame'])
            end = min(start_frame+duration_frames,clip['start_frame']+clip['duration_frames'])
            if first >= end:
                continue
            count = round_sample(Fraction(end,1)*hz/self.rate)-round_sample(Fraction(first,1)*hz/self.rate)
            stream = None
            if clip['kind'] == 'audio':
                pcm = self.sources[clip['source_id']]
                position = clip['source_sample_position']
                source_start = Fraction(position['numerator'],position['denominator'])
                offset = round_sample(source_start+Fraction(first-clip['start_frame'],1)*hz/self.rate)
                if offset+count > pcm.sample_count:
                    fail('The requested sample range exceeds the embedded audio.', 'invalid_media')
                stream = self.essence[clip['source_id']].open('r')
                stream.seek(pcm.data_offset+offset*width*pcm.channels)
            elif clip['kind'] != 'gap':
                fail('This range contains unavailable audio.', 'missing_media')
            while count:
                channels = pcm.channels if stream else 1
                take = min(count,BLOCK_BYTES//(width*channels))
                block = stream.read(take*width*channels) if stream else bytes(take*width)
                if channels > 1:
                    stride = width*channels
                    block = b''.join(block[i+pcm.channel*width:i+(pcm.channel+1)*width] for i in range(0,len(block),stride))
                if len(block) != take*width:
                    fail('Embedded audio ended before the requested range.', 'invalid_media')
                yield block
                emitted += take
                count -= take
        if emitted != expected:
            fail('The selected track does not cover the requested interval.', 'invalid_media')


class Peaks:
    def __init__(self, samples, width):
        self.width = width
        self.bucket = max(1,math.ceil(samples/PEAK_BUCKETS))
        self.values, self.count = [],0
        self.minimum, self.maximum = 0,0
        self.scale = 2**(width*8-1)

    def add(self, data):
        at = 0
        while at < len(data):
            take = min(self.bucket-self.count,(len(data)-at)//self.width)
            lo,hi = audioop.minmax(data[at:at+take*self.width],self.width)
            self.minimum,self.maximum = min(self.minimum,lo),max(self.maximum,hi)
            self.count += take
            at += take*self.width
            if self.count == self.bucket:
                self.flush()

    def flush(self):
        if self.count:
            self.values.append([round(self.minimum/self.scale,7),round(self.maximum/self.scale,7)])
        self.minimum,self.maximum,self.count = 0,0,0


@contextmanager
def pending_file(destination):
    destination = Path(destination)
    if destination.exists() or destination.is_symlink() or not destination.parent.is_dir():
        fail('Choose a new output file in an existing folder.', 'invalid_output')
    fd, name = tempfile.mkstemp(prefix='.aaf-',suffix='.partial',dir=destination.parent)
    os.close(fd)
    path = Path(name)
    try:
        yield path
        # Link is atomic and refuses to overwrite a destination created meanwhile.
        os.link(path,destination)
    finally:
        path.unlink(missing_ok=True)


def write_json(path, obj):
    with open(path,'w',encoding='utf-8') as output:
        json.dump(obj,output,separators=(',',':'),allow_nan=False)
        output.write('\n')


def cancelled(_signum,_frame):
    raise ReaderError('cancelled','AAF processing was cancelled.')


def stream_extents(stream):
    """Coalesce pyaaf2's already-validated sector chain into physical byte runs.

    Includes mini-streams used by short fixtures. Rust receives no locator/path
    to follow: every extent is inside the same fingerprinted AAF file.
    """
    storage = stream.storage
    unit = stream.sector_size()
    mini = stream.is_mini_stream()
    remaining = stream.dir.byte_size
    runs = []
    for sid in stream.fat_chain:
        if not remaining:
            break
        if mini:
            pos = sid * storage.mini_stream_sector_size
            sector = storage.mini_stream_chain[pos // storage.sector_size]
            offset = (sector + 1) * storage.sector_size + pos % storage.sector_size
        else:
            offset = (sid + 1) * storage.sector_size
        count = min(unit, remaining)
        if runs and runs[-1][0] + runs[-1][1] == offset:
            runs[-1][1] += count
        else:
            runs.append([offset, count])
        if len(runs) > 200000:
            fail('Embedded audio is too fragmented to index safely.', 'limit_exceeded')
        remaining -= count
    if remaining:
        fail('Embedded stream sector chain is truncated.', 'invalid_media')
    return runs


def run(args):
    if args.command == 'mxf-info':
        from mxf_info import inspect_many
        return inspect_many(args.input)
    path = Path(args.input)
    identity = fingerprint(path)
    if args.expected_fingerprint and args.expected_fingerprint != identity:
        fail('The AAF changed. Import it again before continuing.', 'source_changed')
    with aaf2.open(str(path),'r') as file:
        if args.command == 'sequences':
            from graph import sequence_choices
            return sequence_choices(file)
        if getattr(args, 'graph', False):
            from graph import GraphTimeline
            timeline = GraphTimeline(file, getattr(args, 'sequence', None))
        else:
            timeline = Timeline(file)
        if args.command == 'index':
            # Internal read-only playback index. Keep exact rational source
            # positions; the public manifest intentionally omits these details.
            result = timeline.manifest(identity)
            result['sources'] = {key: {
                'extents': stream_extents(timeline.essence[key].open('r')),
                'data_offset': pcm.data_offset, 'sample_count': pcm.sample_count,
                'sample_rate': pcm.sample_rate, 'sample_width': pcm.sample_width,
                'channels': pcm.channels, 'channel': pcm.channel,
            } for key, pcm in timeline.sources.items() if key in timeline.essence}
            result['schema_version'] = 2 if getattr(args, 'graph', False) else 1
            if sum(len(source['extents']) for source in result['sources'].values()) > 200000:
                fail('The PCM index exceeds its safety limit.', 'limit_exceeded')
            if fingerprint(path) != identity:
                fail('The AAF changed during processing. Import it again.', 'source_changed')
        elif args.command == 'inspect':
            result = timeline.manifest(identity)
        else:
            track = timeline.track(args.track)
            if args.command == 'extract' and args.peaks_output and Path(args.output).resolve() == Path(args.peaks_output).resolve():
                fail('Audio and waveform outputs must use different files.', 'invalid_output')
            start = args.start_frame if args.command == 'extract' else 0
            duration = args.duration_frames if args.command == 'extract' else timeline.duration
            if start < 0 or duration <= 0 or start+duration > timeline.duration:
                fail('Choose a range inside the sequence.', 'invalid_range')
            if args.command == 'extract' and Fraction(duration,1)/timeline.rate > MAX_EXTRACT_SECONDS:
                fail('Each audio preparation is limited to 10 minutes. Use consecutive bounded chunks.', 'limit_exceeded')
            samples = round_sample(Fraction(start+duration,1)*track['sample_rate']/timeline.rate)-round_sample(Fraction(start,1)*track['sample_rate']/timeline.rate)
            peaks = Peaks(samples,track['sample_width'])
            result = {'schema_version':SCHEMA_VERSION,'track_id':track['id'],'start_frame':start,
                      'duration_frames':duration,'sample_rate':track['sample_rate'],'channels':1,
                      'sample_count':samples,'samples_per_peak':peaks.bucket,'source_fingerprint':identity,
                      'warnings':track['warnings']}
            with pending_file(args.output) as destination:
                if args.command == 'extract':
                    with wave.open(str(destination),'wb') as wav:
                        wav.setnchannels(1)
                        wav.setsampwidth(track['sample_width'])
                        wav.setframerate(track['sample_rate'])
                        wav.setnframes(samples)
                        for block in timeline.blocks(track,start,duration):
                            wav.writeframesraw(block)
                            peaks.add(block)
                else:
                    for block in timeline.blocks(track,start,duration):
                        peaks.add(block)
                peaks.flush()
                if fingerprint(path) != identity:
                    fail('The AAF changed during processing. Import it again.', 'source_changed')
                peak_result = dict(result,peaks=peaks.values)
                if args.command == 'peaks':
                    write_json(destination,peak_result)
                elif args.peaks_output:
                    with pending_file(args.peaks_output) as peak_destination:
                        write_json(peak_destination,peak_result)
                    result['peaks_output'] = args.peaks_output
            result['output'] = args.output
        if fingerprint(path) != identity:
            fail('The AAF changed during processing. Import it again.', 'source_changed')
        return result


def main():
    # graph imports the shared reader contracts; use this module instance so
    # structured ReaderError handling also works in the frozen executable.
    sys.modules.setdefault('reader', sys.modules[__name__])
    if getattr(sys,'frozen',False):
        # Tauri may SIGKILL the one-file bootloader, which cannot forward that
        # signal. Never let its Python worker keep reading/writing after Stop.
        parent = os.getppid()
        if parent == 1:
            return 130
        def watch_parent():
            while True:
                time.sleep(0.05)
                if os.getppid() != parent:
                    os._exit(130)
        threading.Thread(target=watch_parent,daemon=True,name='aaf-owner').start()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version',action='version',version='saucebunny-aaf 1.0.0 (pyaaf2 '+aaf2.__version__+')')
    commands = parser.add_subparsers(dest='command',required=True)
    child = commands.add_parser('mxf-info')
    child.add_argument('--input', nargs='+', required=True)
    for command in ('inspect','index','extract','peaks','sequences'):
        child = commands.add_parser(command)
        child.add_argument('--input',required=True)
        child.add_argument('--expected-fingerprint')
        child.add_argument('--graph', action='store_true')
        child.add_argument('--sequence')
        if command not in ('inspect','index','sequences'):
            child.add_argument('--track',required=True)
            child.add_argument('--output',required=True)
        if command == 'extract':
            child.add_argument('--start-frame',type=int,required=True)
            child.add_argument('--duration-frames',type=int,required=True)
            child.add_argument('--peaks-output')
    args = parser.parse_args()
    signal.signal(signal.SIGTERM,cancelled)
    signal.signal(signal.SIGINT,cancelled)
    logging.getLogger().setLevel(logging.ERROR)
    try:
        print(json.dumps(run(args),separators=(',',':'),allow_nan=False))
        return 0
    except ReaderError as error:
        print(json.dumps({'schema_version':1,'error':{'code':error.code,'message':str(error)}}),file=sys.stderr)
        return 130 if error.code == 'cancelled' else 2
    except (OSError,ValueError,TypeError,KeyError,AttributeError,IndexError,ZeroDivisionError,AssertionError,struct.error,aaf2.exceptions.AAFError):
        # Parser paths and untrusted metadata do not become user-facing tracebacks.
        print(json.dumps({'schema_version':1,'error':{'code':'invalid_aaf','message':'The AAF could not be read safely. Re-export it with embedded mono WAV audio.'}}),file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
