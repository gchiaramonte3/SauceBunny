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
from aaf2.components import (Filler, OperationGroup, ScopeReference, Selector, Sequence, SourceClip,
                             SourceReference, Transition)
from aaf2.misc import TaggedValueHelper, VaryingValue

from graph import GraphTimeline, choice_id
from picture import is_muted
from reader import (MAX_DEPTH, ReaderError, clean_name, fail, fingerprint, media_kind, pending_file,
                    rate_of, value)

SCHEMA_VERSION = 1
# Bump whenever what the writer puts in a file changes: a group pack names the
# version that built it, so a pack from another version is never reused.
WRITER_VERSION = 1
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
    if request.get('schema_version') != SCHEMA_VERSION:
        invalid(f'Unsupported edit request schema_version; expected {SCHEMA_VERSION}.')
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
            if not any(key in t['slots'] for t in spec['tracks']):
                invalid(f'{where}: source "{key}" is not mapped to any output track.')
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
        spec['mutes'].setdefault((at, track), []).append((first, last))

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
                new['Alternates'].value = self.alternates([a for a in options if a is not play and a is not None], offset, length, depth)
                new.length = length
                return new
            finally:
                self.inside = previous
        if isinstance(seg, Sequence):
            return self.sequence(seg, offset, length, depth)
        if isinstance(seg, OperationGroup):
            return self.operation(seg, offset, length, depth)
        fail(f'{type(seg).__name__} components cannot be copied into a new sequence. Render or remove it in Avid.')

    def alternates(self, options, offset, length, depth):
        """The angles a kept group can still switch to. One that cannot be cut
        (a speed change on a camera, as HEAT 2's slow-motion angle has) is left
        out of this bite's group with a warning, rather than failing the whole
        export: the spec allows a group with fewer alternates, the angle that
        plays is unchanged, and every other angle stays switchable."""
        kept = []
        for option in options:
            before = set(self.references)
            try:
                kept.append(self.clone(option, offset, length, depth + 1, True))
            except ReaderError as error:
                self.references = before
                why = str(error).split('. ')[0].rstrip('.')
                self.warn(f'A group angle ({why}) was left out of its group; the angle that plays and every other angle are kept.')
        return kept

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
        if len(parts) == 1 and not transitions:
            return parts[0]
        new = self.dst.create.Sequence(media_kind=seg.media_kind)
        new['Components'].value = parts
        new.length = length
        return new

    def operation(self, seg, offset, length, depth):
        operation = value(seg, 'Operation')
        name = str(operation.name)
        inputs = list(value(seg, 'InputSegments') or [])
        params = list(value(seg, 'Parameters') or [])
        if value(operation, 'IsTimeWarp'):
            fail(f'{name} changes speed. Render it in Avid before exporting the bite.')
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
        for item, _ in mob.walk_references(topdown=True):
            if isinstance(item, SourceReference) and item.mob_id is not None and item.mob_id.int != 0:
                pending.append(str(item.mob_id))
    return copied


def check_references(file, mobs, sources):
    """No reference from `mobs` may dangle at a mob that one of the source
    AAFs holds: the target is in `file`, with the slot referred to. A target
    no source holds is a chain ending outside the file, which is allowed.
    Looks targets up rather than indexing every mob of every file."""
    slots = {}
    for mob in mobs:
        for item, _ in mob.walk_references(topdown=True):
            if not isinstance(item, SourceReference) or item.mob_id is None or item.mob_id.int == 0:
                continue
            key = item.mob_id
            if not any(key in source.content.mobs for source in sources):
                continue
            if key not in slots:
                target = file.content.mobs.get(key)
                slots[key] = None if target is None else {slot.slot_id for slot in target.slots}
            if slots[key] is None or item.slot_id not in slots[key]:
                fail(f'Self-check failed: {key} slot {item.slot_id} was not copied.', 'verify_failed')


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

    for at, segment in enumerate(spec['segments']):
        for index, (track, target) in enumerate(zip(spec['tracks'], out)):
            sequence = target['parts']
            slot_id = track['slots'].get(segment.get('source'))
            if segment['kind'] == 'gap' or slot_id is None:
                append_piece(sequence, dst.create.Filler(media_kind=target['kind'], length=segment['length']), dst, target['kind'])
                continue
            source_slot = sources[segment['source']].slots[slot_id]
            prefer = track['choices'].get(segment['source'], frozenset())
            cursor = 0
            for first, last in muted_ranges(spec['mutes'].get((at, index), []), segment['length']):
                if first > cursor:
                    piece(spec, cloners, segment, at, target, source_slot, cursor, first, dst, prefer, track['approach'])
                append_piece(sequence, dst.create.Filler(media_kind=target['kind'], length=last - first), dst, target['kind'])
                cursor = last
            if cursor < segment['length']:
                piece(spec, cloners, segment, at, target, source_slot, cursor, segment['length'], dst, prefer, track['approach'])
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


def muted_ranges(ranges, length):
    merged = []
    for first, last in sorted(ranges):
        if merged and first <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], last)
        else:
            merged.append([first, min(last, length)])
    return merged


def piece(spec, cloners, segment, at, target, source_slot, first, last, dst, prefer=frozenset(), approach=None):
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
    append_piece(target['parts'], component, dst, target['kind'])


# ---------------------------------------------------------------- verify
class VerifyTimeline:
    """GraphTimeline with its safety budgets sized to the edit being checked.
    Only what plays is compared, so group alternates are not expanded."""

    @staticmethod
    def open(file, sequence_id, budget):
        class Bounded(GraphTimeline):
            MAX_EXPANSIONS = budget
            MAX_COMPONENTS = budget
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
        if len(inputs) == 1:
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
        for key, source in sources.items():
            if any(key in t['slots'] and t['kind'] == 'sound' for t in spec['tracks']):
                read = (source.identity, str(source.sequence.mob_id), budget)
                if read not in cache:
                    cache[read] = VerifyTimeline.open(source.file, read[1], budget)
                reads[key] = cache[read]
        out_comp = out_file.content.mobs.get(aaf2.mobid.MobID(built['sequence_id']))
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
        markers = sorted((m['position'], m['comment'], m['attributes'].get('_ATN_CRM_USER'), m['attributes'].get('_ATN_CRM_COLOR'),
                          tuple(m['described_slots'])) for m in timeline.markers)
        wanted = sorted((m['frame'], m['comment'], m['name'], m['color'], (built['tracks'][m['track']]['slot_id'],))
                        for m in spec['markers'])
        if markers != wanted:
            fail('Self-check failed: the markers read back differently from the edit.', 'verify_failed')
    return {'ok': True, 'frames_checked': frames, 'tracks_checked': len(spec['tracks']), 'markers_checked': len(wanted)}


def expected_frames(spec, sources, reads, track, index, preferred):
    for at, segment in enumerate(spec['segments']):
        slot_id = track['slots'].get(segment.get('source'))
        if segment['kind'] == 'gap' or slot_id is None:
            yield from (('gap',) for _ in range(segment['length']))
            continue
        muted = muted_ranges(spec['mutes'].get((at, index), []), segment['length'])
        if track['kind'] == 'sound':
            timeline = reads[segment['source']]
            source_track = next((t for t in timeline.tracks if t['id'] == str(slot_id)), None)
            if source_track is None:
                fail(f'Self-check failed: the reader does not see slot {slot_id} of source "{segment["source"]}".', 'verify_failed')
            prefer = track['choices'].get(segment['source'])
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
            yield ('gap',) if any(first <= offset < last for first, last in muted) else key


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
