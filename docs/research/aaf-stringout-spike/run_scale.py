"""Scale run: 20 root tracks x 5 recorders (100 lanes, like the user's 98-lane group AAF), 60 random cuts.
Writes C and B, verifies every frame through GraphTimeline, reports time and size."""
from fractions import Fraction
from pathlib import Path
import json, random, subprocess, sys, time
sys.path.insert(0, str(Path(__file__).parent))
from write_stringout import Cut, write_stringout
import verify_stringout as V
import graph
# The repo reader caps expanded lanes at 256 and counts them per Selector INSTANCE; a C string-out
# with 60 cuts has 60 Selectors x 4 alternates. Raised here, in this process only, to verify positions.
graph.MAX_AUDIO_LANES = 100000

HERE = Path(__file__).parent
src = HERE / 'out' / 'scale_source.aaf'
subprocess.run([sys.executable, str(HERE / 'make_source_fixture.py'), '--output', str(src),
                '--recorders', '5', '--channels', '20'], check=True, capture_output=True)
info = json.loads(Path(str(src) + '.json').read_text())
rng = random.Random(7)
people = info['people']
names = sorted(people)
cuts = []
for i in range(60):
    person = rng.choice(names)
    ch = people[person]['channel']
    start = rng.randrange(info['lead'], info['total'] - info['lead'] - 200)
    cuts.append(Cut(person=person, root_slot=2 + ch, master_id=people[person]['master_id'],
                    master_slot=people[person]['master_slot'], seq_in=start, seq_out=start + rng.randrange(48, 200),
                    text=f'bite {i}'))
original = V.manifest(src, info['sequence_id'])
out = {}
for approach in 'CB':
    dst = HERE / 'out' / f'scale_stringout_{approach}.aaf'
    if dst.exists():
        dst.unlink()
    t0 = time.perf_counter()
    report = write_stringout(src, dst, info['sequence_id'], cuts, approach, query='scale test')
    elapsed = time.perf_counter() - t0
    m = V.manifest(dst, report['sequence_id'])
    tracks = {t['id']: t for t in m['tracks']}
    checked = bad = 0
    for cut, entry in zip(cuts, report['cuts']):
        track = tracks[str(report['tracks'][cut.person])]
        c = cut.__dict__
        for frame in range(cut.seq_in, cut.seq_out):
            want = V.expected_for(original, c, V.Fraction(48000) / Fraction(24000, 1001), frame)
            got = V.clip_at(track, entry['out_in'] + frame - cut.seq_in)
            checked += 1
            if not got or (got.get('source_id'), V.position(got, entry['out_in'] + frame - cut.seq_in, Fraction(48000) / Fraction(24000, 1001))) != want[:2]:
                bad += 1
    integ = V.integrity(str(dst), str(src))
    out[approach] = {'write_seconds': round(elapsed, 2), 'bytes': dst.stat().st_size, 'mobs': integ['mobs'],
                     'essence_data': integ['essence_data'], 'dangling': len(integ['dangling']),
                     'output_tracks': len(report['tracks']), 'frames_checked': checked, 'frames_mismatched': bad,
                     'swaps': sum(e['selector_swaps'] for e in report['cuts']), 'reader_lanes': len(m['tracks']),
                     'markers': integ['marker_count']}
print(json.dumps({'source_bytes': src.stat().st_size, 'source_lanes': len(original['tracks']), **out}, indent=1))
