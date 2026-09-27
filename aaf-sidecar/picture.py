"""Picture as metadata. Video slots are read for their cuts and provenance.

No essence is opened, no locator is followed and no frame is decoded: a
picture clip is a record range plus the names and identities an editor needs
to know where the picture cuts are and what they came from.
"""
from fractions import Fraction
import aaf2
from reader import value, clean_name, append_warning, timecode_segment, round_sample, MAX_DEPTH, MAX_SEGMENTS

# Bounds in the style of the audio reader: a malformed file costs a warning
# and a partial picture lane, never the audio import.
MAX_PICTURE_CLIPS = 100000
MAX_PICTURE_STEPS = 1000000


class Budget(Exception):
    """The picture walk ran out of steps."""


class Steps:
    def __init__(self):
        self.count = 0

    def take(self):
        self.count += 1
        if self.count > MAX_PICTURE_STEPS:
            raise Budget()


def is_muted(selector):
    """Avid writes a muted clip as a Selector that selects Filler (or a
    ScopeReference) and keeps the real clip in Alternates. It is not a group."""
    return isinstance(value(selector, 'Selected'), (aaf2.components.Filler, aaf2.components.ScopeReference))


def slot_rate(slot):
    try:
        rate = Fraction(str(slot.edit_rate))
    except (ValueError, ZeroDivisionError, AttributeError):
        return None
    return rate if 0 < rate <= 192000 else None


def small_int(raw):
    return raw if isinstance(raw, int) and 0 < raw <= 65535 else None


def descriptor_summary(descriptor, slot_id):
    """What a file SourceMob's descriptor says about its picture, or None
    when the mob is not a file mob (a tape or import mob has no FileDescriptor)."""
    if isinstance(descriptor, aaf2.essence.MultipleDescriptor):
        children = list(value(descriptor, 'FileDescriptors') or [])[:256]
        descriptor = (next((d for d in children if value(d, 'LinkedSlotID') == slot_id), None)
                      or next((d for d in children if isinstance(d, aaf2.essence.DigitalImageDescriptor)), None))
    if not isinstance(descriptor, aaf2.essence.FileDescriptor):
        return None
    rate, layout, compression = value(descriptor, 'SampleRate'), value(descriptor, 'FrameLayout'), value(descriptor, 'Compression')
    return {'kind': type(descriptor).__name__,
            'sample_rate': str(rate)[:32] if rate is not None else None,
            'stored_width': small_int(value(descriptor, 'StoredWidth')),
            'stored_height': small_int(value(descriptor, 'StoredHeight')),
            'frame_layout': str(layout)[:64] if layout is not None else None,
            'compression': str(compression)[:64] if compression is not None else None}


def mob_timecode(mob):
    """The mob's own timecode, preferring the slot numbered 1."""
    found = []
    for index, slot in enumerate(mob.slots):
        if index >= 256:
            break
        tc = timecode_segment(slot.segment)
        rate = slot_rate(slot)
        if tc is not None and rate is not None and 0 < (tc.fps or 0) <= 120:
            found.append((value(slot, 'PhysicalTrackNumber'), tc, rate))
    return next((f for f in found if f[0] == 1), found[0] if found else None)


def component_at(sequence, position, steps):
    """The child of a sequence holding `position`, and the offset into it."""
    cursor = Fraction(0)
    for index, child in enumerate(sequence.components):
        steps.take()
        if index >= MAX_SEGMENTS:
            return None
        length = Fraction(child.length or 0)
        if isinstance(child, aaf2.components.Transition):
            cursor -= length
            continue
        if cursor <= position < cursor + length:
            return child, position - cursor
        cursor += length
    return None


def resolve(seg, rate, steps):
    """Follow one record-side component down its source chain to the tape.

    Records the first MasterMob (the clip), the file SourceMob with its
    descriptor, and the deepest non-file SourceMob (the tape or import mob)
    with the source timecode at the clip's in point.
    """
    clip = {'kind': 'clip', 'name': None, 'master_mob_id': None, 'file_mob_id': None, 'tape_name': None,
            'source_start_frame': None, 'source_timecode_fps': None, 'source_drop_frame': None,
            'group': False, 'effect': None, 'descriptor': None}
    position, visited = Fraction(0), set()
    for _ in range(MAX_DEPTH * 4):
        steps.take()
        if isinstance(seg, aaf2.components.Selector):
            if is_muted(seg):
                clip['kind'] = 'muted'
                alternates = list(value(seg, 'Alternates') or [])
                if not alternates:
                    break
                # Name the muted clip after what it hides.
                seg = alternates[0]
                continue
            clip['group'] = True
            seg = value(seg, 'Selected')
            continue
        if isinstance(seg, aaf2.components.OperationGroup):
            operation = value(seg, 'Operation')
            clip['effect'] = clip['effect'] or clean_name(getattr(operation, 'name', None), 'Effect')
            inputs = list(value(seg, 'InputSegments') or [])
            if not inputs:
                break
            seg = inputs[0]
            continue
        if isinstance(seg, aaf2.components.Sequence):
            found = component_at(seg, position, steps)
            if found is None:
                break
            seg, position = found
            continue
        if not isinstance(seg, aaf2.components.SourceClip):
            break
        mob, slot = seg.mob, seg.slot
        if mob is None or slot is None or (str(mob.mob_id), slot.slot_id) in visited:
            break
        visited.add((str(mob.mob_id), slot.slot_id))
        target = slot_rate(slot)
        if target is None:
            break
        position, rate = Fraction(seg.start or 0) + position * target / rate, target
        if isinstance(mob, aaf2.mobs.MasterMob):
            if clip['master_mob_id'] is None:
                clip['master_mob_id'] = str(mob.mob_id)
                clip['name'] = clean_name(mob.name, '') or clip['name']
        elif isinstance(mob, aaf2.mobs.CompositionMob):
            clip['name'] = clip['name'] or clean_name(mob.name, '') or None
        elif isinstance(mob, aaf2.mobs.SourceMob):
            summary = descriptor_summary(value(mob, 'EssenceDescription'), slot.slot_id)
            if summary is not None:
                if clip['file_mob_id'] is None:
                    clip['file_mob_id'], clip['descriptor'] = str(mob.mob_id), summary
            else:
                clip['tape_name'] = clean_name(mob.name, '') or None
            timecode = mob_timecode(mob)
            if timecode is not None and (summary is None or clip['source_start_frame'] is None):
                _, tc, tc_rate = timecode
                frame = int(tc.start or 0) + round_sample(position * tc_rate / rate)
                if frame >= 0:
                    clip.update(source_start_frame=frame, source_timecode_fps=int(tc.fps), source_drop_frame=bool(tc.drop))
        seg = slot.segment
    if clip['kind'] == 'muted':
        clip['group'] = False
    return clip


def flatten(segment, steps, depth=0):
    """Record-side components of a picture slot with their start and length,
    in slot edit units. A transition overlaps its neighbours, as in Avid."""
    if depth > MAX_DEPTH:
        return []
    if not isinstance(segment, aaf2.components.Sequence):
        return [(segment, Fraction(0), Fraction(segment.length or 0))]
    items, cursor = [], Fraction(0)
    for index, child in enumerate(segment.components):
        steps.take()
        if index >= MAX_SEGMENTS:
            break
        length = Fraction(child.length or 0)
        if isinstance(child, aaf2.components.Transition):
            cursor -= length
            continue
        if isinstance(child, aaf2.components.Sequence):
            items.extend((c, cursor + at, span) for c, at, span in flatten(child, steps, depth + 1))
        else:
            items.append((child, cursor, length))
        cursor += length
    return items


def track_entry(slot):
    return {'slot_id': slot.slot_id, 'physical_track_number': value(slot, 'PhysicalTrackNumber'),
            'name': clean_name(slot.name, 'Picture'), 'component': type(slot.segment).__name__, 'clips': []}


def picture_track(slot, sequence_rate, warnings, steps):
    track = track_entry(slot)
    rate = slot_rate(slot)
    if rate is None:
        append_warning(warnings, 'A picture track has an invalid edit rate. Its cuts are not shown.')
        return track
    for component, start, length in flatten(slot.segment, steps):
        if isinstance(component, (aaf2.components.Filler, aaf2.components.Timecode)) or length <= 0:
            continue
        first = round_sample(start * sequence_rate / rate)
        end = round_sample((start + length) * sequence_rate / rate)
        if first < 0 or end <= first:
            continue
        if len(track['clips']) >= MAX_PICTURE_CLIPS:
            append_warning(warnings, 'A picture track has more clips than are read. The rest of its cuts are not shown.')
            break
        clip = resolve(component, rate, steps)
        clip.update(start_frame=first, duration_frames=end - first)
        track['clips'].append(clip)
    return track


def picture_tracks(slots, sequence_rate, warnings):
    """Every picture slot of the chosen sequence, with its clips as metadata.
    One step budget covers them all; running out costs clips, never audio."""
    steps, tracks, exhausted = Steps(), [], False
    for slot in slots:
        if not exhausted:
            try:
                tracks.append(picture_track(slot, sequence_rate, warnings, steps))
                continue
            except Budget:
                exhausted = True
                append_warning(warnings, 'The picture tracks are too complex to read fully. Audio is not affected.')
        tracks.append(track_entry(slot))
    return tracks
