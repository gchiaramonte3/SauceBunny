# AAF string-out spike (research prototype)

Prototype code behind "Getting the cut back into Avid" in
[`../../AAF-ASSEMBLY-RESEARCH.md`](../../AAF-ASSEMBLY-RESEARCH.md). **Not shipped,
not bundled, not run by CI.** It is kept so Phase 0 starts from the code that was
measured instead of from a description of it.

It writes a new AAF string-out that references the ORIGINAL Avid mobs by MobID
and copies their definitions, with no essence, three ways:

- **A**: a SourceClip into the group clip. Fails in principle: it plays the
  group's default angle.
- **B**: a SourceClip into the speaker's MasterMob channel.
- **C**: copies and trims the original group Selector for the range, with the
  speaker selected.

Each output is re-read with the app's own reader (`aaf-sidecar/graph.py`), and
every frame of every bite is compared with the original sequence's source mob,
slot and sample.

## Run it

It needs the same pinned pyaaf2 as the sidecar tests (see `scripts/test-aaf.sh`
for how that environment is created). Then:

```bash
PY=/path/to/venv/bin/python bash docs/research/aaf-stringout-spike/run_spike.sh
# -> out/stringout_{A,B,C}.aaf and out/verify.json
```

Result when this was written: A had 560 of 680 frames wrong; B and C had
0 of 680. There was no essence data and no dangling reference.

| Script | What it does |
|---|---|
| `make_source_fixture.py` | An Avid-shaped linked fixture, with no media: 5 recorders × 4 channels, 2 cameras, inline group Selectors with an angle switch, and a marker |
| `make_cuts.py` | Picks the test bites |
| `write_stringout.py` | The writer (approaches A, B and C) |
| `verify_stringout.py` | Re-reads each output and compares every frame |
| `run_repo_fixture.py`, `run_scale.py` | The repo's own group fixture, and a 100-lane / 60-bite scale run |
| `run_real_avid.py` | Genuine Media Composer exports. It expects public sample AAFs from the OpenTimelineIO and LibAAF repositories under `otio-repo/` and `refs/LibAAF/` (not committed) |
| `tools/group_report.py` | **Read-only.** Shows how an AAF encodes group edits. This is step 1 of the Mac test plan |
| `tools/dump_aaf.py`, `tools/deep_compare.py` | Inspection helpers |

Media Composer was not available when this was written. Nothing here proves
what Avid does on import; the Mac test plan in the research doc does.
