"""Compact structural dump of an AAF: mobs, slots, and the component tree.

Read-only. Used to learn how real (Avid-exported) AAFs lay out mob chains,
selectors, markers and audio channel references.
"""
import sys
import aaf2

MAXC = 12


def v(obj, key, default=None):
    p = obj.get(key)
    return p.value if p is not None else default


def seg_str(seg):
    t = type(seg).__name__
    parts = [t, f"len={getattr(seg, 'length', None)}"]
    try:
        parts.append(f"kind={seg.media_kind}")
    except Exception:
        pass
    if isinstance(seg, aaf2.components.SourceClip):
        mob = seg.mob
        parts.append(f"start={seg.start} -> {type(mob).__name__ if mob else 'MISSING'}"
                     f" '{mob.name if mob else ''}' {str(seg.mob_id)[-12:]} slot={seg.slot_id}")
    if isinstance(seg, aaf2.components.Timecode):
        parts.append(f"tc_start={seg.start} fps={seg.fps} drop={seg.drop}")
    if isinstance(seg, aaf2.components.OperationGroup):
        parts.append(f"op='{v(seg, 'Operation').name}'")
    if isinstance(seg, (aaf2.components.CommentMarker,)):
        parts.append(f"pos={v(seg,'Position')} comment={str(v(seg,'Comment',''))[:40]!r} described={list(v(seg,'DescribedSlots',[]) or [])}")
        attrs = {t.name: t.value for t in v(seg, 'CommentMarkerAttributeList', []) or []}
        if attrs:
            parts.append(f"attrs={attrs}")
        col = v(seg, 'CommentMarkerColor')
        if col:
            parts.append(f"color={col}")
        user = v(seg, 'CommentMarkerUser')
        if user:
            parts.append(f"user={user!r}")
    return ' '.join(parts)


def walk(seg, indent, depth=0):
    pad = '  ' * indent
    print(pad + seg_str(seg))
    if depth > 8:
        return
    if isinstance(seg, aaf2.components.Sequence):
        comps = list(seg.components)
        for c in comps[:MAXC]:
            walk(c, indent + 1, depth + 1)
        if len(comps) > MAXC:
            print(pad + f'  ... {len(comps) - MAXC} more')
    elif isinstance(seg, aaf2.components.Selector):
        print(pad + '  [Selected]')
        walk(v(seg, 'Selected'), indent + 2, depth + 1)
        for a in v(seg, 'Alternates', []) or []:
            print(pad + '  [Alternate]')
            walk(a, indent + 2, depth + 1)
    elif isinstance(seg, aaf2.components.OperationGroup):
        for c in v(seg, 'InputSegments', []) or []:
            walk(c, indent + 1, depth + 1)
        for p in v(seg, 'Parameters', []) or []:
            print(pad + f'  param {p.name if hasattr(p, "name") else p}')
    elif isinstance(seg, aaf2.components.Transition):
        pass
    elif isinstance(seg, aaf2.components.EssenceGroup):
        for c in v(seg, 'Choices', []) or []:
            walk(c, indent + 1, depth + 1)


def dump_mob(mob, show_attrs=True):
    print(f"\n## {type(mob).__name__} '{mob.name}' {mob.mob_id} usage={v(mob,'UsageCode')}")
    if show_attrs:
        attrs = {t.name: t.value for t in v(mob, 'MobAttributeList', []) or []}
        if attrs:
            print(f"   MobAttributeList={attrs}")
        comments = {t.name: t.value for t in v(mob, 'UserComments', []) or []}
        if comments:
            print(f"   UserComments={comments}")
    if isinstance(mob, aaf2.mobs.SourceMob):
        d = mob.descriptor
        locs = [v(l, 'URLString') for l in (v(d, 'Locator', []) or [])] if d else []
        extra = ''
        if isinstance(d, aaf2.essence.MultipleDescriptor):
            extra = ' children=' + ','.join(f"{type(c).__name__}(linked={v(c,'LinkedSlotID')})" for c in v(d,'FileDescriptors',[]) or [])
        print(f"   descriptor={type(d).__name__ if d else None} len={v(d,'Length') if d else None} rate={v(d,'SampleRate') if d else None} locators={locs}{extra}")
    for slot in mob.slots:
        tattrs = {t.name: t.value for t in v(slot, 'TimelineMobAttributeList', []) or []}
        print(f" slot {slot.slot_id} {type(slot).__name__} name={slot.name!r} rate={getattr(slot,'edit_rate',None)} "
              f"phys={v(slot,'PhysicalTrackNumber')} origin={v(slot,'Origin')} markin={v(slot,'MarkIn')}"
              + (f" tattrs={tattrs}" if tattrs else ''))
        walk(slot.segment, 2)


def main(path, only_top=False):
    with aaf2.open(path, 'r') as f:
        ident = [(v(i, 'CompanyName'), v(i, 'ProductName'), str(v(i, 'ProductVersionString'))) for i in f.header['IdentificationList'].value]
        print('Identification:', ident)
        print('EssenceData count:', len(list(f.content.essencedata)))
        mobs = list(f.content.mobs)
        print('Mob counts:', {k: sum(1 for m in mobs if type(m).__name__ == k) for k in ('CompositionMob', 'MasterMob', 'SourceMob')})
        for mob in mobs:
            if only_top and not (isinstance(mob, aaf2.mobs.CompositionMob)):
                continue
            dump_mob(mob)


if __name__ == '__main__':
    main(sys.argv[1], only_top='--comp' in sys.argv)
