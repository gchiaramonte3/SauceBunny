import { describe, expect, it } from "vitest";
import { parseSrt, groupIntoTurns, fmtTime, serializeCues, secondsToCueTc, type Cue } from "./srt";

// The parser is the single highest-blast-radius pure module in the app: the
// transcript panel, the on-video captions, search, click-to-seek, and every
// export all read its output. Each regression test below pins a bug the r85
// review actually found in production code.

const SRT = `1
00:00:00,190 --> 00:00:10,780
[SPEAKER_00]: The greatest weapon of humankind

2
00:00:10,780 --> 00:00:19,910
[SPEAKER_01]: is their very own mind.
`;

describe("parseSrt — SRT basics", () => {
  it("parses cues with machine speaker tags", () => {
    const cues = parseSrt(SRT);
    expect(cues).toHaveLength(2);
    expect(cues[0].start).toBeCloseTo(0.19, 3);
    expect(cues[0].end).toBeCloseTo(10.78, 3);
    expect(cues[0].speaker).toBe("SPEAKER_00");
    expect(cues[0].text).toBe("The greatest weapon of humankind");
    expect(cues[1].speaker).toBe("SPEAKER_01");
  });

  it("tolerates CRLF line endings and a UTF-8 BOM", () => {
    const crlf = "﻿" + SRT.replace(/\n/g, "\r\n");
    const cues = parseSrt(crlf);
    expect(cues).toHaveLength(2);
    expect(cues[0].text).toContain("greatest weapon");
  });
});

describe("parseSrt — WebVTT", () => {
  it("parses a standard VTT with hours", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello there.
`;
    const cues = parseSrt(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].start).toBeCloseTo(1, 3);
  });

  // r85 review: hour-less MM:SS.mmm (Rev, Premiere, browser exports) parsed
  // to ZERO cues and the viewer showed "Transcript is empty".
  it("parses hour-less MM:SS.mmm timestamps", () => {
    const vtt = `WEBVTT

00:01.000 --> 00:04.500
First line.

01:02.250 --> 01:05.000
Second line.
`;
    const cues = parseSrt(vtt);
    expect(cues).toHaveLength(2);
    expect(cues[0].start).toBeCloseTo(1, 3);
    expect(cues[0].end).toBeCloseTo(4.5, 3);
    expect(cues[1].start).toBeCloseTo(62.25, 3);
  });

  it("extracts <v Name> voice tags as speakers and strips the markup", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
<v Roger Bingham>We are in New York City
`;
    const cues = parseSrt(vtt);
    expect(cues[0].speaker).toBe("Roger Bingham");
    expect(cues[0].text).toBe("We are in New York City");
  });
});

describe("parseSrt — entity decoding", () => {
  // r85 review: &nbsp; rendered literally in the reader and all exports;
  // &amp; decoded FIRST double-decoded "&amp;lt;" into "<".
  it("decodes &nbsp; and &#160; to spaces", () => {
    const srt = `1
00:00:01,000 --> 00:00:02,000
he's [&nbsp;__&nbsp;] bricks&#160;now
`;
    const cues = parseSrt(srt);
    expect(cues[0].text).not.toContain("&nbsp;");
    expect(cues[0].text).toBe("he's [ __ ] bricks now");
  });

  it("decodes &amp; LAST so &amp;lt; yields a literal &lt;", () => {
    const srt = `1
00:00:01,000 --> 00:00:02,000
a &amp;lt; b &amp; c &lt; d
`;
    const cues = parseSrt(srt);
    expect(cues[0].text).toBe("a &lt; b & c < d");
  });
});

describe("parseSrt — malformed input", () => {
  it("returns no cues for garbage and empty input", () => {
    expect(parseSrt("")).toHaveLength(0);
    expect(parseSrt("not a subtitle file at all")).toHaveLength(0);
  });

  it("skips blocks with broken timestamps but keeps the good ones", () => {
    const srt = `1
99:99 --> nonsense
Bad block.

2
00:00:01,000 --> 00:00:02,000
Good block.
`;
    const cues = parseSrt(srt);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("Good block.");
  });
});

describe("groupIntoTurns", () => {
  it("groups consecutive same-speaker cues and splits on speaker change", () => {
    const cues = parseSrt(SRT);
    const turns = groupIntoTurns(cues);
    expect(turns).toHaveLength(2);
    expect(turns[0].speaker).toBe("SPEAKER_00");
    expect(turns[1].speaker).toBe("SPEAKER_01");
  });
});

describe("leading punctuation relocation", () => {
  // Whisper segments sometimes start with the period that closes the PREVIOUS
  // segment's sentence, surfacing as a stray ". " on the next cue / next speaker.
  const PUNCT_SRT = `1
00:00:00,000 --> 00:00:05,000
[SPEAKER_00]: how to build something

2
00:00:05,000 --> 00:00:10,000
[SPEAKER_00]: . And so it kind of just worked out

3
00:00:19,000 --> 00:00:25,000
[SPEAKER_01]: . I love everything Zach said`;

  it("moves a leading period onto the end of the previous cue", () => {
    const cues = parseSrt(PUNCT_SRT);
    expect(cues[0].text).toBe("how to build something.");
    // cue[1] loses its own leading ".", then gains cue[2]'s relocated "." —
    // both periods land on the word that ends each sentence.
    expect(cues[1].text).toBe("And so it kind of just worked out.");
  });
  it("fixes a period spilling across a speaker change", () => {
    const cues = parseSrt(PUNCT_SRT);
    expect(cues[2].speaker).toBe("SPEAKER_01");
    expect(cues[2].text).toBe("I love everything Zach said");
    expect(cues[1].text.endsWith(".")).toBe(true);
  });
  it("does not double punctuation when the previous cue already ends in it", () => {
    const cues = parseSrt(`1
00:00:00,000 --> 00:00:02,000
Already done.

2
00:00:02,000 --> 00:00:04,000
. Next part`);
    expect(cues[0].text).toBe("Already done.");
    expect(cues[1].text).toBe("Next part");
  });
  it("leaves a punctuation-only cue intact (no backtrack into the previous cue)", () => {
    // A standalone "..." or "?!" continuation cue must NOT be split: the greedy
    // run would otherwise donate all-but-one mark to the previous cue, and a
    // "?!" attributed to speaker B would bleed "?" onto speaker A.
    const cues = parseSrt(`1
00:00:00,000 --> 00:00:02,000
[SPEAKER_00]: so anyway

2
00:00:02,000 --> 00:00:04,000
[SPEAKER_00]: ...

3
00:00:04,000 --> 00:00:06,000
[SPEAKER_01]: ?!`);
    expect(cues[0].text).toBe("so anyway");
    expect(cues[1].text).toBe("...");
    expect(cues[2].text).toBe("?!");
    expect(cues[2].speaker).toBe("SPEAKER_01");
  });
});

describe("fmtTime", () => {
  it("formats h:mm:ss and m:ss", () => {
    expect(fmtTime(0)).toMatch(/0:00/);
    expect(fmtTime(75)).toMatch(/1:15/);
    expect(fmtTime(3723)).toMatch(/1:02:03/);
  });
});

describe("secondsToCueTc", () => {
  it("formats zero-padded SRT and VTT timestamps", () => {
    expect(secondsToCueTc(0)).toBe("00:00:00,000");
    expect(secondsToCueTc(3723.045)).toBe("01:02:03,045");
    expect(secondsToCueTc(3723.045, ".")).toBe("01:02:03.045");
  });
  it("carries millisecond rounding into the seconds field", () => {
    // Naive per-field math would emit an out-of-range ",1000" here.
    expect(secondsToCueTc(1.9996)).toBe("00:00:02,000");
  });
});

describe("serializeCues", () => {
  // The contract inline cue editing depends on: parseSrt(serializeCues(x))
  // must reproduce x, because every consumer (viewer, on-video captions,
  // exports, AI summary) re-parses the rewritten file.
  const cue = (over: Partial<Cue>): Cue => ({
    index: 1, start: 0, end: 1, text: "hello", speaker: null, ...over,
  });

  it("round-trips machine speaker tags through parseSrt", () => {
    const cues = parseSrt(SRT);
    cues[0] = { ...cues[0], text: "The greatest weapon of humankind, edited" };
    const reparsed = parseSrt(serializeCues(cues));
    expect(reparsed).toHaveLength(2);
    expect(reparsed[0].speaker).toBe("SPEAKER_00");
    expect(reparsed[0].text).toBe("The greatest weapon of humankind, edited");
    expect(reparsed[0].start).toBeCloseTo(0.19, 3);
    expect(reparsed[1].end).toBeCloseTo(19.91, 3);
    expect(reparsed[1].speaker).toBe("SPEAKER_01");
  });

  it("round-trips human speaker names — including ones NAME:-style prefixes would drop", () => {
    // "vic" is not name-shaped (lowercase), so a `vic:` prefix would silently
    // lose the speaker on re-parse; the voice-tag encoding keeps it.
    const cues = [
      cue({ start: 1, end: 2.5, text: "We are in New York City", speaker: "Roger Bingham" }),
      cue({ index: 2, start: 2.5, end: 4, text: "and it is loud", speaker: "vic" }),
    ];
    const reparsed = parseSrt(serializeCues(cues));
    expect(reparsed.map((c) => c.speaker)).toEqual(["Roger Bingham", "vic"]);
    expect(reparsed.map((c) => c.text)).toEqual(["We are in New York City", "and it is loud"]);
  });

  it("round-trips null speakers as plain text", () => {
    const reparsed = parseSrt(serializeCues([cue({ text: "no one speaking" })]));
    expect(reparsed[0].speaker).toBeNull();
    expect(reparsed[0].text).toBe("no one speaking");
  });

  it("writes a WEBVTT header and dot separators in vtt mode (still re-parses)", () => {
    const out = serializeCues([cue({ start: 61.5, end: 63 })], "vtt");
    expect(out.startsWith("WEBVTT\n\n")).toBe(true);
    expect(out).toContain("00:01:01.500 --> 00:01:03.000");
    const reparsed = parseSrt(out);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0].start).toBeCloseTo(61.5, 3);
  });

  it("skips empty-text cues and renumbers the survivors", () => {
    const out = serializeCues([
      cue({ text: "  " }),
      cue({ index: 2, start: 1, end: 2, text: "kept" }),
    ]);
    expect(out.startsWith("1\n")).toBe(true);
    const reparsed = parseSrt(out);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0].text).toBe("kept");
  });

  it("survives text with ampersands and stray angle brackets", () => {
    const reparsed = parseSrt(serializeCues([cue({ text: "salt & pepper, 1 < 2" })]));
    expect(reparsed[0].text).toBe("salt & pepper, 1 < 2");
  });

  it("collapses internal newlines/whitespace so a block never splits mid-cue", () => {
    const reparsed = parseSrt(serializeCues([cue({ text: "line one\n\nline two" })]));
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0].text).toBe("line one line two");
  });
});
