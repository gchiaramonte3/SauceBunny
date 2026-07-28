import { describe, expect, it } from "vitest";
import { cueKey, retagCues } from "./helpers";
import { groupIntoTurns, type Cue } from "../../lib/srt";

/**
 * The per-cue speaker layer, and the reason it exists.
 *
 * "These two people were merged into one speaker" is the commonest thing
 * wrong with a diarized transcript, and until now the only reassignment the
 * app had was per-TURN — a layer whose own comment admitted cue-level
 * consumers could not read it, so the on-video captions, the AI summary, the
 * reader analysis and the timeline lanes all kept the wrong name.
 */
const cue = (start: number, end: number, speaker: string | null, text = "x"): Cue =>
  ({ index: 0, start, end, text, speaker });

describe("retagCues", () => {
  it("returns the SAME array when there is nothing to apply", () => {
    // Every consumer calls this unconditionally, on every render in the
    // caption overlay's case. It must not allocate a copy per frame.
    const cues = [cue(0, 1, "SPEAKER_00")];
    expect(retagCues(cues, { cueTag: {} })).toBe(cues);
  });

  it("returns the same array when the override matches what is already there", () => {
    const cues = [cue(0, 1, "SPEAKER_00")];
    expect(retagCues(cues, { cueTag: { "0": "SPEAKER_00" } })).toBe(cues);
  });

  it("retags by cue START in whole milliseconds", () => {
    const cues = [cue(1.25, 2, "SPEAKER_00"), cue(3, 4, "SPEAKER_00")];
    const out = retagCues(cues, { cueTag: { [cueKey(1.25)]: "CAST_A" } });
    expect(out[0].speaker).toBe("CAST_A");
    expect(out[1].speaker).toBe("SPEAKER_00"); // untouched
    expect(cues[0].speaker).toBe("SPEAKER_00"); // input not mutated
  });

  it("rounds to the millisecond, so float noise cannot orphan an assignment", () => {
    // SRT times are millisecond-precision text, but they arrive here as
    // floats. 1.2340000000000002 must find the key written for 1.234.
    expect(cueKey(1.234)).toBe(cueKey(1.2340000000000002));
    const cues = [cue(1.2340000000000002, 2, "SPEAKER_00")];
    expect(retagCues(cues, { cueTag: { "1234": "CAST_A" } })[0].speaker).toBe("CAST_A");
  });

  it('treats "" as the UNTAGGED group, not as a speaker named nothing', () => {
    // A JSON object cannot store null as a distinct "assigned to nobody"
    // without it being confusable with "absent", so "" is the wire form. If it
    // survived as an empty string it would reach humanizeSpeakerTag and render
    // a nameless label instead of falling into the unknown group.
    const out = retagCues([cue(0, 1, "SPEAKER_00")], { cueTag: { "0": "" } });
    expect(out[0].speaker).toBeNull();
  });

  it("does not copy when a cue is already untagged and is set untagged", () => {
    const cues = [cue(0, 1, null)];
    expect(retagCues(cues, { cueTag: { "0": "" } })).toBe(cues);
  });
});

describe("splitting a turn is just retagging its cues", () => {
  // The whole mechanism. There is no turn-splitting code anywhere, and this
  // is why: groupIntoTurns starts a new turn whenever the speaker changes, so
  // retagging a RUN of cues in the middle of a turn splits it into three for
  // free.
  const oneTurn = [
    cue(0, 1, "SPEAKER_00", "a"),
    cue(1, 2, "SPEAKER_00", "b"),
    cue(2, 3, "SPEAKER_00", "c"),
    cue(3, 4, "SPEAKER_00", "d"),
    cue(4, 5, "SPEAKER_00", "e"),
  ];

  it("is one turn before", () => {
    expect(groupIntoTurns(oneTurn)).toHaveLength(1);
  });

  it("splits into three when a middle run is reassigned", () => {
    const turns = groupIntoTurns(retagCues(oneTurn, {
      cueTag: { [cueKey(2)]: "CAST_A", [cueKey(3)]: "CAST_A" },
    }));
    expect(turns.map((t) => t.speaker)).toEqual(["SPEAKER_00", "CAST_A", "SPEAKER_00"]);
    expect(turns.map((t) => t.cues.length)).toEqual([2, 2, 1]);
    // Timing follows the cues, so the new turn spans exactly what was picked.
    expect(turns[1].start).toBe(2);
    expect(turns[1].end).toBe(4);
  });

  it("splits into two when the run starts at the top", () => {
    const turns = groupIntoTurns(retagCues(oneTurn, {
      cueTag: { [cueKey(0)]: "CAST_A", [cueKey(1)]: "CAST_A" },
    }));
    expect(turns.map((t) => t.speaker)).toEqual(["CAST_A", "SPEAKER_00"]);
  });

  it("splits into two when the run runs to the end", () => {
    const turns = groupIntoTurns(retagCues(oneTurn, {
      cueTag: { [cueKey(3)]: "CAST_A", [cueKey(4)]: "CAST_A" },
    }));
    expect(turns.map((t) => t.speaker)).toEqual(["SPEAKER_00", "CAST_A"]);
  });

  it("rejoins when the whole turn is reassigned", () => {
    const turns = groupIntoTurns(retagCues(oneTurn, {
      cueTag: Object.fromEntries(oneTurn.map((c) => [cueKey(c.start), "CAST_A"])),
    }));
    expect(turns).toHaveLength(1);
    expect(turns[0].speaker).toBe("CAST_A");
  });

  it("merges with a NEIGHBOURING turn of the same speaker, as it should", () => {
    // Reassigning the tail of A's turn to B, where B already speaks next,
    // must produce two turns and not three. groupIntoTurns handles it because
    // it only ever compares against the turn it is currently extending.
    const cues = [
      cue(0, 1, "SPEAKER_00"), cue(1, 2, "SPEAKER_00"),
      cue(2, 3, "SPEAKER_01"),
    ];
    const turns = groupIntoTurns(retagCues(cues, { cueTag: { [cueKey(1)]: "SPEAKER_01" } }));
    expect(turns.map((t) => t.speaker)).toEqual(["SPEAKER_00", "SPEAKER_01"]);
    expect(turns[1].cues).toHaveLength(2);
  });
});
