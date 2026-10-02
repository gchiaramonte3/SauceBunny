"""Spike: write a NEW AAF string-out that references ORIGINAL mobs by MobID only.

Approaches (per cut = person P speaking on lane L over original-sequence frames [in, out)):
  A  SourceClip -> the group clip's CompositionMob slot that carries P's alternate
  B  SourceClip -> P's MasterMob slot (the channel), picture -> the selected angle's MasterMob
  C  copy-and-trim the ORIGINAL sequence's own component(s) under [in, out) on L's root track
     (Selector with Selected + every Alternate), then make P's alternate the Selected one;
     picture track copied and trimmed the same way, keeping the editor's angle.

Every referenced mob (group CompositionMob, MasterMobs, file/tape SourceMobs) is deep-copied
from the source AAF with its ORIGINAL MobID via pyaaf2's AAFObject.copy(root=dst).
EssenceData is never copied: output is metadata only.
"""
from dataclasses import dataclass, field
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path
import argparse
import json

import aaf2
from aaf2.components import (SourceClip, Filler, Selector, Sequence, OperationGroup,
                             SourceReference, Transition)
from aaf2.misc import TaggedValueHelper, VaryingValue


class Unsupported(Exception):
    pass


# Per-write notes (effects stripped etc.); reset by write_stringout.
WARNINGS = []
RAW_AUDIO_EFFECTS = ('Audio Pan', 'Audio Gain')


@dataclass
class Cut:
    person: str
    root_slot: int          # slot id of the ORIGINAL sequence's audio track the lane belongs to
    master_id: str          # the person's alternate: MasterMob MobID ...
    master_slot: int        # ... and its slot (= one mono channel)
    seq_in: int             # original-sequence frame, 0-based, inclusive
    seq_out: int            # exclusive
    text: str = ''
    warnings: list = field(default_factory=list)


def rate(slot):
    return Fraction(str(slot.edit_rate))


def target_of(clip):
    return (str(clip.mob_id), clip.slot_id)


# ---------------------------------------------------------------- copy + trim (approach C core)
def clone_trim(seg, offset, length, ctx_rate, dst):
    """Deep-copy seg restricted to [offset, offset+length) (edit units of ctx_rate) into dst."""
    if offset < 0 or length <= 0 or offset + length > seg.length:
        raise Unsupported(f'range {offset}+{length} outside {type(seg).__name__} of {seg.length}')
    if isinstance(seg, SourceClip):
        clip = seg.copy(root=dst)
        if seg.mob_id is not None and seg.mob_id.int != 0:
            ref = seg.slot
            if ref is None:
                raise Unsupported(f'unresolved reference {seg.mob_id}:{seg.slot_id}')
            # AAF: StartTime is in the REFERENCED slot's edit units, Length in the context's.
            delta = Fraction(offset) * rate(ref) / ctx_rate
            if delta.denominator != 1:
                raise Unsupported(f'trim of {offset} frames is not a whole edit unit at {rate(ref)}')
            clip.start = seg.start + int(delta)
        clip.length = length
        for key in ('FadeInLength', 'FadeInType', 'FadeOutLength', 'FadeOutType'):
            if key in clip:
                del clip[key]
        return clip
    if isinstance(seg, Filler):
        return dst.create.Filler(media_kind=seg.media_kind, length=length)
    if isinstance(seg, Selector):
        new = seg.copy(root=dst)                      # keeps ComponentAttributeList etc.
        new['Alternates'].value = []
        new['Selected'].value = clone_trim(seg['Selected'].value, offset, length, ctx_rate, dst)
        new['Alternates'].value = [clone_trim(a, offset, length, ctx_rate, dst)
                                   for a in (seg['Alternates'].value if 'Alternates' in seg else [])]
        new.length = length
        return new
    if isinstance(seg, Sequence):
        parts, cursor = [], 0
        for child in seg.components:
            if isinstance(child, Transition):
                # A Transition overlaps its neighbours; only refuse when the cut touches the overlap.
                cursor -= child.length
                if max(offset, cursor) < min(offset + length, cursor + child.length):
                    raise Unsupported('cut overlaps a transition (dissolve); move the in/out point off it')
                continue
            left, right = max(offset, cursor), min(offset + length, cursor + child.length)
            if left < right:
                parts.append(clone_trim(child, left - cursor, right - left, ctx_rate, dst))
            cursor += child.length
        if len(parts) == 1:
            return parts[0]
        new = dst.create.Sequence(media_kind=seg.media_kind)
        new['Components'].value = parts
        new.length = length
        return new
    if isinstance(seg, OperationGroup):
        inputs = list(seg['InputSegments'].value)
        name = seg.operation.name
        if name in RAW_AUDIO_EFFECTS and len(inputs) == 1 and inputs[0].length == seg.length:
            # MC wraps whole audio TRACKS in Audio Pan with VaryingValue parameters even when
            # flat; their control-point times are normalised to the wrapper's length. A string-out
            # takes the raw mic, the same policy the reader already applies ("pan not applied").
            note = f'{name} not carried into the string-out (raw microphone audio)'
            if note not in WARNINGS:
                WARNINGS.append(note)
            return clone_trim(inputs[0], offset, length, ctx_rate, dst)
        params = list(seg['Parameters'].value or []) if 'Parameters' in seg else []
        if any(isinstance(p, VaryingValue) for p in params):
            raise Unsupported(f'keyframed {seg.operation.name}: control points are normalised to the old length')
        inputs = list(seg['InputSegments'].value)
        if any(i.length != seg.length for i in inputs):
            raise Unsupported(f'{seg.operation.name} inputs are not the group length')
        new = seg.copy(root=dst)
        new['InputSegments'].value = []
        new['InputSegments'].value = [clone_trim(i, offset, length, ctx_rate, dst) for i in inputs]
        new.length = length
        return new
    raise Unsupported(f'{type(seg).__name__} in cut range')


def select(seg, target):
    """Along every path to a SourceClip matching target, make that branch Selected.
    Returns (found, swaps)."""
    if isinstance(seg, SourceClip):
        return target_of(seg) == target, 0
    if isinstance(seg, Sequence):
        results = [select(c, target) for c in seg.components]
        return any(r[0] for r in results), sum(r[1] for r in results)
    if isinstance(seg, OperationGroup):
        results = [select(i, target) for i in seg['InputSegments'].value]
        return any(r[0] for r in results), sum(r[1] for r in results)
    if isinstance(seg, Selector):
        current = seg['Selected'].value
        found, swaps = select(current, target)
        if found:
            return True, swaps
        alternates = list(seg['Alternates'].value)
        for index, alternate in enumerate(alternates):
            found, swaps = select(alternate, target)
            if found:
                # Swap in place: the old Selected takes P's slot, every other angle keeps its index.
                others = alternates[:index] + [current] + alternates[index + 1:]
                seg['Alternates'].value = []
                seg['Selected'].value = alternate
                seg['Alternates'].value = others
                return True, swaps + 1
        return False, 0
    return False, 0


def flatten_selected(seg, dst):
    """Approach B: replace every Selector/effect wrapper by the clip that plays; keeps piece boundaries."""
    if isinstance(seg, Sequence):
        parts = [flatten_selected(c, dst) for c in seg.components]
        new = dst.create.Sequence(media_kind=seg.media_kind)
        new['Components'].value = parts
        new.length = seg.length
        return new
    if isinstance(seg, Filler):
        return seg
    leaf = selected_leaf(seg)
    return dst.create.SourceClip(start=leaf.start, length=seg.length, mob_id=leaf.mob_id,
                                 slot_id=leaf.slot_id, media_kind=seg.media_kind)


def selected_leaf(seg):
    """Follow Selected / single-input effects down to the one SourceClip that plays (approach B)."""
    while True:
        if isinstance(seg, SourceClip):
            return seg
        if isinstance(seg, Selector):
            seg = seg['Selected'].value
        elif isinstance(seg, OperationGroup) and len(seg['InputSegments'].value) == 1:
            seg = seg['InputSegments'].value[0]
        elif isinstance(seg, Sequence) and len(seg.components) == 1:
            seg = seg.components[0]
        else:
            raise Unsupported(f'{type(seg).__name__} has no single playing clip in this range')


# ---------------------------------------------------------------- approach A helper
def group_reference(group, leaf, kind, src_mobs):
    """Find the group-clip slot whose Selector offers leaf's (mob, slot); return slot and group offset."""
    for slot in group.slots:
        seg = slot.segment
        if not isinstance(seg, Selector) or seg.media_kind.lower() != kind:
            continue
        for alt in [seg['Selected'].value] + list(seg['Alternates'].value):
            if isinstance(alt, SourceClip) and target_of(alt) == target_of(leaf):
                master_rate = rate(src_mobs[str(leaf.mob_id)].slot_at(leaf.slot_id))
                delta = Fraction(leaf.start - alt.start) * rate(slot) / master_rate
                if delta.denominator != 1 or delta < 0:
                    raise Unsupported('group offset is not a whole frame')
                return slot, int(delta), target_of(seg['Selected'].value) == target_of(leaf)
    raise Unsupported('the group clip does not offer this source')


# ---------------------------------------------------------------- mob closure copy
def referenced_mob_ids(obj):
    ids = set()
    for item, _ in obj.walk_references(topdown=True):
        if isinstance(item, SourceReference) and item.mob_id is not None and item.mob_id.int != 0:
            ids.add(str(item.mob_id))
    return ids


def copy_closure(src, dst, mob_ids):
    """Copy every mob in the derivation chains of mob_ids, keeping MobIDs. Never EssenceData."""
    pending, done = list(mob_ids), set()
    while pending:
        mob_id = pending.pop()
        if mob_id in done:
            continue
        done.add(mob_id)
        mob = src.content.mobs.get(aaf2.mobid.MobID(mob_id))
        if mob is None:
            continue  # EP REQ_EP_261: a chain may end in a reference outside the file
        if mob.mob_id not in dst.content.mobs:
            dst.content.mobs.append(mob.copy(root=dst))
        pending.extend(referenced_mob_ids(mob) - done)
    return done


# ---------------------------------------------------------------- markers
COLORS = {'Red': (41471, 12134, 6564), 'Green': (13107, 52428, 13107), 'Blue': (13107, 13107, 52428),
          'Cyan': (13107, 52428, 52428), 'Magenta': (52428, 13107, 52428), 'Yellow': (58981, 58981, 6553)}


def add_markers(dst, comp, edit_rate, track_slot, markers):
    """Avid convention seen in MC 8.6-23.12 exports: one EventMobSlot per described track,
    SlotID 1000+slot-1, PhysicalTrackNumber = the track's, DescribedSlots = {slot}."""
    if not markers:
        return
    ev = dst.create.EventMobSlot()
    ev['SlotID'].value = 1000 + track_slot.slot_id - 1
    ev['EditRate'].value = edit_rate
    ev['PhysicalTrackNumber'].value = track_slot['PhysicalTrackNumber'].value
    seq = dst.create.Sequence(media_kind='DescriptiveMetadata')
    now = datetime.now(timezone.utc)
    for position, comment, color, user in markers:
        m = dst.create.DescriptiveMarker()
        m['Position'].value = position
        m['Comment'].value = comment
        m['CommentMarkerUser'].value = user
        m['DescribedSlots'].value = {track_slot.slot_id}
        r, g, b = COLORS[color]
        m['CommentMarkerColor'].value = {'red': r, 'green': g, 'blue': b}
        attrs = TaggedValueHelper(m['CommentMarkerAttributeList'])
        attrs['_ATN_CRM_COLOR'] = color
        attrs['_ATN_CRM_USER'] = user
        attrs['_ATN_CRM_COM'] = comment
        attrs['_ATN_CRM_DATE'] = now.strftime('%m/%d/%Y')
        attrs['_ATN_CRM_TIME'] = now.strftime('%H:%M')
        attrs['_ATN_CRM_LONG_CREATE_DATE'] = int(now.timestamp())
        attrs['_ATN_CRM_LONG_MOD_DATE'] = int(now.timestamp())
        if 'Length' in m:          # MC writes point markers with no Length at all
            del m['Length']
        seq.components.append(m)
    if 'Length' in seq:
        del seq['Length']
    ev.segment = seq
    comp.slots.append(ev)


def append_piece(track_seq, piece, dst):
    """Keep track Sequences flat like MC's own exports: splice nested Sequences, merge adjacent Fillers."""
    if isinstance(piece, Sequence):
        for child in list(piece.components):
            append_piece(track_seq, child, dst)
        return
    components = track_seq.components
    if isinstance(piece, Filler) and len(components) and isinstance(components[-1], Filler):
        components[-1].length = components[-1].length + piece.length
        return
    if isinstance(piece, Filler):
        piece = dst.create.Filler(media_kind=piece.media_kind, length=piece.length)
    components.append(piece)


# ---------------------------------------------------------------- the writer
def write_stringout(src_path, dst_path, sequence_id, cuts, approach, *, name='String-out', gap=24,
                    query=None, group_id=None, start_tc=86400):
    report = {'approach': approach, 'cuts': []}
    WARNINGS.clear()
    with aaf2.open(str(src_path), 'r') as src, aaf2.open(str(dst_path), 'w') as dst:
        seq = src.content.mobs.get(aaf2.mobid.MobID(sequence_id))
        src_mobs = {str(m.mob_id): m for m in src.content.mobs}
        slots = {s.slot_id: s for s in seq.slots}
        picture = next((s for s in seq.slots if s.segment.media_kind.lower() == 'picture'), None)
        edit_rate = rate(picture or next(s for s in seq.slots if s.segment.media_kind.lower() == 'sound'))
        tc_src = next((s.segment for s in seq.slots if isinstance(s.segment, aaf2.components.Timecode)
                       and s['PhysicalTrackNumber'].value == 1), None)
        group = src_mobs[group_id] if group_id else None

        dst.dictionary.update(src.dictionary)          # op/param/data defs first (Avid pan params)
        comp = dst.create.CompositionMob(name)
        comp['UsageCode'].value = 'Usage_TopLevel'
        dst.content.mobs.append(comp)
        if query:
            comp.comments['SB_QUERY'] = query
        tc = comp.create_timeline_slot(edit_rate)
        tc.segment = dst.create.Timecode(fps=tc_src.fps if tc_src else round(edit_rate),
                                         drop=tc_src.drop if tc_src else False)
        tc.segment.start = start_tc
        tc['PhysicalTrackNumber'].value = 1
        v1 = comp.create_picture_slot(edit_rate) if picture else None
        if v1:
            v1['PhysicalTrackNumber'].value = 1
        people = list(dict.fromkeys(c.person for c in cuts))  # first appearance -> A1, A2, ...
        tracks = {}
        for number, person in enumerate(people, start=1):
            track = comp.create_sound_slot(edit_rate)
            track['PhysicalTrackNumber'].value = number
            track.name = person
            tracks[person] = track
        markers = {p: [] for p in people}
        cursor = 0
        for index, cut in enumerate(cuts):
            length = cut.seq_out - cut.seq_in
            root = slots[cut.root_slot]
            target = (cut.master_id, cut.master_slot)
            # C-style clone is the common first step; B and A collapse it.
            audio = clone_trim(root.segment, cut.seq_in, length, edit_rate, dst)
            found, swaps = select(audio, target)
            if not found:
                raise Unsupported(f'cut {index}: {cut.person} is not offered by track slot {cut.root_slot} in this range')
            pic = clone_trim(picture.segment, cut.seq_in, length, edit_rate, dst) if picture else None
            entry = {'person': cut.person, 'out_in': cursor, 'length': length, 'seq_in': cut.seq_in,
                     'selector_swaps': swaps}
            if approach == 'B':
                audio, pic = flatten_selected(audio, dst), pic and flatten_selected(pic, dst)
            elif approach == 'A':
                defaults = []

                def to_group(seg, kind):
                    if isinstance(seg, Sequence):
                        new = dst.create.Sequence(media_kind=seg.media_kind)
                        new['Components'].value = [to_group(c, kind) for c in seg.components]
                        new.length = seg.length
                        return new
                    if isinstance(seg, Filler):
                        return seg
                    gslot, gstart, is_default = group_reference(group, selected_leaf(seg), kind, src_mobs)
                    if kind == 'sound':
                        defaults.append(is_default)
                    return dst.create.SourceClip(start=gstart, length=seg.length, mob_id=group.mob_id,
                                                 slot_id=gslot.slot_id, media_kind=kind)
                audio, pic = to_group(audio, 'sound'), pic and to_group(pic, 'picture')
                entry['person_is_group_default'] = all(defaults)
            if v1:
                append_piece(v1.segment, pic, dst)
            for person, track in tracks.items():
                append_piece(track.segment, audio if person == cut.person else
                             dst.create.Filler(media_kind='sound', length=length), dst)
            markers[cut.person].append((cursor, f'{cut.person}: {cut.text}' + (f'  [query: {query}]' if query else ''),
                                        list(COLORS)[people.index(cut.person) % len(COLORS)], 'Sauce Bunny'))
            cursor += length
            if gap and index < len(cuts) - 1:
                if v1:
                    append_piece(v1.segment, dst.create.Filler(media_kind='picture', length=gap), dst)
                for track in tracks.values():
                    append_piece(track.segment, dst.create.Filler(media_kind='sound', length=gap), dst)
                cursor += gap
            report['cuts'].append(entry)
        for slot in ([v1] if v1 else []) + list(tracks.values()):
            slot.segment.length = cursor
        tc.segment.length = cursor
        for person, track in tracks.items():
            add_markers(dst, comp, edit_rate, track, markers[person])
        copied = copy_closure(src, dst, referenced_mob_ids(comp))
        # Avid names this DataDef 'Descriptive Metadata' (same AUID as pyaaf2's
        # 'DataDef_DescriptiveMetadata'). Readers that match by NAME, including
        # aaf-sidecar/graph.py, only see markers under Avid's spelling. Last step:
        # pyaaf2 resolves media kinds by short name, so nothing may look it up after.
        if any(isinstance(s, aaf2.mobslots.EventMobSlot) for s in comp.slots):
            dst.dictionary.lookup_datadef('DescriptiveMetadata').name = 'Descriptive Metadata'
        report.update(total_frames=cursor, tracks={p: t.slot_id for p, t in tracks.items()}, warnings=list(WARNINGS),
                      copied_mobs=len(copied), sequence_id=str(comp.mob_id))
    return report


def cuts_from_json(path):
    return [Cut(**c) for c in json.loads(Path(path).read_text())]


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--sequence-id', required=True)
    parser.add_argument('--cuts', required=True, help='JSON list of Cut fields')
    parser.add_argument('--approach', choices='ABC', required=True)
    parser.add_argument('--group-id')
    parser.add_argument('--query')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    out = Path(args.output)
    if out.exists():
        out.unlink()
    result = write_stringout(args.source, out, args.sequence_id, cuts_from_json(args.cuts), args.approach,
                             query=args.query, group_id=args.group_id)
    result['bytes'] = out.stat().st_size
    Path(str(out) + '.report.json').write_text(json.dumps(result, indent=1))
    print(json.dumps(result, indent=1))
