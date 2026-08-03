import { describe, expect, it } from "vitest";
import { parseProducerNotes } from "./note-import";

/**
 * The fixture is a REAL producer notes doc, verbatim including its typos —
 * "00::08:10", "00:21 -00:43", "espceially". A parser tested only against
 * clean input would be tested against input that does not exist.
 */
const REAL_NOTES = `Harry's bite from 00:00:12 - 00:03 to his next bite at 00:05 - 00:13 - sound so different, I know one is from INTV and the other is from a reality scene, what can we do to help make these bites feel more smooth?
00:05 - do we have a shot that feels more full, like it's 20 women, this feels a little sparce
00:08  & 00::08:10 - this shot of the rings looks crooked, I think it might be better to see more girls putting on their engagement rings
00:16 - I think this Amanda beat might need to come before we see him meet the girls, then we hear Mya B say, "We're gonna marry Harry"
00:17 - think we need to lose this part of Harry's line too, espceially since we lost Georgia's line
00:21 -00:43 - not noting since youre working on it now :)
01:57 - I'm feeling like this is a sharp turn, i almost feel like I need to hear sam say she's leaving? Open to discussing!
2:24 - not sure if this is a render issus, but it feels like it's black for a long time here
2:28 - let's lose this shot of Amber and live in the Harry/Danelle moment
2:45 - slightly strange transition (either a render issue or a disolve thing)
2:52 - Id like to see Amber once Amanda starts to say her name, but I do love this shot of Georgia, maybe we can re-purpose?
2:52 - 3:00, i think the shots need a little re-order in this section, that way we can condense. I also thing we need a shot of Harry and Amber at the alter together, before we hear, "I now pronouce you husband and wife"
At the end were we adding any of the bites? I know we are pushing TRT here, but we were going to add, "I married Harry" right?`;

/** The cut these notes were written against runs about 3:05. */
const OPTS = { durationSec: 185, fps: 30 };

describe("the real notes doc, end to end", () => {
  const rows = parseProducerNotes(REAL_NOTES, OPTS);

  it("keeps every line — nothing a producer wrote is dropped", () => {
    expect(rows).toHaveLength(13);
  });

  it("anchors the plain timecoded lines", () => {
    const bySec = (s: number) => rows.find((r) => r.startSec === s);
    expect(bySec(5)?.body).toMatch(/^do we have a shot/);
    expect(bySec(16)?.body).toMatch(/^I think this Amanda beat/);
    expect(bySec(17)?.body).toMatch(/^think we need to lose/);
    expect(bySec(117)?.body).toMatch(/^I'm feeling like this is a sharp turn/);
    expect(bySec(144)?.body).toMatch(/render issus/);
    expect(bySec(148)?.body).toMatch(/^let's lose this shot of Amber/);
    expect(bySec(165)?.body).toMatch(/^slightly strange transition/);
  });

  it("reads a range even with the space missing: 00:21 -00:43", () => {
    const r = rows.find((x) => x.body.includes("not noting"));
    expect(r?.startSec).toBe(21);
    expect(r?.endSec).toBe(43);
  });

  it("reads the 2:52 - 3:00 range and strips its comma", () => {
    const r = rows.find((x) => x.body.startsWith("i think the shots need"));
    expect(r?.startSec).toBe(172);
    expect(r?.endSec).toBe(180);
  });

  it("survives the double-colon typo and the ampersand join", () => {
    // "00:08  & 00::08:10" — h:mm:ss would put the end at 490s, past the end
    // of a three-minute cut, so it re-reads as mm:ss:ff.
    const r = rows.find((x) => x.body.includes("rings looks crooked"));
    expect(r?.startSec).toBe(8);
    expect(r?.endSec).toBeCloseTo(8 + 10 / 30, 2);
  });

  it("anchors a line whose timecode is buried mid-sentence, keeping the prose", () => {
    const r = rows[0];
    expect(r.body).toMatch(/^Harry's bite from/); // NOT stripped
    // First pair "00:00:12 - 00:03": 12s > 3s, swapped into a truthful span.
    expect(r.startSec).toBe(3);
    expect(r.endSec).toBe(12);
  });

  it("keeps the untimed closing question as a general note", () => {
    const r = rows[rows.length - 1];
    expect(r.startSec).toBeNull();
    expect(r.body).toMatch(/^At the end/);
    expect(r.suspectHeader).toBe(false); // a sentence, not sheet furniture
  });

  it("keeps quoted dialogue in bodies intact", () => {
    expect(rows.find((r) => r.startSec === 16)?.body).toContain('"We\'re gonna marry Harry"');
  });
});

describe("sheet furniture", () => {
  it("flags headers and title rows, but returns them", () => {
    const rows = parseProducerNotes("LMH REUNION - CUTS\nNOTE\nSTORY NOTES\nEDITOR ADDRESSED\n00:05 - real note");
    expect(rows).toHaveLength(5);
    expect(rows.slice(0, 4).every((r) => r.suspectHeader)).toBe(true);
    expect(rows[4].suspectHeader).toBe(false);
  });

  it("does not flag a real general note as furniture", () => {
    const rows = parseProducerNotes("Can we look at the color on the beach scenes?");
    expect(rows[0].suspectHeader).toBe(false);
    expect(rows[0].startSec).toBeNull();
  });
});

describe("timecode readings", () => {
  it("reads m:ss and h:mm:ss", () => {
    expect(parseProducerNotes("2:24 - x")[0].startSec).toBe(144);
    expect(parseProducerNotes("1:02:03 - x")[0].startSec).toBe(3723);
  });

  it("keeps h:mm:ss when no duration says otherwise", () => {
    // Without a duration there is no licence to reinterpret.
    expect(parseProducerNotes("00:08:10 - x")[0].startSec).toBe(490);
  });

  it("reads hh:mm:ss:ff with the given fps", () => {
    const r = parseProducerNotes("00:01:30:12 - x", { fps: 24 })[0];
    expect(r.startSec).toBeCloseTo(90.5, 3);
  });

  it("treats an equal-endpoints range as a point", () => {
    const r = parseProducerNotes("2:52 - 2:52 - twice the same spot")[0];
    expect(r.startSec).toBe(172);
    expect(r.endSec).toBeNull();
  });

  it("does not range across ordinary prose between two timecodes", () => {
    const r = parseProducerNotes("00:10 - compare with the beat at 00:40 please")[0];
    expect(r.startSec).toBe(10);
    expect(r.endSec).toBeNull(); // "compare with the beat at" is not a range separator
  });

  it("uses the line's words even when the line is only a timecode", () => {
    const r = parseProducerNotes("00:42")[0];
    expect(r.startSec).toBe(42);
    expect(r.body).toBe("00:42"); // an empty comment body helps nobody
  });
});

describe("Google Sheets quoting", () => {
  it("folds a quoted multi-line cell into one note", () => {
    const pasted = `00:05 - first note\n"00:16 - a note that\nwraps to a second line"\n00:20 - after`;
    const rows = parseProducerNotes(pasted);
    expect(rows).toHaveLength(3);
    expect(rows[1].startSec).toBe(16);
    expect(rows[1].body).toBe("a note that wraps to a second line");
  });

  it("unescapes doubled quotes inside a quoted cell", () => {
    const rows = parseProducerNotes('"00:16 - she says ""marry Harry"" here"');
    expect(rows[0].body).toBe('she says "marry Harry" here');
  });

  it("passes a lone stray quote through without eating the rest of the paste", () => {
    const rows = parseProducerNotes('00:05 - a "quote that never closes\n00:10 - still its own note');
    // The unbalanced quote joins the two lines — the flush-at-EOF path — but
    // nothing is lost.
    expect(rows.flatMap((r) => r.body).join(" ")).toContain("still its own note");
  });

  it("returns nothing for an empty paste", () => {
    expect(parseProducerNotes("")).toHaveLength(0);
    expect(parseProducerNotes("\n\n  \n")).toHaveLength(0);
  });
});
