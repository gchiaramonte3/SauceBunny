"""AAF metadata graph. Locators are data, never instructions to open files.

The legacy embedded reader remains the byte-exact extraction path. This layer
also describes offline sources and selectable group branches without requiring
any media, decoding, or access to the exporting workstation.
"""
from fractions import Fraction
from dataclasses import replace
import hashlib
import json
import struct
import aaf2
from reader import (Timeline, PCM, ReaderError, value, rate_of, clean_name,
                    append_warning, fail, round_sample, MAX_DEPTH)

MAX_AUDIO_LANES = 256


def identity(obj):
    return obj.dir.path()


def choice_id(seg):
    if isinstance(seg, aaf2.components.SourceClip):
        return f'{seg.mob_id}:{seg.slot_id}'
    return identity(seg)


# A bin exported from Avid can hold hundreds of sequences. The bound only
# keeps a malformed file from enumerating without end; it was 64, which made a
# 65-sequence bin impossible to open or even to choose from.
MAX_SEQUENCES = 1000


def sequence_choices(file):
    choices = []
    for mob in file.content.toplevel():
        if len(choices) >= MAX_SEQUENCES:
            fail('Too many top-level sequences.', 'limit_exceeded')
        choices.append({'id': str(mob.mob_id), 'name': clean_name(mob.name, 'AAF sequence')})
    return choices


def linked_format(descriptor):
    """WAVE headers live in Summary, PCM/MXF formats in descriptor fields."""
    if isinstance(descriptor, aaf2.essence.WAVEDescriptor):
        summary = bytes(value(descriptor, 'Summary', []))
        if len(summary) > 65536 or summary[:4] != b'RIFF' or summary[8:12] != b'WAVE':
            fail('The linked WAV has no usable format summary.')
        at = 12
        while at + 8 <= len(summary):
            size = int.from_bytes(summary[at+4:at+8], 'little')
            if summary[at:at+4] == b'fmt ' and size >= 16 and at+24 <= len(summary):
                tag, channels, hz, byte_rate, align, bits = struct.unpack('<HHIIHH', summary[at+8:at+24])
                if tag != 1 or bits not in (16, 24, 32) or align != channels*bits//8 or byte_rate != hz*align:
                    fail('The linked WAV format is not supported PCM.')
                return Fraction(hz), channels, bits//8
            at += 8 + size + size%2
        fail('The linked WAV format summary is incomplete.')
    return (Fraction(str(value(descriptor, 'AudioSamplingRate', 48000))),
            int(value(descriptor, 'Channels', 1)), int(value(descriptor, 'QuantizationBits', 24))//8)


def audio_descriptor(descriptor, slot_id):
    if isinstance(descriptor, aaf2.essence.MultipleDescriptor):
        children = list(value(descriptor, 'FileDescriptors', []))
        if len(children) > 256:
            fail('Too many MXF stream descriptors.', 'limit_exceeded')
        matches = [d for d in children if value(d, 'LinkedSlotID') == slot_id]
        if len(matches) != 1:
            fail('The MXF audio slot has no unique linked descriptor.')
        descriptor = matches[0]
    if not isinstance(descriptor, (aaf2.essence.SoundDescriptor, aaf2.essence.WAVEDescriptor)):
        fail('The linked source is not an audio descriptor.')
    return descriptor


class GraphTimeline(Timeline):
    def __init__(self, file, sequence_id=None):
        self.external = {}
        self.overrides = {}
        self.selectors = {}
        self.branch_only = None
        self.inside_branch = False
        # A bounded scan, never a full enumeration: finding the chosen
        # sequence, or learning there is more than one, needs no list of all.
        chosen, seen = None, 0
        for mob in file.content.toplevel():
            seen += 1
            if seen > MAX_SEQUENCES:
                fail('Too many top-level sequences.', 'limit_exceeded')
            if sequence_id and str(mob.mob_id) == sequence_id:
                chosen = mob
                break
            if not sequence_id:
                if seen > 1:
                    fail('Choose a sequence from this AAF.', 'choose_sequence')
                chosen = mob
        if chosen is None:
            if sequence_id:
                fail('The selected sequence is not in this AAF.', 'invalid_input')
            fail('This AAF does not contain a top-level sequence.')
        # Use the established timecode/rational mapping without mutating the AAF.
        class Content:
            essencedata = file.content.essencedata
            @staticmethod
            def toplevel():
                return iter([chosen])
        class View:
            content = Content()
        super().__init__(View())
        self.file = file
        main_tracks = list(self.tracks)
        extra = []
        for slot, parent in zip([s for s in chosen.slots if s.segment.media_kind.lower() == 'sound'], main_tracks):
            self.selectors = {}
            self.read_track(slot)
            pending = [(key, selector, {}) for key, selector in self.selectors.items()]
            visited = set()
            while pending:
                key, selector, context = pending.pop(0)
                state = (key, tuple(sorted((k, choice_id(v)) for k, v in context.items())))
                if state in visited:
                    continue
                visited.add(state)
                selected = value(selector, 'Selected')
                choices = list(value(selector, 'Alternates', []))
                seen = {choice_id(selected)}
                for choice in choices:
                    target = choice_id(choice)
                    if target in seen:
                        continue
                    seen.add(target)
                    if len(main_tracks) + len(extra) >= MAX_AUDIO_LANES:
                        fail('This sequence exceeds 256 expanded microphone lanes.', 'limit_exceeded')
                    self.overrides = {**context, key: choice}
                    self.branch_only = key
                    self.selectors = {}
                    branch = self.read_track(slot)
                    suffix = json.dumps(sorted((k, choice_id(v)) for k, v in context.items())) if context else ''
                    branch['id'] = 'branch-' + hashlib.sha256(f'{chosen.mob_id}:{slot.slot_id}:{key}:{target}{suffix}'.encode()).hexdigest()[:32]
                    branch['parent_track_id'] = parent['id']
                    branch['branch_id'] = target
                    branch['group_name'] = self.group_name(choice)
                    extra.append(branch)
                    # Discover selectors inside an unselected branch without
                    # multiplying unrelated timeline groups into combinations.
                    pending.extend((child_key, child, dict(self.overrides)) for child_key, child in self.selectors.items()
                                   if child_key != key and child_key not in context)
            self.overrides = {}
            self.branch_only = None
        self.tracks = main_tracks + extra
        self.picture_tracks = [{'slot_id': s.slot_id, 'physical_track_number': value(s, 'PhysicalTrackNumber'),
                                'name': clean_name(s.name, 'Picture'), 'component': type(s.segment).__name__}
                               for s in chosen.slots if s.segment.media_kind.lower() == 'picture']
        self.markers = []
        for slot in chosen.slots:
            if slot.segment.media_kind.lower() != 'descriptive metadata':
                continue
            # `or []`, not a default: Media Composer 23.12 writes a span marker
            # on the timecode track whose DescribedSlots property is PRESENT
            # with no data, so value() returns None rather than the default,
            # and iterating it failed the whole import as invalid_aaf.
            for marker in value(slot.segment, 'Components') or []:
                if type(marker).__name__ != 'DescriptiveMarker':
                    continue
                self.markers.append({'position': value(marker, 'Position') or 0,
                    'comment': str(value(marker, 'Comment') or '')[:20000],
                    'described_slots': list(value(marker, 'DescribedSlots') or []),
                    'attributes': {str(t.name): str(t.value)[:20000] for t in value(marker, 'CommentMarkerAttributeList') or []}})

    def group_name(self, seg):
        if isinstance(seg, aaf2.components.SourceClip) and seg.mob:
            return clean_name(seg.mob.name, 'Group audio')
        return 'Group audio'

    def read_track(self, slot):
        # The budget covers each bounded traversal, not an ever-growing count
        # across alternate choices that share the same source stack.
        self.expanded = 0
        try:
            track = super().read_track(slot)
        except ReaderError as error:
            if error.code != 'unsupported_aaf':
                raise
            # Preserve an identified, unavailable lane for timing/format graphs
            # that cannot be decoded faithfully. Never manufacture silence.
            number = value(slot, 'PhysicalTrackNumber')
            track = {'id': str(slot.slot_id), 'name': clean_name(slot.name, f'Track {slot.slot_id}'),
                'physical_track_number': number if isinstance(number, int) and number > 0 else None, 'sample_rate': 48000, 'sample_width': 3,
                'duration_frames': self.duration, 'clips': [{'kind': 'unavailable', 'start_frame': 0,
                    'duration_frames': self.duration, 'warnings': [str(error)]}], 'warnings': [str(error)]}
        states = {c['kind'] for c in track['clips']}
        track['availability'] = 'unsupported' if 'unavailable' in states else (
            'offline' if any(c.get('source_id') in self.external for c in track['clips']) else 'ready')
        return track

    def expand(self, seg, rate, start, duration, trail, warnings_list, depth=0):
        self.expanded += 1
        if self.expanded > 10000:
            fail('The AAF source graph is too complex.', 'limit_exceeded')
        if depth > MAX_DEPTH:
            fail('The AAF source graph is too deep.', 'limit_exceeded')
        if start < 0 or duration < 0 or start + duration > Fraction(seg.length, 1)/rate:
            fail('A source reference extends outside its segment.', 'invalid_media')
        if isinstance(seg, aaf2.components.Sequence) and any(isinstance(c, aaf2.components.Transition) for c in seg.components):
            children = list(seg.components)
            if len(children) > 10000:
                fail('Too many sequence components.', 'limit_exceeded')
            result, cursor = [], Fraction(0)
            for index, child in enumerate(children):
                length = Fraction(child.length, 1)/rate
                transition = isinstance(child, aaf2.components.Transition)
                if transition:
                    if index == 0 or index == len(children)-1:
                        fail('A transition has no neighboring clip.', 'invalid_media')
                    cursor -= length
                    left, right = max(start, cursor), min(start+duration, cursor+length)
                    if left < right:
                        result.append({'kind': 'unavailable', 'duration': right-left})
                        append_warning(warnings_list, 'Unsupported processing: Avid transition; overlapping audio is unavailable.')
                    continue
                before = Fraction(children[index-1].length, 1)/rate if index and isinstance(children[index-1], aaf2.components.Transition) else 0
                after = Fraction(children[index+1].length, 1)/rate if index+1 < len(children) and isinstance(children[index+1], aaf2.components.Transition) else 0
                if before+after > length:
                    fail('AAF transitions exceed the adjacent clip.', 'invalid_media')
                left, right = max(start, cursor+before), min(start+duration, cursor+length-after)
                if left < right:
                    result.extend(self.expand(child, rate, left-cursor, right-left, trail, warnings_list, depth+1))
                cursor += length
            if cursor != Fraction(seg.length, 1)/rate:
                fail('A sequence component length is inconsistent.', 'invalid_media')
            return result
        if isinstance(seg, aaf2.components.Selector):
            key = identity(seg)
            if not self.branch_only or self.inside_branch or key == self.branch_only:
                self.selectors[key] = seg
            choice = self.overrides.get(key, value(seg, 'Selected'))
            previous = self.inside_branch
            self.inside_branch = previous or key == self.branch_only
            try:
                return self.expand(choice, rate, start, duration, trail, warnings_list, depth+1)
            finally:
                self.inside_branch = previous
        if isinstance(seg, aaf2.components.OperationGroup):
            inputs = list(value(seg, 'InputSegments', []))
            name = str(value(seg, 'Operation').name)
            if name in ('Audio Pan', 'Audio Gain') and len(inputs) == 1 and inputs[0].length == seg.length:
                append_warning(warnings_list, f'Raw microphone audio: Avid {name.lower()} is not applied.')
                return self.expand(inputs[0], rate, start, duration, trail, warnings_list, depth+1)
            append_warning(warnings_list, f'Unsupported processing: {name}.')
            return [{'kind': 'unavailable', 'duration': duration}]
        if isinstance(seg, aaf2.components.SourceClip):
            mob, slot = seg.mob, seg.slot
            if self.branch_only and not self.inside_branch and isinstance(mob, aaf2.mobs.SourceMob):
                return [{'kind': 'gap', 'duration': duration}]
            descriptor = value(mob, 'EssenceDescription') if mob else None
            if mob and slot and str(mob.mob_id) in self.essence:
                pcm = self.source(mob)
                if pcm.channels > 1:
                    physical = value(slot, 'PhysicalTrackNumber')
                    if not isinstance(physical, int) or not 1 <= physical <= pcm.channels:
                        append_warning(warnings_list, 'Unsupported processing: embedded channel identity is missing.')
                        return [{'kind': 'unavailable', 'duration': duration}]
                    key = str(mob.mob_id) + ':' + str(slot.slot_id)
                    offset = Fraction(seg.start, 1)/rate_of(slot) + start
                    if offset < 0:
                        fail('A source has a negative position.', 'invalid_media')
                    if round_sample((offset+duration)*pcm.sample_rate) > pcm.sample_count:
                        fail('A clip exceeds the embedded audio samples.', 'invalid_media')
                    self.sources[key] = replace(pcm, source_id=key, channel=physical-1)
                    self.essence[key] = self.essence[str(mob.mob_id)]
                    return [{'kind': 'audio', 'duration': duration, 'source_id': key, 'source_start': offset,
                             'master_id': str(mob.mob_id), 'name': clean_name(mob.name, 'Audio clip')}]
            if slot and descriptor and str(mob.mob_id) not in self.essence and isinstance(mob, aaf2.mobs.SourceMob):
                source_rate = rate_of(slot)
                offset = Fraction(seg.start, 1)/source_rate + start
                if offset < 0:
                    fail('A source has a negative position.', 'invalid_media')
                key = str(mob.mob_id) + ':' + str(slot.slot_id)
                try:
                    parent_descriptor = descriptor
                    descriptor = audio_descriptor(descriptor, slot.slot_id)
                    hz, channels, width = linked_format(descriptor)
                except ReaderError as error:
                    append_warning(warnings_list, str(error))
                    return [{'kind': 'unavailable', 'duration': duration}]
                physical = value(slot, 'PhysicalTrackNumber')
                channel = 0 if channels == 1 else (physical-1 if isinstance(physical, int) and 1 <= physical <= channels else None)
                locators = [str(value(loc, 'URLString', '')) for loc in value(descriptor, 'Locator', [])]
                if parent_descriptor is not descriptor:
                    locators.extend(str(value(loc, 'URLString', '')) for loc in value(parent_descriptor, 'Locator', []))
                if hz.denominator != 1 or hz not in (44100, 48000, 96000) or width not in (2, 3, 4) or channel is None:
                    append_warning(warnings_list, 'Unsupported processing: source format or channel mapping needs review.')
                    return [{'kind': 'unavailable', 'duration': duration}]
                # Only the descriptor's own locator is playable. Ancestor tape
                # locators carry different time origins and are retained only as
                # provenance until explicitly matched to BWF time-reference data.
                ancestors = []
                cursor = slot.segment
                visited = set()
                for _ in range(MAX_DEPTH):
                    if not isinstance(cursor, aaf2.components.SourceClip) or cursor.mob is None:
                        break
                    ancestor = cursor.mob
                    if str(ancestor.mob_id) in visited:
                        fail('The AAF contains a cyclic source reference.', 'invalid_media')
                    visited.add(str(ancestor.mob_id))
                    desc = value(ancestor, 'EssenceDescription')
                    if desc:
                        ancestors.append({'mob_id': str(ancestor.mob_id), 'slot_id': cursor.slot_id, 'start': cursor.start,
                            'edit_rate': str(rate_of(cursor.slot)),
                            'locators': [str(value(loc, 'URLString', '')) for loc in value(desc, 'Locator', [])]})
                    cursor = cursor.slot.segment if cursor.slot else None
                descriptor_rate = Fraction(str(value(descriptor, 'SampleRate', hz)))
                if descriptor_rate <= 0:
                    fail('The source descriptor edit rate is invalid.', 'invalid_media')
                length = round_sample(Fraction(value(descriptor, 'Length', round_sample((offset+duration)*descriptor_rate)))*hz/descriptor_rate)
                if round_sample((offset+duration)*hz) > length:
                    fail('A source reference exceeds its audio descriptor.', 'invalid_media')
                self.sources[key] = PCM(key, 0, length, int(hz), width, None)
                self.external[key] = {'id': key, 'mob_id': str(mob.mob_id), 'slot_id': slot.slot_id,
                    'locators': locators, 'ancestors': ancestors, 'channel': channel, 'channels': channels,
                    'sample_rate': int(hz), 'sample_width': width, 'sample_count': length,
                    'descriptor': type(descriptor).__name__, 'status': 'offline'}
                if len(self.external) > 10000:
                    fail('Too many linked audio sources.', 'limit_exceeded')
                return [{'kind': 'audio', 'duration': duration, 'source_id': key, 'source_start': offset,
                         'master_id': str(mob.mob_id), 'name': clean_name(mob.name, 'Audio clip')}]
        try:
            return super().expand(seg, rate, start, duration, trail, warnings_list, depth)
        except ReaderError as error:
            if error.code not in ('unsupported_aaf', 'missing_media'):
                raise
            append_warning(warnings_list, str(error))
            return [{'kind': 'unavailable', 'duration': duration}]

    def manifest(self, fingerprint):
        result = super().manifest(fingerprint)
        result.update(schema_version=3, graph={'sequence_id': str(self.mob.mob_id),
            'sources': list(self.external.values()), 'picture_tracks': self.picture_tracks, 'markers': self.markers,
            'lanes': [{'track_id': t['id'], 'parent_track_id': t.get('parent_track_id'),
                       'branch_id': t.get('branch_id'), 'group_name': t.get('group_name'),
                       'availability': t['availability']} for t in self.tracks],
            'positions': [dict(c['source_sample_position'], track_id=t['id'], clip_index=i)
                          for t in self.tracks for i, c in enumerate(t['clips']) if 'source_sample_position' in c],
            'path_mappings': []})
        return result
