"""Turn 'transcript hits' into Cut records for the fixture (person -> MasterMob/slot from the fixture manifest)."""
import json, sys
m = json.load(open(sys.argv[1]))
P = m['people']


def cut(person, root_slot, a, b, text):
    return {'person': person, 'root_slot': root_slot, 'master_id': P[person]['master_id'],
            'master_slot': P[person]['master_slot'], 'seq_in': a, 'seq_out': b, 'text': text}


cuts = [
    cut('FRANKIE', 3, 300, 420, "I told you, I am not doing the dishes tonight."),   # alternate on A1 -> swap
    cut('ASHLEY', 3, 1500, 1620, "Nobody asked you to do the dishes."),              # selected on A1
    cut('NICOLE', 4, 3500, 3620, "Can we please just eat?"),                         # alternate on A2 -> swap
    cut('FRANKIE', 3, 5000, 5100, "Fine. But I'm not doing them tomorrow either."),  # selected on A1 (seg 2)
    cut('BARTLEY', 6, 6500, 6600, "This is the best night of my life."),             # A4, inside Audio Pan
    cut('FRANKIE', 3, 2990, 3110, "...and another thing."),                          # spans the angle switch at 3048
]
json.dump(cuts, open(sys.argv[2], 'w'), indent=1)
