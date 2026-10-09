"""Write an edit back to Avid as a metadata-only AAF, then prove it.

The request is an edit: a list of source ranges and gaps, laid end to end, on
a fixed set of output tracks. Every source range is copied out of the
ORIGINAL sequence, component by component, and trimmed exactly at its frame
boundaries. Nothing is re-derived from media and no mob is re-minted: every
MasterMob, SourceMob and group CompositionMob the new sequence points at is
copied from its source AAF with its original MobID, because Media Composer
relinks by MobID and by nothing else. No essence is ever written.

Two ways to carry a group (multicam) edit:

- ``C`` copies the group Selector for the range, trims every alternate with
  it and keeps the angle the editor chose. The group stays switchable.
- ``B`` follows what plays down to the speaker's master clip channel and
  references that directly. Match Frame lands on the master clip.

A track may also name group angles (``choices``) to play instead of the one
the editor chose: a person who is an alternate inside a group gets a track of
their own, silent outside the groups that offer their mic. ``C`` keeps the
group with that angle selected; ``B`` goes to that angle's master clip.

After writing, the file is re-read with the app's own reader
(``graph.GraphTimeline``) and every output frame of every track is compared
with the source frame it was cut from: same source mob, same channel, same
sample. A file that fails that comparison is never published.

Group packs. A kept group clip is a CompositionMob that can refer to every
clip in the show (HEAT 2's V1: 176 slots), and the Edit Protocol wants all of
it in the file, whole, with its original MobIDs, however short the cut. So the
size is fixed; the time is not. With ``pack_dir`` the closure of the group
mobs an edit refers to is written once per source into a cached AAF (a pack),
checked once when it is built, and every later export copies that file, opens
it ``rw`` and adds only its own sequence and whatever mobs the pack lacks.
The pack holds exactly the closure of the referenced group mobs, so the output
is the same set of mobs a full export writes.

Research and measurements behind this: docs/AAF-ASSEMBLY-RESEARCH.md
("Getting the cut back into Avid"), docs/research/aaf-stringout-spike/ and
docs/STRING-OUTS-SPEC-2026-10-03.md (phase 4).
"""
from contextlib import ExitStack
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace
import hashlib
import json
import math
import os
import shutil
import tempfile

import aaf2
from aaf2.auid import AUID
from aaf2.components import (Filler, OperationGroup, ScopeReference, Selector, Sequence, SourceClip,
                             SourceReference, Transition)
from aaf2.misc import TaggedValueHelper, VaryingValue

from graph import GraphTimeline, choice_id
from picture import is_muted
from reader import (MAX_DEPTH, ReaderError, clean_name, fail, fingerprint, media_kind, pending_file,
                    rate_of, value)

SCHEMA_VERSION = 1
# Edit requests that carry per-track overrides (a record track as a layer).
OVERRIDES_SCHEMA_VERSION = 2
# Bump whenever what the writer puts in a file changes: a group pack names the
# version that built it, so a pack from another version is never reused.
WRITER_VERSION = 3
# Media Composer's pointer from one mob to another off the timeline: the
# PortableObject of a mob attribute, which Avid names `_MATCH`. A group's sync
# CompositionMob, the one a sequence cuts from, names its group clip this way,
# and Media Composer follows it to play the group. Nothing on the timeline
# refers to the group clip, so a closure that followed SourceReferences alone
# left it behind, and Avid stopped playback with "PlayPipe::DoComp()
# encountered a missing mob" (HEAT 1, 2026-10-07).
AVID_MOB_REFERENCE = AUID('6619f8e0-fe77-11d3-a084-006094eb75cb')
MAX_REQUEST_BYTES = 64 * 1024 * 1024
MAX_EDITS = 256
MAX_TRACKS = 256
# Media Composer's audio track ceiling, and the reader's, so the self-check
# can re-read every track that is written.
MAX_SOUND_TRACKS = 64
MAX_SEGMENTS = 100000
MAX_SOURCES = 256
MAX_MARKERS = 100000
MAX_TEXT = 5000
MAX_DURATION_SECONDS = 24 * 60 * 60
MAX_CLONE_DEPTH = MAX_DEPTH * 4
MAX_CHOICES = 64
RAW_AUDIO_EFFECTS = ('Audio Pan', 'Audio Gain')
FADES = ('FadeInLength', 'FadeInType', 'FadeOutLength', 'FadeOutType')
# Media Composer's portable marker colours: the eight its text import accepts.
MARKER_RGB = {'Red': (41471, 12134, 6564), 'Green': (13107, 52428, 13107), 'Blue': (13107, 13107, 52428),
              'Cyan': (13107, 52428, 52428), 'Magenta': (52428, 13107, 52428), 'Yellow': (58981, 58981, 6553),
              'White': (65535, 65535, 65535), 'Black': (0, 0, 0)}


def invalid(message):
    fail(message, 'invalid_input')


def whole(item, key, minimum=0, where='request'):
    number = item.get(key) if isinstance(item, dict) else None
    if type(number) is not int or number < minimum:
        invalid(f'{where}: "{key}" must be a whole number of at least {minimum}.')
    return number


def text(item, key, where, required=False, limit=MAX_TEXT):
    raw = item.get(key, '')
    if raw is None:
        raw = ''
    if not isinstance(raw, str) or len(raw) > limit:
        invalid(f'{where}: "{key}" must be text of at most {limit} characters.')
    cleaned = ''.join(c for c in raw if c >= ' ' and c != '\x7f' or c == '\t').strip()
    if required and not cleaned:
        invalid(f'{where}: "{key}" is required.')
    return cleaned


def absolute(raw, where):
    if not isinstance(raw, str) or not raw or '\x00' in raw or len(raw) > 4096 or not os.path.isabs(raw):
        invalid(f'{where} must be an absolute path.')
    return Path(raw)


def parse_rate(raw):
    try:
        if isinstance(raw, dict):
            rate = Fraction(whole(raw, 'numerator', 1, 'edit_rate'), whole(raw, 'denominator', 1, 'edit_rate'))
        elif isinstance(raw, str) and len(raw) <= 32:
            rate = Fraction(raw)
        else:
            raise ValueError
    except (ValueError, ZeroDivisionError):
        invalid('edit_rate must be a rational such as "24000/1001".')
    if not 0 < rate <= 120:
        invalid('edit_rate must be a video rate above 0 and at most 120.')
    return rate


def validate(request):
    """Strict shape and bound checks. Nothing here opens a file for writing."""
    if not isinstance(request, dict):
        invalid('The edit request must be a JSON object.')
    version = request.get('schema_version')
    if version not in (SCHEMA_VERSION, OVERRIDES_SCHEMA_VERSION):
        invalid(f'Unsupported edit request schema_version; expected {SCHEMA_VERSION} or {OVERRIDES_SCHEMA_VERSION}.')
    spec = {'name': clean_name(text(request, 'name', 'request', True, 240), 'Sequence'),
            'edit_rate': parse_rate(request.get('edit_rate')),
            'start_tc': whole(request, 'start_timecode_frames'),
            'approach': request.get('approach')}
    if spec['approach'] not in ('B', 'C'):
        invalid('approach must be "B" or "C".')

    sources = request.get('sources')
    if not isinstance(sources, list) or not 1 <= len(sources) <= MAX_SOURCES:
        invalid(f'sources must list between 1 and {MAX_SOURCES} source AAFs.')
    spec['sources'] = {}
    for index, source in enumerate(sources):
        where = f'sources[{index}]'
        if not isinstance(source, dict):
            invalid(f'{where} must be an object.')
        key = text(source, 'id', where, True, 128)
        if key in spec['sources']:
            invalid(f'{where}: source id "{key}" is used twice.')
        sequence = text(source, 'sequence_id', where, True, 256)
        try:
            aaf2.mobid.MobID(sequence)
        except Exception:  # pyaaf2 asserts on a malformed URN
            invalid(f'{where}: sequence_id is not a MobID.')
        spec['sources'][key] = {'id': key, 'path': absolute(source.get('aaf_path'), f'{where}.aaf_path'),
                                'sequence_id': sequence}

    tracks = request.get('tracks')
    if not isinstance(tracks, list) or not 1 <= len(tracks) <= MAX_TRACKS:
        invalid(f'tracks must list between 1 and {MAX_TRACKS} output tracks.')
    spec['tracks'], numbers = [], set()
    for index, track in enumerate(tracks):
        where = f'tracks[{index}]'
        if not isinstance(track, dict) or track.get('kind') not in ('sound', 'picture'):
            invalid(f'{where}: kind must be "sound" or "picture".')
        number = whole(track, 'physical_track_number', 1, where)
        if (track['kind'], number) in numbers:
            invalid(f'{where}: {track["kind"]} track {number} is listed twice.')
        numbers.add((track['kind'], number))
        slots = track.get('source_slots')
        if not isinstance(slots, dict):
            invalid(f'{where}: source_slots must map source ids to slot ids.')
        for key, slot in slots.items():
            if key not in spec['sources']:
                invalid(f'{where}: source_slots names unknown source "{key}".')
            if type(slot) is not int or slot < 0:
                invalid(f'{where}: the slot for source "{key}" must be a slot id.')
        choices = track.get('choices', {})
        if not isinstance(choices, dict) or (choices and track['kind'] != 'sound'):
            invalid(f'{where}: choices must map source ids to group angles, on a sound track.')
        for key, angles in choices.items():
            if key not in slots:
                invalid(f'{where}: choices names source "{key}", which the track does not use.')
            if (not isinstance(angles, list) or not 1 <= len(angles) <= MAX_CHOICES
                    or not all(isinstance(angle, str) and 0 < len(angle) <= 512 for angle in angles)):
                invalid(f'{where}: the choices for source "{key}" must list group angles.')
        # A track may write its groups its own way: picture that stays a
        # switchable multigroup (C) while each person's audio is the clip that
        # plays (B), so twenty lavs do not become twenty-way groups per bite.
        approach = track.get('approach', spec['approach'])
        if approach not in ('B', 'C'):
            invalid(f'{where}: approach must be "B" or "C".')
        spec['tracks'].append({'kind': track['kind'], 'number': number, 'slots': dict(slots), 'approach': approach,
                               'choices': {key: frozenset(angles) for key, angles in choices.items()}})
    sound = sum(t['kind'] == 'sound' for t in spec['tracks'])
    if not 1 <= sound <= MAX_SOUND_TRACKS:
        invalid(f'An edit needs between 1 and {MAX_SOUND_TRACKS} sound tracks.')

    segments = request.get('segments')
    if not isinstance(segments, list) or not 1 <= len(segments) <= MAX_SEGMENTS:
        invalid(f'segments must list between 1 and {MAX_SEGMENTS} segments.')
    spec['segments'], cursor = [], 0
    for index, segment in enumerate(segments):
        where = f'segments[{index}]'
        if not isinstance(segment, dict) or segment.get('kind') not in ('source', 'gap'):
            invalid(f'{where}: kind must be "source" or "gap".')
        if segment['kind'] == 'gap':
            item = {'kind': 'gap', 'length': whole(segment, 'frames', 1, where)}
        else:
            key = segment.get('source')
            if key not in spec['sources']:
                invalid(f'{where}: unknown source "{key}".')
            first, last = whole(segment, 'in_frame', 0, where), whole(segment, 'out_frame', 1, where)
            if last <= first:
                invalid(f'{where}: out_frame must be after in_frame.')
            item = {'kind': 'source', 'source': key, 'in': first, 'out': last, 'length': last - first}
        item['start'] = cursor
        cursor += item['length']
        spec['segments'].append(item)
    spec['length'] = cursor
    if Fraction(cursor) / spec['edit_rate'] > MAX_DURATION_SECONDS:
        invalid('The edit is longer than 24 hours.')

    mutes = request.get('mutes', [])
    if not isinstance(mutes, list) or len(mutes) > MAX_SEGMENTS:
        invalid(f'mutes must be a list of at most {MAX_SEGMENTS} entries.')
    spec['mutes'] = {}
    for index, mute in enumerate(mutes):
        where = f'mutes[{index}]'
        at, track = whole(mute, 'segment_index', 0, where), whole(mute, 'track_index', 0, where)
        if at >= len(spec['segments']) or track >= len(spec['tracks']):
            invalid(f'{where}: segment_index or track_index is out of range.')
        first, last = whole(mute, 'from_frame', 0, where), whole(mute, 'to_frame', 1, where)
        if last <= first or last > spec['segments'][at]['length']:
            invalid(f'{where}: the muted range must lie inside its segment.')
        # `keep`: the editor muted it, so it stays on the track as Media
        # Composer's muted clip. Without it, filler: a track nobody plays.
        keep = mute.get('keep', False)
        if not isinstance(keep, bool):
            invalid(f'{where}: keep must be true or false.')
        spec['mutes'].setdefault((at, track), []).append((first, last, keep))

    # A track that plays other material across one whole segment: a source
    # slot of its own from its own frame, for the segment's length. This is a
    # record track as a layer, as in Avid: A1 can carry one mic for one clip and
    # another mic, or the same mic from elsewhere, for the next; and the video
    # track stacked with it carries the picture of that same moment, so two
    # voices from different times each keep their own picture.
    # A request that uses it says version 2, so a writer that predates it
    # refuses rather than writing the segment's own audio there.
    overrides = request.get('overrides', [])
    if not isinstance(overrides, list) or len(overrides) > MAX_SEGMENTS * MAX_SOUND_TRACKS:
        invalid('overrides must be a list of segment and track pairs.')
    if overrides and version != OVERRIDES_SCHEMA_VERSION:
        invalid(f'overrides need schema_version {OVERRIDES_SCHEMA_VERSION}.')
    spec['overrides'] = {}
    for index, override in enumerate(overrides):
        where = f'overrides[{index}]'
        if not isinstance(override, dict):
            invalid(f'{where} must be an object.')
        at, track = whole(override, 'segment_index', 0, where), whole(override, 'track_index', 0, where)
        if at >= len(spec['segments']) or track >= len(spec['tracks']) or (at, track) in spec['overrides']:
            invalid(f'{where}: segment_index or track_index is out of range or listed twice.')
        segment = spec['segments'][at]
        if segment['kind'] != 'source':
            invalid(f'{where}: only a source segment can play other material.')
        key = override.get('source')
        if key not in spec['sources']:
            invalid(f'{where}: unknown source "{key}".')
        slot = override.get('slot')
        if type(slot) is not int or slot < 0:
            invalid(f'{where}: slot must be a slot id.')
        first = whole(override, 'in_frame', 0, where)
        choices = override.get('choices', [])
        if choices and spec['tracks'][track]['kind'] != 'sound':
            invalid(f'{where}: group angles are chosen on a sound track only.')
        if (not isinstance(choices, list) or len(choices) > MAX_CHOICES
                or not all(isinstance(angle, str) and 0 < len(angle) <= 512 for angle in choices)):
            invalid(f'{where}: choices must list group angles.')
        spec['overrides'][(at, track)] = {'kind': 'source', 'source': key, 'slot': slot, 'in': first,
                                          'out': first + segment['length'], 'length': segment['length'],
                                          'start': segment['start'], 'choices': frozenset(choices)}
    # Deliberate edits (String Outs' Add Edit) on a track where its material
    # carries on: kept as edits. Everywhere else a track that simply carries on
    # across a segment boundary is written as one clip (runs). Optional and
    # ignored by older writers, which wrote a piece per segment anyway.
    cuts = request.get('cuts', [])
    if not isinstance(cuts, list) or len(cuts) > MAX_SEGMENTS * MAX_SOUND_TRACKS:
        invalid('cuts must be a list of segment and track pairs.')
    spec['cuts'] = set()
    for index, cut in enumerate(cuts):
        where = f'cuts[{index}]'
        if not isinstance(cut, dict):
            invalid(f'{where} must be an object.')
        at, track = whole(cut, 'segment_index', 0, where), whole(cut, 'track_index', 0, where)
        if at >= len(spec['segments']) or track >= len(spec['tracks']):
            invalid(f'{where}: segment_index or track_index is out of range.')
        spec['cuts'].add((at, track))
    # Every source segment reaches some track, through a track's slot or an override.
    for at, segment in enumerate(spec['segments']):
        if segment['kind'] == 'source' and not any(segment['source'] in t['slots'] for t in spec['tracks']) \
                and not any(where[0] == at for where in spec['overrides']):
            invalid(f'segments[{at}]: source "{segment["source"]}" is not mapped to any output track.')

    markers = request.get('markers', [])
    if not isinstance(markers, list) or len(markers) > MAX_MARKERS:
        invalid(f'markers must be a list of at most {MAX_MARKERS} entries.')
    spec['markers'] = []
    colours = {name.lower(): name for name in MARKER_RGB}
    for index, marker in enumerate(markers):
        where = f'markers[{index}]'
        frame, track = whole(marker, 'frame', 0, where), whole(marker, 'track_index', 0, where)
        if frame >= spec['length'] or track >= len(spec['tracks']):
            invalid(f'{where}: frame or track_index is outside the edit.')
        colour = marker.get('color', 'Red') if isinstance(marker, dict) else None
        if not isinstance(colour, str) or colour.lower() not in colours:
            invalid(f'{where}: color must be one of {", ".join(MARKER_RGB)}.')
        spec['markers'].append({'frame': frame, 'track': track, 'color': colours[colour.lower()],
                                'name': text(marker, 'name', where, False, 240) or 'Sauce Bunny',
                                'comment': text(marker, 'comment', where)})
    spec['markers'].sort(key=lambda m: (m['track'], m['frame']))

    output = absolute(request.get('output_path'), 'output_path')
    if output.suffix.lower() != '.aaf':
        invalid('output_path must end in .aaf.')
    if any(output == s['path'] for s in spec['sources'].values()):
        invalid('output_path must not be one of the source AAFs.')
    spec['output'] = output
    spec['markers_output'] = output.with_name(output.stem + ' - Avid markers.txt') if spec['markers'] else None
    spec['pack_dir'] = None
    if request.get('pack_dir') is not None:
        spec['pack_dir'] = absolute(request['pack_dir'], 'pack_dir')
        if not spec['pack_dir'].is_dir():
            invalid('pack_dir must be an existing folder.')
    return spec


# ---------------------------------------------------------------- timecode
def timecode(frame, fps, drop):
    """HH:MM:SS:FF (NDF) or HH:MM:SS;FF (DF, 30 and 60 fps families)."""
    if drop:
        skip = fps // 15                                    # 2 at 29.97, 4 at 59.94
        per_ten = fps * 600 - skip * 9
        tens, rest = divmod(frame, per_ten)
        frame += skip * 9 * tens + (skip * ((rest - skip) // (fps * 60 - skip)) if rest > skip else 0)
    frames, seconds = frame % fps, frame // fps
    hours = (seconds // 3600) % 24
    return f'{hours:02}:{seconds // 60 % 60:02}:{seconds % 60:02}{";" if drop else ":"}{frames:02}'


def avid_marker_text(spec, tracks, fps, drop):
    """Media Composer Markers window import: Name, TC, Track, Colour, Comment,
    Duration. Tab separated, no header, LF, UTF-8 without a BOM."""
    lines = []
    for marker in sorted(spec['markers'], key=lambda m: (m['frame'], m['track'])):
        track = tracks[marker['track']]
        cells = [marker['name'], timecode(spec['start_tc'] + marker['frame'], fps, drop),
                 ('V' if track['kind'] == 'picture' else 'A') + str(track['number']),
                 marker['color'].lower(), marker['comment'], '1']
        lines.append('\t'.join(' '.join(cell.split()) for cell in cells))
    return '\n'.join(lines) + '\n'


# ---------------------------------------------------------------- copy + trim
def conform(seg, rate):
    """Avid's Motion Control used as a frame-rate conform, as `(ratio, clip,
    phase)`, or None for any other time warp.

    A 47.952 or 59.94 camera in a 23.976 group plays at real speed through a
    Motion Control whose constant SpeedRatio is the group rate over the
    camera's (1/2, 2/5), over one clip (bare, or alone in a Sequence) on a
    slot that runs at the camera's rate. HEAT 1's V1 group has 45 such angles
    of 75. Media Composer places the clip on the source frame under the
    group's first frame, rounded down: input start = floor(G / ratio) for
    group frame G. So `phase` (in source frames, under 1) is where group frame
    0 of this component falls after that start, and a trim at group frame `o`
    begins at floor(phase + o / ratio). Anything that does not fit that shape
    exactly is not a conform this writer knows how to cut.
    """
    operation = value(seg, 'Operation')
    inputs = list(value(seg, 'InputSegments') or [])
    params = list(value(seg, 'Parameters') or [])
    if not value(operation, 'IsTimeWarp') or len(inputs) != 1 or any(isinstance(p, VaryingValue) for p in params):
        return None
    ratio = next((Fraction(p.value) for p in params if p.name == 'SpeedRatio'), None)
    inner = inputs[0]
    clips = [inner] if isinstance(inner, SourceClip) else list(inner.components) if isinstance(inner, Sequence) else []
    if not ratio or len(clips) != 1 or not isinstance(clips[0], SourceClip) or clips[0].slot is None:
        return None
    clip = clips[0]
    if Fraction(rate_of(clip.slot)) != Fraction(rate) / ratio:
        return None
    phase = math.ceil(clip.start * ratio) / ratio - clip.start
    if not 0 <= phase < 1 or inner.length < math.ceil(phase + seg.length / ratio):
        return None
    return ratio, clip, phase


def selected_index(seg, alternates):
    """Where the playing angle sits in the group's angle list. Media Composer
    records it as `_AAF_SELECTED` and lists the alternates in angle order
    without it, so the list is the alternates with Selected put back at that
    index (all 44 groups of HEAT 1 read so). 0 when the attribute is absent."""
    found = next((t.value for t in value(seg, 'ComponentAttributeList') or [] if t.name == '_AAF_SELECTED'), None)
    return found if isinstance(found, int) and 0 <= found <= alternates else 0


def angles_of(seg):
    """A group's angles in Avid's order, and the index of the one that plays."""
    alternates = list(value(seg, 'Alternates') or [])
    at = selected_index(seg, len(alternates))
    return alternates[:at] + [value(seg, 'Selected')] + alternates[at:], at


class Cloner:
    """Copies one source sequence's components into the new file, trimmed.

    Positions are edit units of `rate` (the sequence rate). A SourceClip's
    StartTime is in the REFERENCED slot's units, so a trim is converted and a
    non-integer result is refused rather than rounded.
    """

    def __init__(self, dst, rate, approach, warnings):
        self.dst, self.rate, self.approach, self.warnings = dst, rate, approach, warnings
        self.references = set()
        # The group angles the track being built asks for, and whether the
        # copy is inside a group that offers one. With angles asked for,
        # nothing outside such a group is written: the track is that person.
        self.prefer, self.inside = frozenset(), False

    def warn(self, message):
        if message not in self.warnings and len(self.warnings) < 32:
            self.warnings.append(message)

    def clone(self, seg, offset, length, depth=0, muted_ok=False):
        if depth > MAX_CLONE_DEPTH:
            fail('The source graph is too deep to copy.', 'limit_exceeded')
        if offset < 0 or length <= 0 or offset + length > seg.length:
            fail(f'A cut reaches outside a {type(seg).__name__} of {seg.length} frames.', 'invalid_media')
        if isinstance(seg, SourceClip):
            return self.source_clip(seg, offset, length, depth)
        if isinstance(seg, Filler):
            return self.dst.create.Filler(media_kind=seg.media_kind, length=length)
        if isinstance(seg, ScopeReference) and muted_ok:
            # Media Composer writes a muted clip as a Selector whose selected
            # item is a ScopeReference or Filler. It plays nothing.
            return self.dst.create.Filler(media_kind=seg.media_kind, length=length)
        if isinstance(seg, Selector):
            selected = value(seg, 'Selected')
            options = [selected, *(value(seg, 'Alternates') or [])]
            angles, _ = angles_of(seg)
            chosen = next((option for option in options if option is not None and choice_id(option) in self.prefer),
                          None) if self.prefer and not is_muted(seg) else None
            if self.prefer and not self.inside and chosen is None:
                # Not this group's angle: keep looking in what it plays, as the
                # reader does. An angle inside an UNSELECTED option would need
                # both choices made, which a track's list cannot say, and
                # writing silence there would pass the self-check, so refuse.
                if any(self.offers(option, depth + 1) for option in options[1:] if option is not None):
                    fail('A person given a track here is an angle inside a group that is itself an unselected '
                         'angle of another group. Switch the outer group to that angle in Avid, export the AAF '
                         'again, then export this string out.', 'unsupported_aaf')
                return self.clone(selected, offset, length, depth + 1, True)
            play = selected if chosen is None else chosen
            previous, self.inside = self.inside, self.inside or chosen is not None
            try:
                if self.approach == 'B':
                    return self.clone(play, offset, length, depth + 1, True)
                new = copy_without(seg, self.dst, ('Selected', 'Alternates'))   # keeps Avid's attributes
                new['Selected'].value = self.clone(play, offset, length, depth + 1, True)
                # Every angle, in Avid's order: the group must be the one the
                # editor switches in Media Composer, not a smaller one.
                new['Alternates'].value = [self.angle(a, number, len(angles), offset, length, depth)
                                           for number, a in enumerate(angles, 1) if a is not play and a is not None]
                if play is not selected:
                    at = next(i for i, a in enumerate(angles) if a is play)
                    for tag in value(new, 'ComponentAttributeList') or []:
                        if tag.name == '_AAF_SELECTED':
                            tag.value = at
                new.length = length
                return new
            finally:
                self.inside = previous
        if isinstance(seg, Sequence):
            return self.sequence(seg, offset, length, depth)
        if isinstance(seg, OperationGroup):
            return self.operation(seg, offset, length, depth)
        fail(f'{type(seg).__name__} components cannot be copied into a new sequence. Render or remove it in Avid.')

    def angle(self, option, number, total, offset, length, depth):
        """One angle a kept group can switch to. This used to leave an angle it
        could not cut out of the group with a warning. Every one it left out
        was a camera conformed to the group's rate (HEAT 2's "slow-motion"
        camera was a 59.94 conform at real speed, and HEAT 1's V1 lost 45 of
        its 75 angles), and a group with angles missing is not the group in
        Avid. So an angle that cannot be copied exactly stops the export."""
        try:
            return self.clone(option, offset, length, depth + 1, True)
        except ReaderError as error:
            raise ReaderError(error.code, f'Angle {number} of {total} in this group cannot be copied exactly, and a '
                              f'group with an angle missing would not match the one in Avid. {error}') from None

    def offers(self, seg, depth):
        """Whether a group below `seg` offers one of the angles being sought."""
        if depth > MAX_CLONE_DEPTH or seg is None:
            return False
        if isinstance(seg, Selector):
            options = [value(seg, 'Selected'), *(value(seg, 'Alternates') or [])]
            return any(o is not None and (choice_id(o) in self.prefer or self.offers(o, depth + 1)) for o in options)
        if isinstance(seg, Sequence):
            return any(self.offers(c, depth + 1) for c in seg.components)
        if isinstance(seg, OperationGroup):
            return any(self.offers(i, depth + 1) for i in value(seg, 'InputSegments') or [])
        if isinstance(seg, SourceClip) and isinstance(seg.mob, aaf2.mobs.CompositionMob) and seg.slot is not None:
            return self.offers(seg.slot.segment, depth + 1)
        return False

    def source_clip(self, seg, offset, length, depth):
        if seg.mob_id is None or seg.mob_id.int == 0:
            clip = seg.copy(root=self.dst)                 # end of a chain: nothing to point at
            clip.length = length
            return clip
        target = seg.slot
        if target is None:
            fail(f'A clip points at {seg.mob_id} slot {seg.slot_id}, which is not in the source AAF. '
                 'Export it again with its master clips.', 'missing_media')
        target_rate = rate_of(target)
        seeking = self.prefer and not self.inside
        if seeking and not isinstance(seg.mob, aaf2.mobs.CompositionMob):
            return self.dst.create.Filler(media_kind=seg.media_kind, length=length)
        # Looking for an angle, C also opens a group clip it would otherwise
        # copy whole: the angle is chosen on the Selector inside it.
        if (self.approach == 'B' or seeking) and isinstance(seg.mob, aaf2.mobs.CompositionMob):
            # A group or submaster clip: follow it to the clip that plays.
            if target_rate != self.rate:
                fail('A nested group runs at a different edit rate. Use approach C for this bite.' if not seeking else
                     'A nested group runs at a different edit rate, so an angle inside it cannot be chosen.')
            return self.clone(target.segment, seg.start + offset, length, depth + 1, True)
        clip = seg.copy(root=self.dst)
        clip.start = seg.start + trim_units(offset, target_rate, self.rate)
        clip.length = length
        keep_in, keep_out = offset == 0, offset + length == seg.length
        for key in FADES:
            if key in clip and not (keep_in if key.startswith('FadeIn') else keep_out):
                del clip[key]
                self.warn('A fade on a trimmed clip was removed; the cut is hard.')
        self.references.add(str(seg.mob_id))
        return clip

    def sequence(self, seg, offset, length, depth):
        children = list(seg.components)
        placed, cursor = [], 0
        for index, child in enumerate(children):
            if isinstance(child, Transition):
                if index in (0, len(children) - 1) or isinstance(children[index - 1], Transition):
                    fail('A transition has no clip on one side.', 'invalid_media')
                cursor -= child.length
                placed.append((child, cursor))
                continue
            placed.append((child, cursor))
            cursor += child.length
        if cursor != seg.length:
            fail('A sequence component length is inconsistent.', 'invalid_media')
        end, parts, transitions = offset + length, [], False
        for child, start in placed:
            left, right = max(offset, start), min(end, start + child.length)
            if left >= right:
                continue
            if isinstance(child, Transition):
                if left != start or right != start + child.length:
                    fail(f'The cut at frame {offset if left == offset else end} of this clip splits a '
                         f'{child.length}-frame transition. Move the cut off the dissolve.', 'transition_split')
                parts.append(child.copy(root=self.dst))
                transitions = True
                continue
            parts.append(self.clone(child, left - start, right - left, depth + 1))
        # A Sequence carrying Avid's attributes stays a Sequence, and the copy
        # keeps them: a conformed camera's one-clip Sequence says in
        # `_MIXMATCH_RATE_NUM`/`_DENOM` which rate its frames are counted in.
        # A bare one made Media Composer count them at the group's rate, so it
        # cut the wrong frames and, past the group's length in those units,
        # imported "out-of-bounds reference, substituting filler" (HEAT 1,
        # 2026-10-07).
        if len(parts) == 1 and not transitions and not value(seg, 'ComponentAttributeList'):
            return parts[0]
        new = copy_without(seg, self.dst, ('Components',))
        new['Components'].value = parts
        new.length = length
        return new

    def operation(self, seg, offset, length, depth):
        operation = value(seg, 'Operation')
        name = str(operation.name)
        inputs = list(value(seg, 'InputSegments') or [])
        params = list(value(seg, 'Parameters') or [])
        if value(operation, 'IsTimeWarp'):
            warp = conform(seg, self.rate)
            if warp is None:
                fail(f'{name} changes speed. Render it in Avid before exporting the bite.')
            return self.conformed(seg, warp, offset, length, depth)
        if any(i.length != seg.length for i in inputs):
            fail(f'{name} has inputs of another length. Render it in Avid before exporting the bite.')
        if any(isinstance(p, VaryingValue) for p in params):
            if name in RAW_AUDIO_EFFECTS and len(inputs) == 1:
                # Keyframes are normalised to the effect's old length, so a trim
                # would move them. Same policy as the reader: raw microphone.
                self.warn(f'Automated {name} was not carried into the new sequence (raw microphone audio).')
                return self.clone(inputs[0], offset, length, depth + 1)
            fail(f'Keyframed {name} cannot be trimmed. Render it in Avid before exporting the bite.')
        # Rendering is a render of the untrimmed effect; it does not travel.
        new = copy_without(seg, self.dst, ('InputSegments', 'Rendering'))
        new['InputSegments'].value = [self.clone(i, offset, length, depth + 1) for i in inputs]
        new.length = length
        return new

    def conformed(self, seg, warp, offset, length, depth):
        """A camera conformed to the group's rate, trimmed the way Media
        Composer trims one (read off its own export of HEAT 1): the clip starts
        on the source frame under the first group frame, rounded down, and ends
        on the one under the end, rounded up, so a 59.94 bite of 45 frames can
        hold 113 source frames. The input stays a one-clip Sequence and the
        effect keeps every parameter and attribute Avid gave it."""
        ratio, _, phase = warp
        if self.approach == 'B' or (self.prefer and not self.inside):
            fail('A camera Avid conforms to the group frame rate plays here, and following it to its master clip '
                 'would lose where its frames fall. Send this track with its groups kept.', 'unsupported_aaf')
        inner = value(seg, 'InputSegments')[0]
        first = math.floor(phase + offset / ratio)
        last = math.ceil(phase + (offset + length) / ratio)
        rate, self.rate = self.rate, Fraction(self.rate) / ratio
        try:
            trimmed = self.clone(inner, first, last - first, depth + 1)
        finally:
            self.rate = rate
        if isinstance(inner, Sequence) and not isinstance(trimmed, Sequence):
            wrapped = copy_without(inner, self.dst, ('Components',))
            wrapped['Components'].value = [trimmed]
            wrapped.length = trimmed.length
            trimmed = wrapped
        new = copy_without(seg, self.dst, ('InputSegments', 'Rendering'))
        new['InputSegments'].value = [trimmed]
        new.length = length
        return new


def copy_without(obj, dst, names):
    """pyaaf2's deep copy of a wrapper, minus the children about to be replaced.
    Copying them first and discarding them copied a whole track per bite when
    Media Composer wrapped the track in Audio Pan."""
    entries = obj.property_entries
    obj.property_entries = {pid: p for pid, p in entries.items() if p.name not in names}
    try:
        return obj.copy(root=dst)
    finally:
        obj.property_entries = entries


def trim_units(frames, target_rate, rate):
    units = Fraction(frames) * target_rate / rate
    if units.denominator != 1:
        fail(f'A cut of {frames} frames is not a whole edit unit at the source rate {target_rate}.')
    return int(units)


def append_piece(components, piece, dst, kind):
    """Keep track Sequences flat like Media Composer's: splice nested
    Sequences and merge neighbouring Fillers of the track's data definition.
    `components` is a plain list, attached to its Sequence once at the end:
    appending to an attached pyaaf2 vector re-attaches it, which is
    quadratic in the number of bites."""
    if isinstance(piece, Sequence):
        children = list(piece.components)
        piece['Components'].value = []
        for child in children:
            append_piece(components, child, dst, kind)
        return
    if isinstance(piece, Filler):
        if components and isinstance(components[-1], Filler) and str(components[-1].media_kind).lower() == kind.lower():
            components[-1].length = components[-1].length + piece.length
            return
        piece = dst.create.Filler(media_kind=kind, length=piece.length)
    components.append(piece)


# ---------------------------------------------------------------- mob closure
def mob_closure(src, dst, mob_ids, closed=frozenset()):
    """Copy every mob the new sequence derives from, with its ORIGINAL MobID.
    Never EssenceData. A chain may end outside the file (a tape nobody
    exported); that is allowed by the Edit Protocol and left as it was.

    `closed`: mobs already in `dst` from a group pack of this same source.
    The pack holds every mob they refer to, so they are neither copied nor
    walked. Returns the ids of the mobs copied, in the order they were."""
    pending, done, copied = list(mob_ids), set(), []
    # One classdef cache for the whole closure: pyaaf2 otherwise registers
    # every class of every mob again, mob by mob (23,000 registrations for
    # HEAT 2's group). Per source, because two sources may define an
    # extension class differently. Seeded, because pyaaf2 reads the cache as
    # `classdef_cache or set()` and would replace an empty one.
    classes = {None}
    while pending:
        mob_id = pending.pop()
        if mob_id in done:
            continue
        done.add(mob_id)
        if mob_id in closed:
            continue
        mob = src.content.mobs.get(aaf2.mobid.MobID(mob_id))
        if mob is None:
            continue
        if mob.mob_id not in dst.content.mobs:
            dst.content.mobs.append(mob.copy(root=dst, classdef_cache=classes))
            copied.append(mob_id)
        pending.extend(str(key) for key, _ in mob_references(mob))
    return copied


def mob_references(mob):
    """(MobID, slot) for every mob `mob` points at: each SourceReference with
    the slot it names, and each of Avid's mob references with None, since it
    names a whole mob. The null MobID, a chain's end, is left out. Avid writes
    `_MATCH` on most master clips too; there it usually names a mob the export
    does not hold, which is a chain ending outside the file, as below."""
    for item, _ in mob.walk_references(topdown=True):
        if isinstance(item, SourceReference):
            key, slot = item.mob_id, item.slot_id
        elif item.class_id == AVID_MOB_REFERENCE:
            key, slot = item['Mob Reference MobID'].value, None
        else:
            continue
        if key is not None and key.int != 0:
            yield key, slot


def check_references(file, mobs, sources):
    """No reference from `mobs` may dangle at a mob that one of the source
    AAFs holds: the target is in `file`, with the slot referred to. A target
    no source holds is a chain ending outside the file, which is allowed.
    Looks targets up rather than indexing every mob of every file."""
    slots = {}
    for mob in mobs:
        for key, slot in mob_references(mob):
            if not any(key in source.content.mobs for source in sources):
                continue
            if key not in slots:
                target = file.content.mobs.get(key)
                slots[key] = None if target is None else {each.slot_id for each in target.slots}
            if slots[key] is None:
                fail(f'Self-check failed: {key} was not copied.', 'verify_failed')
            if slot is not None and slot not in slots[key]:
                fail(f'Self-check failed: {key} slot {slot} was not copied.', 'verify_failed')


def add_markers(dst, comp, rate, slot, markers):
    """Media Composer's layout (seen in MC 8.6 to 23.12 exports): one
    EventMobSlot per described track, SlotID 1000 + slot - 1, the track's
    PhysicalTrackNumber, DescribedSlots = {slot}, _ATN_CRM_* attributes."""
    event = dst.create.EventMobSlot()
    event['SlotID'].value = 1000 + slot.slot_id - 1
    event['EditRate'].value = rate
    event['PhysicalTrackNumber'].value = slot['PhysicalTrackNumber'].value
    sequence = dst.create.Sequence(media_kind='DescriptiveMetadata')
    now = datetime.now(timezone.utc)
    for marker in markers:
        item = dst.create.DescriptiveMarker()
        item['Position'].value = marker['frame']
        item['Comment'].value = marker['comment']
        item['CommentMarkerUser'].value = marker['name']
        item['DescribedSlots'].value = {slot.slot_id}
        red, green, blue = MARKER_RGB[marker['color']]
        item['CommentMarkerColor'].value = {'red': red, 'green': green, 'blue': blue}
        attributes = TaggedValueHelper(item['CommentMarkerAttributeList'])
        attributes['_ATN_CRM_COLOR'] = marker['color']
        attributes['_ATN_CRM_USER'] = marker['name']
        attributes['_ATN_CRM_COM'] = marker['comment']
        attributes['_ATN_CRM_DATE'] = now.strftime('%m/%d/%Y')
        attributes['_ATN_CRM_TIME'] = now.strftime('%H:%M')
        attributes['_ATN_CRM_LONG_CREATE_DATE'] = int(now.timestamp())
        attributes['_ATN_CRM_LONG_MOD_DATE'] = int(now.timestamp())
        if 'Length' in item:                                # MC writes point markers with no Length
            del item['Length']
        sequence.components.append(item)
    if 'Length' in sequence:
        del sequence['Length']
    event.segment = sequence
    comp.slots.append(event)


# ---------------------------------------------------------------- sources
class Source:
    def __init__(self, info, file, identity):
        self.id, self.path, self.file, self.identity = info['id'], info['path'], file, identity
        try:
            self.sequence = file.content.mobs.get(aaf2.mobid.MobID(info['sequence_id']))
        except (ValueError, TypeError):
            self.sequence = None
        if not isinstance(self.sequence, aaf2.mobs.CompositionMob):
            invalid(f'Source "{self.id}" does not contain sequence {info["sequence_id"]}.')
        self.slots = {s.slot_id: s for s in self.sequence.slots}
        self.warnings = []

    def slot(self, slot_id, kind, rate, where):
        slot = self.slots.get(slot_id)
        if slot is None or not isinstance(slot, aaf2.mobslots.TimelineMobSlot):
            invalid(f'{where}: source "{self.id}" has no timeline slot {slot_id}.')
        if media_kind(slot.segment) != kind:
            invalid(f'{where}: slot {slot_id} of source "{self.id}" is not a {kind} track.')
        if rate_of(slot) != rate:
            invalid(f'{where}: source "{self.id}" runs at {rate_of(slot)}, not the edit rate {rate}.')
        return slot


def record_timecode(sequence, rate):
    fps = math.ceil(rate)
    found = [s for s in sequence.slots if isinstance(s.segment, aaf2.components.Timecode)
             and rate_of(s) == rate and s.segment.fps == fps]
    record = next((s.segment for s in found if value(s, 'PhysicalTrackNumber') == 1), found[0].segment if found else None)
    return fps, bool(record.drop) if record else False


# ---------------------------------------------------------------- write
def compose(spec, sources, dst, warnings):
    """The new top-level sequence, built in `dst` and not yet attached, with
    the cloners that know which source mobs it refers to. Shared by the write
    and by the pack probe, so one piece of code decides both."""
    rate = spec['edit_rate']
    for source in sources.values():
        dst.dictionary.update(source.file.dictionary)       # op/param/data defs before any copy
    comp = dst.create.CompositionMob(spec['name'])
    comp['UsageCode'].value = 'Usage_TopLevel'
    fps, drop = record_timecode(next(iter(sources.values())).sequence, rate)
    tc_slot = comp.create_timeline_slot(rate)
    tc_slot.segment = dst.create.Timecode(fps=fps, drop=drop, length=spec['length'])
    tc_slot.segment.start = spec['start_tc']
    tc_slot['PhysicalTrackNumber'].value = 1

    cloners = {key: Cloner(dst, rate, spec['approach'], warnings) for key in sources}
    out = []
    for index, track in enumerate(spec['tracks']):
        used = {sources[key].slots[slot].segment.media_kind for key, slot in track['slots'].items()}
        kind = used.pop() if len(used) == 1 else track['kind']   # keep Legacy* when every source used it
        slot = comp.create_empty_sequence_slot(rate, media_kind=kind)
        slot['PhysicalTrackNumber'].value = track['number']
        out.append({'slot': slot, 'kind': kind, 'parts': [], 'label': ('V' if track['kind'] == 'picture' else 'A') + str(track['number'])})

    for index, (track, target) in enumerate(zip(spec['tracks'], out)):
        sequence = target['parts']
        for run in runs(spec, track, index):
            if run['gap']:
                append_piece(sequence, dst.create.Filler(media_kind=target['kind'], length=run['length']), dst, target['kind'])
                continue
            source_slot = sources[run['source']].slots[run['slot']]
            cursor = 0
            for first, last, keep in muted_ranges(run['mutes'], run['length']):
                if first > cursor:
                    piece(spec, cloners, run, run['at'], target, source_slot, cursor, first, dst, run['prefer'], track['approach'])
                if keep:
                    piece(spec, cloners, run, run['at'], target, source_slot, first, last, dst, run['prefer'], track['approach'], muted=True)
                else:
                    append_piece(sequence, dst.create.Filler(media_kind=target['kind'], length=last - first), dst, target['kind'])
                cursor = last
            if cursor < run['length']:
                piece(spec, cloners, run, run['at'], target, source_slot, cursor, run['length'], dst, run['prefer'], track['approach'])
    for target in out:
        target['slot'].segment['Components'].value = target['parts']
        target['slot'].segment.length = spec['length']

    for index, target in enumerate(out):
        markers = [m for m in spec['markers'] if m['track'] == index]
        if markers:
            add_markers(dst, comp, rate, target['slot'], markers)
    return SimpleNamespace(comp=comp, out=out, cloners=cloners, fps=fps, drop=drop)


def build(spec, sources, destination, warnings, pack=None):
    """Write the edit to `destination`: from nothing, or on a copy of a group
    pack, which already holds the closure of the group mobs it refers to."""
    if pack:
        shutil.copyfile(pack['path'], destination)
    with aaf2.open(str(destination), 'rw' if pack else 'w') as dst:
        closed = frozenset(str(key) for key in dst.content.mobs.references) if pack else frozenset()
        made = compose(spec, sources, dst, warnings)
        dst.content.mobs.append(made.comp)                   # attach once, fully built
        added = []
        for key, cloner in made.cloners.items():
            mine = closed if pack and sources[key].identity == pack['identity'] else frozenset()
            added += mob_closure(sources[key].file, dst, cloner.references, mine)
        # Avid names this DataDef 'Descriptive Metadata' (the AUID pyaaf2 calls
        # 'DescriptiveMetadata'); readers matching by name, graph.py among them,
        # only see markers under Avid's spelling. Last: pyaaf2 looks media kinds
        # up by short name, so nothing may resolve it after this.
        if spec['markers']:
            dst.dictionary.lookup_datadef('DescriptiveMetadata').name = 'Descriptive Metadata'
        # The self-check need not re-walk a pack: it was checked when built.
        # That holds only while every source is the file the pack came from;
        # a second source could hold the end of a chain the pack leaves open.
        narrow = pack is not None and all(source.identity == pack['identity'] for source in sources.values())
        return {'sequence_id': str(made.comp.mob_id), 'fps': made.fps, 'drop': made.drop,
                'copied_mobs': len(closed) + len(added), 'walk': [str(made.comp.mob_id), *added] if narrow else None,
                'tracks': [{'index': i, 'kind': t['kind'], 'physical_track_number': spec['tracks'][i]['number'],
                            'label': o['label'], 'slot_id': o['slot'].slot_id, 'data_def': o['kind']}
                           for i, (t, o) in enumerate(zip(spec['tracks'], made.out))]}


# ---------------------------------------------------------------- group packs
def referenced_groups(spec, sources):
    """The group and submaster CompositionMobs the edit will refer to, per
    source file: the cloner itself, run into a throwaway in-memory file, so
    the copy code decides rather than a second walk that could disagree."""
    if all(track['approach'] == 'B' for track in spec['tracks']):
        return {}                                           # B follows every group to the clip that plays
    probe = aaf2.open()                                     # in memory, never saved
    made = compose(spec, sources, probe, [])
    groups = {}
    for key, cloner in made.cloners.items():
        source = sources[key]
        for mob_id in cloner.references:
            if isinstance(source.file.content.mobs.get(aaf2.mobid.MobID(mob_id)), aaf2.mobs.CompositionMob):
                groups.setdefault(source.identity, set()).add(mob_id)
    return groups


def pack_name(identity, group_ids):
    groups = hashlib.sha256('\n'.join(sorted(group_ids)).encode()).hexdigest()[:16]
    return f'{identity}-{WRITER_VERSION}-{groups}.aaf'


def build_pack(source, group_ids, destination):
    """The source's dictionary and the whole closure of `group_ids`, checked,
    then renamed into place: a pack that exists under its name is complete,
    and a crash leaves only a temporary file nothing ever opens."""
    fd, name = tempfile.mkstemp(prefix='.pack-', suffix='.partial', dir=destination.parent)
    os.close(fd)
    temporary = Path(name)
    try:
        with aaf2.open(str(temporary), 'w') as pack:
            pack.dictionary.update(source.file.dictionary)
            copied = mob_closure(source.file, pack, group_ids)
            # Every reference, checked on the graph that is about to be
            # saved while all of it is still in memory: reading HEAT 2's
            # 69,000 objects back costs more than writing them did.
            check_references(pack, pack.content.mobs, [source.file])
        with aaf2.open(str(temporary), 'r') as pack:
            # What reached the disk: no essence, and the closure's mobs under
            # their own MobIDs, read from the index without opening a mob.
            if any(True for _ in pack.content.essencedata):
                fail('Self-check failed: a group pack carries essence.', 'verify_failed')
            if {str(key) for key in pack.content.mobs.references} != set(copied):
                fail('Self-check failed: a group pack lost a mob on the way to disk.', 'verify_failed')
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def played_by(spec, track, at, index, segment):
    """(what a track plays at segment `at`, the slot it plays, the group
    angles it prefers): its override there, else the segment itself."""
    override = spec['overrides'].get((at, index))
    if override:
        return override, override['slot'], override['choices']
    return segment, track['slots'].get(segment.get('source')), track['choices'].get(segment.get('source'), frozenset())


def runs(spec, track, index):
    """What one output track plays, joined wherever it simply carries on: the
    same slot of the same source, from the frame the last piece stopped at,
    with the same group angles. A segment boundary falls wherever ANY track
    was cut, so a piece per segment handed Media Composer an edit on A1 at
    every place A2 was cut, which String Outs never draws (its layerClips
    joins them the same way). A deliberate edit there (`cuts`) stays one.
    Each run is a gap, or a source range with its mutes relative to its start."""
    out = []
    for at, plain in enumerate(spec['segments']):
        segment, slot_id, prefer = played_by(spec, track, at, index, plain)
        if segment['kind'] == 'gap' or slot_id is None:
            out.append({'gap': True, 'at': at, 'length': segment['length']})
            continue
        mutes = spec['mutes'].get((at, index), [])
        last = out[-1] if out else None
        if (last and not last['gap'] and last['source'] == segment['source'] and last['slot'] == slot_id
                and last['prefer'] == prefer and last['in'] + last['length'] == segment['in']
                and (at, index) not in spec['cuts']):
            last['mutes'].extend((last['length'] + first, last['length'] + end, keep) for first, end, keep in mutes)
            last['length'] += segment['length']
            continue
        out.append({'gap': False, 'at': at, 'source': segment['source'], 'slot': slot_id, 'prefer': prefer,
                    'in': segment['in'], 'length': segment['length'], 'mutes': list(mutes)})
    return out


def muted_ranges(ranges, length):
    """(first, last, keep) for each muted stretch, in order and apart. Filler
    wins where a kept mute and filler overlap: nobody plays there."""
    def merged(spans):
        out = []
        for first, last in sorted(spans):
            if out and first <= out[-1][1]:
                out[-1][1] = max(out[-1][1], last)
            else:
                out.append([first, min(last, length)])
        return out
    gone = merged((first, last) for first, last, keep in ranges if not keep)
    kept = []
    for first, last in merged((first, last) for first, last, keep in ranges if keep):
        for low, high in gone:
            if high <= first or low >= last:
                continue
            if low > first:
                kept.append([first, low])
            first = max(first, high)
            if first >= last:
                break
        if first < last:
            kept.append([first, last])
    return sorted([(first, last, False) for first, last in gone] + [(first, last, True) for first, last in kept])


def piece(spec, cloners, segment, at, target, source_slot, first, last, dst, prefer=frozenset(), approach=None, muted=False):
    """Source frames [first, last) of a segment onto its track; `muted`, each
    clip in them as Media Composer's muted clip (`mute_clip`)."""
    cloner = cloners[segment['source']]
    cloner.prefer, cloner.inside = prefer, False
    cloner.approach = approach or spec['approach']
    try:
        component = cloner.clone(source_slot.segment, segment['in'] + first, last - first)
    except ReaderError as error:
        raise ReaderError(error.code, f'Segment {at + 1} on {target["label"]} (source frames '
                          f'{segment["in"] + first} to {segment["in"] + last}): {error}') from None
    finally:
        cloner.prefer, cloner.inside, cloner.approach = frozenset(), False, spec['approach']
    if not muted:
        append_piece(target['parts'], component, dst, target['kind'])
        return
    parts = []
    append_piece(parts, component, dst, target['kind'])
    for part in parts:
        if isinstance(part, Transition):
            fail(f'Segment {at + 1} on {target["label"]}: a muted stretch holds a dissolve, which Media Composer '
                 'cannot mute on its own. Unmute it, or cut the dissolve out first.')
        append_piece(target['parts'], part if isinstance(part, Filler) else mute_clip(part, dst, target['kind']), dst, target['kind'])


def mute_clip(component, dst, kind):
    """Media Composer's muted clip, as its own export writes one (MUTE TEST,
    Media Composer 24.12, 2026-10-07): a Selector marked _DISABLE_CLIP_FLAG 1
    and _AAF_SELECTED 0, selecting Filler of the clip's length, with the clip
    itself, effects and all, untouched as its one alternate. Each clip is
    wrapped on its own, as Avid wraps two muted clips in a row. Unmute Clip
    in Avid brings it back as it was."""
    wrapper = dst.create.Selector(media_kind=kind)
    wrapper['Selected'].value = dst.create.Filler(media_kind=kind, length=component.length)
    wrapper['Alternates'].value = [component]
    wrapper.length = component.length
    tags = TaggedValueHelper(wrapper['ComponentAttributeList'])
    tags['_DISABLE_CLIP_FLAG'] = 1
    tags['_AAF_SELECTED'] = 0
    return wrapper


# ---------------------------------------------------------------- verify
class VerifyTimeline:
    """GraphTimeline with its safety budgets sized to the edit being checked.
    Only what plays is compared, so group alternates are not expanded."""

    @staticmethod
    def open(file, sequence_id, budget, opened=False):
        """`opened`: each muted clip that sits directly on a track (where the
        writer puts the ones it mutes) reads as the clip it keeps, so the
        self-check can see what Unmute in Media Composer would bring back."""
        class Bounded(GraphTimeline):
            MAX_EXPANSIONS = budget
            MAX_COMPONENTS = budget

            def expand(self, seg, rate, start, duration, trail, warnings_list, depth=0):
                if opened and depth == 1 and isinstance(seg, Selector) and is_muted(seg):
                    kept = list(value(seg, 'Alternates') or [])
                    if len(kept) == 1:
                        return super().expand(kept[0], rate, start, duration, trail, warnings_list, depth + 1)
                return super().expand(seg, rate, start, duration, trail, warnings_list, depth)
        # The sequence by its MobID, as the reader's scan would find it but
        # without reading every mob in front of it: an export made on a group
        # pack holds its new sequence after thousands of the show's mobs.
        mob = file.content.mobs.get(aaf2.mobid.MobID(sequence_id))
        top = [mob] if isinstance(mob, aaf2.mobs.CompositionMob) and mob.usage == 'Usage_TopLevel' else []
        view = SimpleNamespace(content=SimpleNamespace(essencedata=file.content.essencedata, toplevel=lambda: iter(top)))
        return Bounded(view, sequence_id, expand_alternates=False)


def reader_frames(timeline, track, first, last):
    """Per frame: what the reader says plays. Audio is (mob, channel, sample)."""
    rate = timeline.rate
    for clip in track['clips']:
        left = max(first, clip['start_frame'])
        right = min(last, clip['start_frame'] + clip['duration_frames'])
        if left >= right:
            continue
        if clip['kind'] != 'audio':
            for _ in range(left, right):
                yield (clip['kind'],)
            continue
        pcm = timeline.sources[clip['source_id']]
        position = clip['source_sample_position']
        start = Fraction(position['numerator'], position['denominator'])
        step = Fraction(pcm.sample_rate) / rate
        mob = clip['source_id'].split(':')[0]
        for frame in range(left, right):
            yield ('audio', mob, pcm.channel, start + (frame - clip['start_frame']) * step)


def picture_frames(seg, rate, first, last, depth=0):
    """Per frame: the source mob, slot and position a picture slot shows.
    Independent of the writer's copy code on purpose: it only walks."""
    if depth > MAX_CLONE_DEPTH:
        fail('The picture graph is too deep to verify.', 'limit_exceeded')
    if first >= last:
        return
    if isinstance(seg, Filler) or isinstance(seg, ScopeReference):
        for _ in range(first, last):
            yield ('gap',)
    elif isinstance(seg, Selector):
        yield from picture_frames(value(seg, 'Selected'), rate, first, last, depth + 1)
    elif isinstance(seg, OperationGroup):
        inputs = list(value(seg, 'InputSegments') or [])
        warp = conform(seg, rate)
        if warp is not None:
            # A camera conformed to the group's rate: the exact source
            # position under each group frame, so a trim that moved it by
            # even one source frame does not compare equal.
            ratio, clip, phase = warp
            for frame in range(first, last):
                yield ('clip', str(clip.mob_id), clip.slot_id, clip.start + phase + frame / ratio)
        elif len(inputs) == 1:
            yield from picture_frames(inputs[0], rate, first, last, depth + 1)
        else:
            for _ in range(first, last):
                yield ('effect', str(value(seg, 'Operation').name))
    elif isinstance(seg, Sequence):
        children, cursor, spans = list(seg.components), 0, []
        for index, child in enumerate(children):
            if isinstance(child, Transition):
                cursor -= child.length
                spans.append((None, cursor, cursor + child.length))
                continue
            before = children[index - 1].length if index and isinstance(children[index - 1], Transition) else 0
            after = children[index + 1].length if index + 1 < len(children) and isinstance(children[index + 1], Transition) else 0
            spans.append((child, cursor + before, cursor + child.length - after, cursor))
            cursor += child.length
        for span in sorted(spans, key=lambda s: s[1]):
            left, right = max(first, span[1]), min(last, span[2])
            if left >= right:
                continue
            if span[0] is None:
                for _ in range(left, right):
                    yield ('transition',)
            else:
                yield from picture_frames(span[0], rate, left - span[3], right - span[3], depth + 1)
    elif isinstance(seg, SourceClip):
        target = seg.slot if seg.mob_id is not None and seg.mob_id.int != 0 else None
        if target is None:
            for frame in range(first, last):
                yield ('ref', str(seg.mob_id), seg.slot_id, seg.start + frame)
            return
        target_rate = rate_of(target)
        if not isinstance(seg.mob, aaf2.mobs.SourceMob) and target_rate == rate:
            yield from picture_frames(target.segment, rate, seg.start + first, seg.start + last, depth + 1)
            return
        step = target_rate / rate
        for frame in range(first, last):
            yield ('clip', str(seg.mob_id), seg.slot_id, seg.start + frame * step)
    else:
        for _ in range(first, last):
            yield ('unsupported', type(seg).__name__)


def attributes(component):
    """Avid's attributes on a component, which a trim must carry unchanged."""
    return tuple(sorted((tag.name, repr(tag.value)) for tag in value(component, 'ComponentAttributeList') or []))


def angle_key(option):
    """What one angle of a group shows: the clip it plays, through a conform,
    with the attributes that tell Media Composer how to read a conform (its
    Motion Control's and its Sequence's), which a trim must not lose."""
    if isinstance(option, OperationGroup):
        inputs = list(value(option, 'InputSegments') or [])
        if len(inputs) != 1:
            return ('effect', str(value(option, 'Operation').name))
        key = angle_key(inputs[0])
        return ('conform', attributes(option), key) if value(value(option, 'Operation'), 'IsTimeWarp') else key
    if isinstance(option, Sequence):
        clips = [c for c in option.components if not isinstance(c, Filler)]
        key = angle_key(clips[0]) if len(clips) == 1 else ('sequence',)
        tags = attributes(option)
        return ('sequence', tags, key) if tags else key
    if isinstance(option, SourceClip):
        return (str(option.mob_id), option.slot_id)
    return ('silent',)


def angle_frame(option, rate):
    """The group frame an angle is cut at, by Media Composer's rule for a
    conformed camera, or None when the angle does not say."""
    if isinstance(option, OperationGroup):
        warp = conform(option, rate)
        if warp is not None:
            return math.ceil(warp[1].start * warp[0])
        inputs = list(value(option, 'InputSegments') or [])
        return angle_frame(inputs[0], rate) if len(inputs) == 1 and inputs[0].length == option.length else None
    if isinstance(option, Sequence):
        children = list(option.components)
        return angle_frame(children[0], rate) if len(children) == 1 else None
    if isinstance(option, SourceClip) and option.mob_id is not None and option.mob_id.int != 0 and option.slot is not None \
            and rate_of(option.slot) == Fraction(rate):
        return option.start
    return None


def group_shapes(seg, rate, shapes, depth=0):
    """Every group under `seg`, as what makes it the group Avid switches: its
    angles in order (any order, when the file does not record one), and where
    each is cut relative to the first. A trim moves every angle by the same
    amount, so a copy has exactly the shape of the group it was cut from."""
    if seg is None or depth > MAX_CLONE_DEPTH:
        return
    if isinstance(seg, Selector) and is_muted(seg):
        # A muted clip is not a group: its groups are inside the clip it keeps.
        for option in value(seg, 'Alternates') or []:
            group_shapes(option, rate, shapes, depth + 1)
        return
    if isinstance(seg, Selector):
        angles, _ = angles_of(seg)
        frames = [angle_frame(a, rate) for a in angles]
        origin = next((f for f in frames if f is not None), 0)
        pairs = tuple(zip((angle_key(a) for a in angles), (None if f is None else f - origin for f in frames)))
        ordered = any(t.name == '_AAF_SELECTED' for t in value(seg, 'ComponentAttributeList') or [])
        shapes.append(pairs if ordered else ('any order', tuple(sorted(pairs, key=repr))))
        for option in angles:
            group_shapes(option, rate, shapes, depth + 1)
    elif isinstance(seg, Sequence):
        for child in seg.components:
            group_shapes(child, rate, shapes, depth + 1)
    elif isinstance(seg, OperationGroup):
        warp = conform(seg, rate)
        for child in value(seg, 'InputSegments') or []:
            group_shapes(child, Fraction(rate) / warp[0] if warp else rate, shapes, depth + 1)


def mob_groups(mob):
    shapes = []
    for slot in mob.slots:
        if isinstance(slot, aaf2.mobslots.TimelineMobSlot):
            group_shapes(slot.segment, rate_of(slot), shapes)
    return shapes


def check_groups(out_comp, sources, cache):
    """Every group in the new sequence has the angles, in the order and at the
    offsets, of a group in the source. The frame comparison only follows what
    plays, and an angle left out of a group plays nothing, so this is the only
    check that sees one go missing."""
    known = set()
    for source in sources.values():
        read = ('groups', source.identity, str(source.sequence.mob_id))
        if read not in cache:
            cache[read] = set(mob_groups(source.sequence))
        known |= cache[read]
    shapes = mob_groups(out_comp)
    for shape in shapes:
        if shape not in known:
            count = len(shape[1]) if shape and shape[0] == 'any order' else len(shape)
            fail(f'Self-check failed: a group in the new sequence has {count} angles that do not match any group in '
                 'the source, in number, order or alignment. Nothing was written.', 'verify_failed')
    return len(shapes)


def compare(expected, actual, label, frame0):
    checked = 0
    for offset, (want, got) in enumerate(zip_strict(expected, actual)):
        if want != got:
            fail(f'Self-check failed on {label} at frame {frame0 + offset}: the new sequence plays '
                 f'{describe(got)} where the edit asks for {describe(want)}. Nothing was written.', 'verify_failed')
        checked += 1
    return checked


def zip_strict(left, right):
    sentinel = object()
    left, right = iter(left), iter(right)
    while True:
        a, b = next(left, sentinel), next(right, sentinel)
        if a is sentinel and b is sentinel:
            return
        yield (a if a is not sentinel else ('missing',)), (b if b is not sentinel else ('missing',))


def describe(key):
    if key[0] == 'audio':
        return f'{key[1]} channel {key[2] + 1} sample {key[3]}'
    if key[0] in ('clip', 'ref'):
        return f'{key[1]} slot {key[2]} at {key[3]}'
    return key[0]


def verify(spec, sources, destination, built, cache=None):
    """Re-read the written file with the app's reader and compare every frame.
    `cache` keeps each source's re-read across the edits of one batch."""
    budget = max(10000, 64 * (len(spec['segments']) + len(spec['mutes'])) + 16)
    rate = spec['edit_rate']
    cache = {} if cache is None else cache
    with aaf2.open(str(destination), 'r') as out_file:
        if any(True for _ in out_file.content.essencedata):
            fail('Self-check failed: the new AAF carries essence.', 'verify_failed')
        # Every mob, or with a group pack only the new sequence and the mobs
        # added beyond the pack, which was checked once when it was built.
        walk = out_file.content.mobs if built['walk'] is None else [
            out_file.content.mobs.get(aaf2.mobid.MobID(mob_id)) for mob_id in built['walk']]
        check_references(out_file, walk, [source.file for source in sources.values()])
        timeline = VerifyTimeline.open(out_file, built['sequence_id'], budget)
        if (timeline.start, timeline.fps, timeline.drop) != (spec['start_tc'], built['fps'], built['drop']) or timeline.duration != spec['length']:
            fail('Self-check failed: the timecode track or length does not match the edit.', 'verify_failed')
        out_tracks = {t['id']: t for t in timeline.tracks}
        reads = {}
        overridden = {override['source'] for override in spec['overrides'].values()}
        for key, source in sources.items():
            if key in overridden or any(key in t['slots'] and t['kind'] == 'sound' for t in spec['tracks']):
                read = (source.identity, str(source.sequence.mob_id), budget)
                if read not in cache:
                    cache[read] = VerifyTimeline.open(source.file, read[1], budget)
                reads[key] = cache[read]
        out_comp = out_file.content.mobs.get(aaf2.mobid.MobID(built['sequence_id']))
        groups = check_groups(out_comp, sources, cache)
        frames, preferred = 0, {}
        for index, (track, info) in enumerate(zip(spec['tracks'], built['tracks'])):
            label = info['label']
            if track['kind'] == 'sound':
                got = out_tracks.get(str(info['slot_id']))
                if got is None:
                    fail(f'Self-check failed: the reader does not see {label}.', 'verify_failed')
                actual = reader_frames(timeline, got, 0, spec['length'])
            else:
                actual = picture_frames(out_comp.slot_at(info['slot_id']).segment, rate, 0, spec['length'])
            frames += compare(expected_frames(spec, sources, reads, track, index, preferred), actual, label, 0)
        # Silence is not enough for a stretch the editor muted: it must keep
        # exactly what played there, or Unmute in Avid brings back something
        # else. The muted clips are opened and compared where they were made.
        if any(keep for ranges in spec['mutes'].values() for _, _, keep in ranges):
            opened = VerifyTimeline.open(out_file, built['sequence_id'], budget, opened=True)
            opened_tracks = {t['id']: t for t in opened.tracks}
            for index, (track, info) in enumerate(zip(spec['tracks'], built['tracks'])):
                spans = kept_spans(spec, index)
                if not spans or track['kind'] != 'sound':
                    continue
                actual = reader_frames(opened, opened_tracks[str(info['slot_id'])], 0, spec['length'])
                expected = expected_frames(spec, sources, reads, track, index, preferred, opened=True)
                frames += compare(inside(expected, spans), inside(actual, spans), f'{info["label"]} (muted)', 0)
        markers = sorted((m['position'], m['comment'], m['attributes'].get('_ATN_CRM_USER'), m['attributes'].get('_ATN_CRM_COLOR'),
                          tuple(m['described_slots'])) for m in timeline.markers)
        wanted = sorted((m['frame'], m['comment'], m['name'], m['color'], (built['tracks'][m['track']]['slot_id'],))
                        for m in spec['markers'])
        if markers != wanted:
            fail('Self-check failed: the markers read back differently from the edit.', 'verify_failed')
    return {'ok': True, 'frames_checked': frames, 'tracks_checked': len(spec['tracks']), 'markers_checked': len(wanted),
            'groups_checked': groups}


def kept_spans(spec, index):
    """Record frames [first, last) the editor muted on track `index`."""
    spans, at = [], 0
    for position, segment in enumerate(spec['segments']):
        for first, last, keep in muted_ranges(spec['mutes'].get((position, index), []), segment['length']):
            if keep:
                spans.append((at + first, at + last))
        at += segment['length']
    return spans


def inside(frames, spans):
    """Only the frames inside `spans` (sorted), each kept with nothing else."""
    spans = iter(spans)
    span = next(spans, None)
    for offset, key in enumerate(frames):
        while span and offset >= span[1]:
            span = next(spans, None)
        if span is None:
            return
        if offset >= span[0]:
            yield key


def expected_frames(spec, sources, reads, track, index, preferred, opened=False):
    """What each frame of track `index` plays. `opened`: a stretch the editor
    muted reads as the material it keeps; filler is filler either way."""
    for at, plain in enumerate(spec['segments']):
        segment, slot_id, prefer = played_by(spec, track, at, index, plain)
        if segment['kind'] == 'gap' or slot_id is None:
            yield from (('gap',) for _ in range(segment['length']))
            continue
        muted = muted_ranges(spec['mutes'].get((at, index), []), segment['length'])
        if track['kind'] == 'sound':
            timeline = reads[segment['source']]
            source_track = next((t for t in timeline.tracks if t['id'] == str(slot_id)), None)
            if source_track is None:
                fail(f'Self-check failed: the reader does not see slot {slot_id} of source "{segment["source"]}".', 'verify_failed')
            if prefer:
                # Read the way the track was asked for: those angles, and
                # nothing outside the groups that offer them.
                read = (segment['source'], slot_id, prefer)
                if read not in preferred:
                    preferred[read] = timeline.read_preferring(sources[segment['source']].slots[slot_id], prefer)
                source_track = preferred[read]
            played = reader_frames(timeline, source_track, segment['in'], segment['out'])
        else:
            played = picture_frames(sources[segment['source']].slots[slot_id].segment, spec['edit_rate'],
                                    segment['in'], segment['out'])
        for offset, key in enumerate(played):
            yield ('gap',) if any(first <= offset < last and not (opened and keep) for first, last, keep in muted) else key


# ---------------------------------------------------------------- entry points
class Session:
    """What one run of the writer shares between the edits it writes: each
    source AAF opened once, with the fingerprint it had when it was opened,
    its group packs, and its re-read for the self-check."""

    def __init__(self, stack):
        self.stack, self.files, self.packs, self.reads = stack, {}, set(), {}

    def open(self, path):
        if path not in self.files:
            identity = fingerprint(path)
            self.files[path] = (self.stack.enter_context(aaf2.open(str(path), 'r')), identity)
        return self.files[path]

    def pack(self, spec, sources):
        """The group pack to base this edit on, built if it does not exist
        yet, or None when the edit refers to no group mob. Several sources
        with groups: the largest file's pack, the rest copied as before."""
        groups = referenced_groups(spec, sources)
        if not groups:
            return None
        files = {source.identity: source for source in sources.values()}
        identity = max(groups, key=lambda key: (files[key].path.stat().st_size, key))
        path = spec['pack_dir'] / pack_name(identity, groups[identity])
        built = False
        if path not in self.packs:
            if path.is_file():
                try:
                    os.utime(path)          # in use: the scratch sweep ages packs by mtime
                except OSError:
                    pass
            else:
                build_pack(files[identity], groups[identity], path)
                built = True
            self.packs.add(path)
        return {'path': path, 'identity': identity, 'built': built}

    def write(self, request):
        spec = validate(request)
        for key, source in spec['sources'].items():
            if not source['path'].is_file():
                invalid(f'Source "{key}" is not a readable AAF file.')
        output, markers_output = spec['output'], spec['markers_output']
        if not output.parent.is_dir() or output.exists() or output.is_symlink():
            fail('Choose a new output file in an existing folder.', 'invalid_output')
        if markers_output and (markers_output.exists() or markers_output.is_symlink()):
            fail(f'{markers_output.name} already exists next to the output. Choose another name.', 'invalid_output')
        warnings, sources = [], {}
        for key, info in spec['sources'].items():
            sources[key] = Source(info, *self.open(info['path']))
        for index, track in enumerate(spec['tracks']):
            for key, slot_id in track['slots'].items():
                sources[key].slot(slot_id, track['kind'], spec['edit_rate'], f'tracks[{index}]')
        for (at, track), override in spec['overrides'].items():
            slot = sources[override['source']].slot(override['slot'], spec['tracks'][track]['kind'], spec['edit_rate'], f'segments[{at}] override')
            if override['out'] > slot.segment.length:
                invalid(f'segments[{at}]: an override runs past the end of slot {override["slot"]} in source "{override["source"]}".')
        for index, segment in enumerate(spec['segments']):
            if segment['kind'] != 'source':
                continue
            for track in spec['tracks']:
                slot_id = track['slots'].get(segment['source'])
                if slot_id is not None and segment['out'] > sources[segment['source']].slots[slot_id].segment.length:
                    invalid(f'segments[{index}]: out_frame is past the end of slot {slot_id} in source "{segment["source"]}".')
        pack = self.pack(spec, sources) if spec['pack_dir'] else None
        try:
            with pending_file(output) as destination:
                built = build(spec, sources, destination, warnings, pack)
                result = verify(spec, sources, destination, built, self.reads)
                for key, source in sources.items():
                    if fingerprint(source.path) != source.identity:
                        fail(f'Source "{key}" changed while the edit was written. Try again.', 'source_changed')
        except BaseException as error:
            if pack and getattr(error, 'code', None) not in ('cancelled', 'invalid_output'):
                # Never trust a pack twice that an export failed on: the next
                # export builds it again from the source.
                self.packs.discard(pack['path'])
                pack['path'].unlink(missing_ok=True)
            raise
        if markers_output:
            try:
                with pending_file(markers_output) as pending:
                    pending.write_text(avid_marker_text(spec, spec['tracks'], built['fps'], built['drop']), encoding='utf-8')
            except BaseException:
                output.unlink(missing_ok=True)              # never leave half a delivery
                raise
        return {'schema_version': SCHEMA_VERSION, 'output': str(output),
                'markers_output': str(markers_output) if markers_output else None,
                'sequence_id': built['sequence_id'], 'name': spec['name'], 'approach': spec['approach'],
                'edit_rate': {'numerator': spec['edit_rate'].numerator, 'denominator': spec['edit_rate'].denominator},
                'start_timecode_frames': spec['start_tc'], 'timecode_fps': built['fps'], 'drop_frame': built['drop'],
                'duration_frames': spec['length'], 'tracks': built['tracks'], 'segments': len(spec['segments']),
                'markers': len(spec['markers']), 'copied_mobs': built['copied_mobs'], 'warnings': warnings,
                'pack': {'built': pack['built']} if pack else None, 'verify': result}


def write_edit(request):
    with ExitStack() as stack:
        return Session(stack).write(request)


def write_edits(request):
    """Several edits from one run: each source AAF is opened once and each
    group pack built at most once. One edit that fails is reported in its
    place and does not lose the others; Stop ends the whole run."""
    if not isinstance(request, dict) or request.get('schema_version') != SCHEMA_VERSION:
        invalid(f'Unsupported edits request schema_version; expected {SCHEMA_VERSION}.')
    edits = request.get('edits')
    if not isinstance(edits, list) or not 1 <= len(edits) <= MAX_EDITS:
        invalid(f'edits must list between 1 and {MAX_EDITS} edit requests.')
    results = []
    with ExitStack() as stack:
        session = Session(stack)
        for edit in edits:
            try:
                results.append(written(session.write, edit))
            except ReaderError as error:
                if error.code == 'cancelled':
                    raise
                results.append({'error': {'code': error.code, 'message': str(error)}})
    return {'schema_version': SCHEMA_VERSION, 'results': results}


def written(write, request):
    try:
        return write(request)
    except ReaderError:
        raise
    except Exception as error:  # pyaaf2 raises bare Exception for bad definitions
        # A traceback is not an answer; the output was never published.
        fail(f'The AAF could not be written ({type(error).__name__}). Nothing was saved.', 'write_failed')


def read_request(path):
    request = Path(path)
    if not request.is_file() or request.stat().st_size > MAX_REQUEST_BYTES:
        invalid('The edit request must be a JSON file of at most 64 MB.')
    try:
        return json.loads(request.read_text(encoding='utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError):
        invalid('The edit request is not valid JSON.')


def write_edit_request(path):
    return written(write_edit, read_request(path))


def write_edits_request(path):
    return write_edits(read_request(path))
