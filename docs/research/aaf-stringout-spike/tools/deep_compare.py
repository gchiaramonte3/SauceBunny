"""Deep-compare every non-top-level mob in an output AAF with the same-MobID mob in the source."""
import sys
import aaf2
from aaf2 import properties as P


def same(a, b, path='', diffs=None):
    diffs = [] if diffs is None else diffs
    if type(a) is not type(b):
        diffs.append(f'{path}: {type(a).__name__} != {type(b).__name__}')
        return diffs
    names = {p.name for p in a.properties()} | {p.name for p in b.properties()}
    for name in sorted(n for n in names if n):
        pa, pb = a.get(name, allkeys=False), b.get(name, allkeys=False)
        here = f'{path}/{name}'
        if (pa is None) != (pb is None):
            diffs.append(f'{here}: present only on one side')
        elif isinstance(pa, P.StrongRefProperty):
            same(pa.value, pb.value, here, diffs)
        elif isinstance(pa, (P.StrongRefVectorProperty, P.StrongRefSetProperty)):
            va, vb = list(pa.value), list(pb.value)
            if len(va) != len(vb):
                diffs.append(f'{here}: {len(va)} != {len(vb)} items')
            for i, (x, y) in enumerate(zip(va, vb)):
                same(x, y, f'{here}[{i}]', diffs)
        elif isinstance(pa, (P.WeakRefProperty,)):
            if pa.value.auid != pb.value.auid:
                diffs.append(f'{here}: weakref {pa.value.auid} != {pb.value.auid}')
        elif isinstance(pa, P.StreamProperty):
            diffs.append(f'{here}: STREAM present (essence?)')
        elif not isinstance(pa, P.WeakRefArrayProperty) and pa.value != pb.value:
            diffs.append(f'{here}: {pa.value!r} != {pb.value!r}')
    return diffs


def main(source, output):
    with aaf2.open(source) as s, aaf2.open(output) as o:
        top = {str(m.mob_id) for m in o.content.toplevel()}
        compared, diffs = 0, []
        for mob in o.content.mobs:
            if str(mob.mob_id) in top:
                continue
            compared += 1
            diffs += same(s.content.mobs.get(mob.mob_id), mob, f'{type(mob).__name__}:{mob.name}')
        print({'output': output, 'mobs_compared': compared, 'differences': diffs[:10], 'difference_count': len(diffs)})


if __name__ == '__main__':
    for out in sys.argv[2:]:
        main(sys.argv[1], out)
