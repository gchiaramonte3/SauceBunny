"""Build an Avid-shaped, LINKED (no essence) AAF with a group edit, for the string-out spike.

Structure modelled on real Media Composer exports (see the OTIO / LibAAF sample
AAFs dumped with tools/dump_aaf.py):

  top-level CompositionMob (Usage_TopLevel)
    slot 1  Timecode (phys 1, 01:00:00:00 @ 24 NDF, edit rate 24000/1001)
    V1      Sequence[Filler, Selector(picture: CAM A|CAM B), Selector(...), Filler]
    A1..A4  Sequence[Filler, Selector(sound: R1..R5 channel k), Selector(...), Filler]
            (A4 is wrapped in an 'Audio Pan' OperationGroup, as older MC exports do)
    event slot 1000+  DescriptiveMarker (Avid _ATN_CRM_* attributes)
  group CompositionMob 'GRP Day3 Kitchen' (Usage_LowerLevel, untrimmed Selectors)
  MasterMob R1..R5  (4 mono sound slots each)  -> file SourceMob per channel
       (PCMDescriptor + NetworkLocator to a fake NEXIS Avid MediaFiles MXF) -> tape SourceMob -> null
  MasterMob CAM A / CAM B (picture slot + 2 scratch sound slots) -> file mobs -> tape mob

No EssenceData is created: every file SourceMob points at an MXF path that does not
exist here, exactly like an Avid "Link to (Don't Export) Media" AAF.
"""
from fractions import Fraction
from pathlib import Path
import argparse
import json

import aaf2

RATE = '24000/1001'
FPS = 24
SPF = Fraction(48000) / Fraction(RATE)          # 2002 samples per frame at 23.976
def tcf(h, m, s, f):
    return ((h * 60 + m) * 60 + s) * FPS + f


GROUP_TC = tcf(18, 40, 0, 0)                     # group starts 18:40:00:00
GROUP_LEN = 14400                               # ~10 minutes
REC_LEN = 24000
# Recorders and cameras roll at different times, as they do on a real shoot.
REC_TC = {'R1': tcf(18, 39, 30, 0), 'R2': tcf(18, 38, 12, 7), 'R3': tcf(18, 39, 59, 11),
          'R4': tcf(18, 35, 0, 0), 'R5': tcf(18, 39, 45, 23)}
CAM_TC = {'CAM A': tcf(18, 39, 50, 0), 'CAM B': tcf(18, 39, 40, 12)}
CAM_LEN = 15500

# Recorder i, channel k -> person. Group audio track k switches between recorders.
PEOPLE = {
    'R1': ['ASHLEY', 'OMAR', 'TESS', 'VIC'],
    'R2': ['FRANKIE', 'PAUL', 'QUINN', 'WREN'],
    'R3': ['GINA', 'NICOLE_B', 'RUBY', 'XAVI'],
    'R4': ['HANK', 'LEO', 'SAM', 'BARTLEY'],
    'R5': ['IDA', 'NICOLE', 'UMA', 'YURI'],
}
CAMS = ['CAM A', 'CAM B']


def tape_mob(f, name, sound_slots, picture=False, tc_start=0, length=0):
    """Physical (tape/recorder) SourceMob: null-terminated slots + a timecode slot."""
    tape = f.create.SourceMob(name)
    tape.descriptor = f.create.TapeDescriptor()
    f.content.mobs.append(tape)
    slots = {}
    kinds = (['picture'] if picture else []) + ['sound'] * sound_slots
    for index, kind in enumerate(kinds, start=1):
        slot = tape.create_timeline_slot(RATE)
        slot.segment = f.create.SourceClip(media_kind=kind, length=length)  # zero MobID: end of chain
        slot['PhysicalTrackNumber'].value = 1 if kind == 'picture' else index - (1 if picture else 0)
        slots[(kind, slot['PhysicalTrackNumber'].value)] = slot
    tc = tape.create_timeline_slot(RATE)
    tc.segment = f.create.Timecode(fps=FPS, drop=False, length=length)
    tc.segment.start = tc_start
    tc['PhysicalTrackNumber'].value = 1
    return tape, slots


def file_mob(f, name, kind, channel, tape, tape_slot, length, locator):
    fm = f.create.SourceMob(name)
    f.content.mobs.append(fm)
    if kind == 'sound':
        d = f.create.PCMDescriptor()
        for key, value in {'Channels': 1, 'BlockAlign': 3, 'SampleRate': 48000, 'AudioSamplingRate': 48000,
                           'AverageBPS': 144000, 'QuantizationBits': 24, 'Length': int(length * SPF)}.items():
            d[key].value = value
    else:
        d = f.create.CDCIDescriptor()
        for key, value in {'StoredWidth': 1920, 'StoredHeight': 1080, 'FrameLayout': 'FullFrame',
                           'VideoLineMap': [42, 0], 'ImageAspectRatio': '16/9', 'ComponentWidth': 8,
                           'HorizontalSubsampling': 2, 'SampleRate': RATE, 'Length': length}.items():
            d[key].value = value
    loc = f.create.NetworkLocator()
    loc['URLString'].value = locator
    d['Locator'].append(loc)
    fm.descriptor = d
    slot = fm.create_timeline_slot(RATE)
    slot['PhysicalTrackNumber'].value = channel
    slot.segment = tape.create_source_clip(tape_slot.slot_id, 0, length, kind)
    return fm, slot


def master(f, name, tracks, tape, length, tc_start, uid):
    """tracks: list of (kind, channel, person-or-None)."""
    mm = f.create.MasterMob(name)
    f.content.mobs.append(mm)
    for kind, channel, person in tracks:
        tslot = tape.slot_at(next(s.slot_id for s in tape.slots
                                  if s.segment.media_kind.lower() == kind and s['PhysicalTrackNumber'].value == channel))
        suffix = f'A{channel:02}' if kind == 'sound' else 'V'
        url = f'file://NEXIS01/Kitchen/Avid%20MediaFiles/MXF/1/{name.replace(" ", "")}{suffix}.{uid}.mxf'
        fm, fslot = file_mob(f, name, kind, channel, tape, tslot, length, url)
        ms = mm.create_timeline_slot(RATE)
        ms['PhysicalTrackNumber'].value = channel
        ms.segment = fm.create_source_clip(fslot.slot_id, 0, length, kind)
        if person:
            mm.comments[f'TRK{channel}'] = person
    return mm


def slot_for(mob, kind, channel):
    return next(s for s in mob.slots if s.segment.media_kind.lower() == kind and s['PhysicalTrackNumber'].value == channel)


def group_selector(f, kind, alternates, selected, start_in_group, length):
    """alternates: list of (mob, offset_in_mob_at_group_start). Selector trimmed to [start_in_group, +length)."""
    clips = [mob.create_source_clip(slot.slot_id, off + start_in_group, length, kind) for mob, slot, off in alternates]
    sel = f.create.Selector(media_kind=kind, length=length)
    sel['Selected'].value = clips[selected]
    sel['Alternates'].value = [c for i, c in enumerate(clips) if i != selected]
    return sel


def scaled_people(recorders, channels):
    return {f'R{r}': [f'R{r}C{k:02}' for k in range(1, channels + 1)] for r in range(1, recorders + 1)}


def build(path, people_map=None):
    global PEOPLE, REC_TC
    if people_map:
        PEOPLE = people_map
        REC_TC = {rec: tcf(18, 35 + i % 5, (7 * i) % 60, (5 * i) % 24) for i, rec in enumerate(PEOPLE)}
    channels = len(next(iter(PEOPLE.values())))
    manifest = {'people': {}, 'segments': []}
    with aaf2.open(str(path), 'w') as f:
        # Avid registers these defs; we need them for the Audio Pan wrapper on A4.
        pan_op = f.create.OperationDef('9d2ea893-0968-11d3-8a38-0050040ef7d2', 'Audio Pan')
        pan_op.media_kind = 'sound'
        pan_op['NumberInputs'].value = 1
        pan_op['IsTimeWarp'].value = False
        pan_op['Bypass'].value = 0
        pan_op['OperationCategory'].value = 'OperationCategory_Effect'
        pan_param = f.create.ParameterDef('e4962322-2267-11d3-8a4c-0050040ef7d2', 'Pan', 'Pan', f.dictionary.lookup_typedef('Rational'))
        f.dictionary.register_def(pan_param)
        pan_op['ParametersDefined'].append(pan_param)
        f.dictionary.register_def(pan_op)

        recorders = {}
        for index, (rec, people) in enumerate(PEOPLE.items()):
            tape, _ = tape_mob(f, f'{rec}_Day3', channels, tc_start=REC_TC[rec], length=REC_LEN)
            mm = master(f, f'{rec}_Day3', [('sound', ch, people[ch - 1]) for ch in range(1, channels + 1)], tape, REC_LEN, REC_TC[rec], f'5F{index:06X}')
            recorders[rec] = mm
            for ch, person in enumerate(people, start=1):
                manifest['people'][person] = {'master_id': str(mm.mob_id), 'master_slot': slot_for(mm, 'sound', ch).slot_id,
                                              'recorder': rec, 'channel': ch}
        cams = {}
        for index, cam in enumerate(CAMS):
            tape, _ = tape_mob(f, f'{cam} Day3', 2, picture=True, tc_start=CAM_TC[cam], length=CAM_LEN)
            cams[cam] = master(f, f'{cam} Day3', [('picture', 1, None), ('sound', 1, None), ('sound', 2, None)],
                               tape, CAM_LEN, CAM_TC[cam], f'6C{index:06X}')

        # Group sync by timecode: each source's offset at the group's first frame.
        audio_alts = {k: [(recorders[r], slot_for(recorders[r], 'sound', k), GROUP_TC - REC_TC[r]) for r in PEOPLE]
                      for k in range(1, channels + 1)}
        pic_alts = [(cams[c], slot_for(cams[c], 'picture', 1), GROUP_TC - CAM_TC[c]) for c in CAMS]

        # The group clip itself (a lower-level composition), untrimmed, defaults R1 / CAM A.
        group = f.create.CompositionMob('GRP Day3 Kitchen')
        group['UsageCode'].value = 'Usage_LowerLevel'
        f.content.mobs.append(group)
        gtc = group.create_timeline_slot(RATE)
        gtc.segment = f.create.Timecode(fps=FPS, drop=False, length=GROUP_LEN)
        gtc.segment.start = GROUP_TC
        gtc['PhysicalTrackNumber'].value = 1
        gv = group.create_timeline_slot(RATE)
        gv.segment = group_selector(f, 'picture', pic_alts, 0, 0, GROUP_LEN)
        gv['PhysicalTrackNumber'].value = 1
        for k in range(1, channels + 1):
            ga = group.create_timeline_slot(RATE)
            ga.segment = group_selector(f, 'sound', audio_alts[k], 0, 0, GROUP_LEN)
            ga['PhysicalTrackNumber'].value = k

        # The edited sequence: two group segments with different angle choices.
        comp = f.create.CompositionMob('Day3 Kitchen Multigroup Edit')
        comp['UsageCode'].value = 'Usage_TopLevel'
        f.content.mobs.append(comp)
        tc = comp.create_timeline_slot(RATE)
        tc.segment = f.create.Timecode(fps=FPS, drop=False)
        tc.segment.start = 86400
        tc['PhysicalTrackNumber'].value = 1
        lead, tail = 48, 52
        nrec = len(PEOPLE)
        segments = [  # (group_in, length, picture choice, recorder choice per audio track)
            (1000, 3000, 0, [0] * channels),
            (6000, 4000, 1, ([1, 2, 0, 3] + [(k * 3 + 1) % nrec for k in range(4, channels)])[:channels]),
        ]
        segments[1][3][:] = [r % nrec for r in segments[1][3]]
        total = lead + sum(s[1] for s in segments) + tail
        tc.segment.length = total
        vslot = comp.create_picture_slot(RATE)
        vslot['PhysicalTrackNumber'].value = 1
        vslot.segment.components.append(f.create.Filler(media_kind='picture', length=lead))
        for gin, length, pic, _ in segments:
            vslot.segment.components.append(group_selector(f, 'picture', pic_alts, pic, gin, length))
        vslot.segment.components.append(f.create.Filler(media_kind='picture', length=tail))
        vslot.segment.length = total
        cursor = lead
        for gin, length, pic, recs in segments:
            manifest['segments'].append({'seq_in': cursor, 'length': length, 'group_in': gin,
                                         'picture': CAMS[pic], 'audio': [list(PEOPLE)[r] for r in recs]})
            cursor += length
        for k in range(1, channels + 1):
            aslot = comp.create_sound_slot(RATE)
            aslot['PhysicalTrackNumber'].value = k
            seq = aslot.segment
            seq.components.append(f.create.Filler(media_kind='sound', length=lead))
            for gin, length, _, recs in segments:
                seq.components.append(group_selector(f, 'sound', audio_alts[k], recs[k - 1], gin, length))
            seq.components.append(f.create.Filler(media_kind='sound', length=tail))
            seq.length = total
            if k == 4:  # older MC exports wrap each audio track in a Mono Audio Pan
                op = f.create.OperationGroup(pan_op, length=total, media_kind='sound')
                aslot.segment = op   # detach seq from slot first by replacing
                op['InputSegments'].append(seq)
                pan = f.create.ConstantValue(pan_param, aaf2.rational.AAFRational('1/2'))
                op['Parameters'].append(pan)
        # One original Avid-style marker on A1, to confirm markers survive the reader.
        ev = f.create.EventMobSlot()
        ev['SlotID'].value = 1000 + 1
        ev['EditRate'].value = RATE
        ev['PhysicalTrackNumber'].value = 1
        eseq = f.create.Sequence(media_kind='DescriptiveMetadata')
        marker = f.create.DescriptiveMarker()
        marker['Position'].value = 100
        marker['Comment'].value = 'Original editor marker'
        marker['DescribedSlots'].value = {next(s.slot_id for s in comp.slots if s.segment.media_kind.lower() == 'sound')}
        eseq.components.append(marker)
        ev.segment = eseq
        comp.slots.append(ev)
        manifest.update(sequence_id=str(comp.mob_id), group_id=str(group.mob_id), lead=lead, total=total)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--recorders', type=int)
    parser.add_argument('--channels', type=int)
    args = parser.parse_args()
    out = Path(args.output)
    if out.exists():
        out.unlink()
    info = build(out, scaled_people(args.recorders, args.channels) if args.recorders else None)
    Path(str(out) + '.json').write_text(json.dumps(info, indent=1))
    print(json.dumps({'output': str(out), 'bytes': out.stat().st_size, 'sequence_id': info['sequence_id']}))
