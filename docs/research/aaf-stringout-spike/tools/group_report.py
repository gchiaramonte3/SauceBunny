"""READ-ONLY: summarise how an Avid AAF encodes group / multigroup edits. Opens no locators, no media.

Answers the questions the string-out writer depends on:
  * Are group edits inline Selectors in the sequence, or SourceClips into a group CompositionMob?
  * What do Selected / Alternates point at (MasterMob? CompositionMob? nested Selector?)
  * Which Avid-private attributes ride on Selectors (ComponentAttributeList / UserComments)?
  * Which CompositionMobs exist besides the sequence, and with which UsageCode?
Usage: python group_report.py "Sequence with a Group Clip.aaf" [--max-selectors 12]
"""
import argparse
import collections
import json

import aaf2
from aaf2.components import SourceClip, Selector, Sequence, OperationGroup, Filler


def v(obj, key, default=None):
    prop = obj.get(key)
    return prop.value if prop is not None and prop.value is not None else default


def tags(obj, key):
    return {t.name: str(t.value)[:80] for t in v(obj, key, []) or []}


def target(seg):
    if isinstance(seg, SourceClip):
        mob = seg.mob
        return {'class': 'SourceClip', 'mob': type(mob).__name__ if mob else 'MISSING', 'mob_name': mob.name if mob else None,
                'usage': v(mob, 'UsageCode') if mob else None, 'slot': seg.slot_id, 'start': seg.start, 'length': seg.length,
                'attributes': tags(seg, 'ComponentAttributeList')}
    if isinstance(seg, Selector):
        return {'class': 'Selector (nested)', 'alternates': len(v(seg, 'Alternates', []) or [])}
    return {'class': type(seg).__name__, 'length': getattr(seg, 'length', None)}


def walk(seg, found, counts, depth=0):
    counts[type(seg).__name__] += 1
    if depth > 12:
        return
    if isinstance(seg, Selector):
        found.append(seg)
    if isinstance(seg, Sequence):
        for c in seg.components:
            walk(c, found, counts, depth + 1)
    elif isinstance(seg, OperationGroup):
        for c in v(seg, 'InputSegments', []) or []:
            walk(c, found, counts, depth + 1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('aaf')
    parser.add_argument('--max-selectors', type=int, default=12)
    args = parser.parse_args()
    with aaf2.open(args.aaf, 'r') as f:
        out = {'identification': [v(i, 'ProductName') for i in f.header['IdentificationList'].value],
               'essence_data': len(list(f.content.essencedata)),
               'mobs': collections.Counter(type(m).__name__ for m in f.content.mobs),
               'composition_mobs': [{'name': m.name, 'usage': v(m, 'UsageCode'), 'slots': len(m.slots),
                                     'attributes': tags(m, 'MobAttributeList')}
                                    for m in f.content.compositionmobs()][:40],
               'sequences': []}
        for seq in f.content.toplevel():
            entry = {'name': seq.name, 'tracks': []}
            for slot in seq.slots:
                kind = slot.segment.media_kind
                if kind.lower() not in ('sound', 'picture'):
                    continue
                selectors, counts = [], collections.Counter()
                walk(slot.segment, selectors, counts)
                refs_to_compositions = sum(1 for s in selectors for c in [v(s, 'Selected')] + list(v(s, 'Alternates', []) or [])
                                           if isinstance(c, SourceClip) and isinstance(c.mob, aaf2.mobs.CompositionMob))
                track = {'slot': slot.slot_id, 'kind': kind, 'phys': v(slot, 'PhysicalTrackNumber'),
                         'component_counts': dict(counts), 'selectors': len(selectors),
                         'selector_choices_into_composition_mobs': refs_to_compositions,
                         'track_attributes': tags(slot, 'TimelineMobAttributeList')}
                if selectors:
                    s = selectors[0]
                    track['first_selector'] = {'length': s.length, 'attributes': tags(s, 'ComponentAttributeList'),
                                               'user_comments': tags(s, 'UserComments'),
                                               'selected': target(v(s, 'Selected')),
                                               'alternates': [target(a) for a in v(s, 'Alternates', []) or []][:args.max_selectors]}
                entry['tracks'].append(track)
            out['sequences'].append(entry)
        # Any sequence-level SourceClip that references a CompositionMob (group clip / subclip / nest)?
        direct = collections.Counter()
        for seq in f.content.toplevel():
            for obj, _ in seq.walk_references(topdown=True):
                if isinstance(obj, SourceClip) and obj.mob is not None and not isinstance(obj.mob, (aaf2.mobs.MasterMob, aaf2.mobs.SourceMob)):
                    direct[f"{type(obj.mob).__name__}:{v(obj.mob, 'UsageCode')}"] += 1
        out['sourceclips_into_composition_mobs'] = dict(direct)
    print(json.dumps(out, indent=1, default=str))


if __name__ == '__main__':
    main()
