import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseChapters, sampleTranscriptEvenly, chaptersToYouTube, chapterTimestamp,
  loadChapters, saveChapters, adoptSourceChapters, hasCreatorChapters,
} from "./chapters";

describe("parseChapters", () => {
  it("parses strict MM:SS lines", () => {
    const out = parseChapters("00:00 Intro\n01:30 The demo\n12:05 Wrap-up", 900);
    expect(out).toEqual([
      { time: 0, title: "Intro" },
      { time: 90, title: "The demo" },
      { time: 725, title: "Wrap-up" },
    ]);
  });

  it("parses HH:MM:SS lines for long sources", () => {
    const out = parseChapters("0:00:00 Intro\n1:02:03 Deep dive", 7200);
    expect(out).toEqual([
      { time: 0, title: "Intro" },
      { time: 3723, title: "Deep dive" },
    ]);
  });

  it("tolerates bullets, numbering, brackets, and dash separators", () => {
    const raw = [
      "Here are the chapters:",       // preamble → dropped
      "- [00:00] - Intro",
      "2. (01:00) — Setup",
      "* 02:00: Results",
      "3) 03:00 · Q&A",
    ].join("\n");
    const out = parseChapters(raw, 600);
    expect(out.map((c) => c.time)).toEqual([0, 60, 120, 180]);
    expect(out.map((c) => c.title)).toEqual(["Intro", "Setup", "Results", "Q&A"]);
  });

  it("drops lines that don't parse (junk, missing title, bad clock fields)", () => {
    const raw = [
      "00:00 Intro",
      "```",                 // fence
      "no timestamp here",
      "01:75 Bad seconds",   // ss >= 60 in MM:SS
      "1:99:00 Bad minutes", // mm >= 60 in H:MM:SS
      "02:00",               // no title
      "03:00 Outro",
    ].join("\n");
    expect(parseChapters(raw, 600)).toEqual([
      { time: 0, title: "Intro" },
      { time: 180, title: "Outro" },
    ]);
  });

  it("accepts MM:SS with minutes over 59 (90:00 = 90 minutes)", () => {
    const out = parseChapters("00:00 Intro\n90:00 Late", 6000);
    expect(out[1].time).toBe(5400);
  });

  it("clamps timestamps past the duration into [0, duration)", () => {
    const out = parseChapters("00:00 Intro\n05:00 Mid\n99:00 Beyond", 400);
    expect(out).toEqual([
      { time: 0, title: "Intro" },
      { time: 300, title: "Mid" },
      { time: 399, title: "Beyond" },
    ]);
  });

  it("drops ascending-order violators instead of re-sorting", () => {
    const out = parseChapters("00:00 A\n02:00 B\n01:00 Backwards\n03:00 C", 600);
    expect(out.map((c) => c.title)).toEqual(["A", "B", "C"]);
  });

  it("drops a duplicate timestamp (strictly ascending)", () => {
    const out = parseChapters("00:00 A\n01:00 B\n01:00 B again\n02:00 C", 600);
    expect(out.map((c) => c.title)).toEqual(["A", "B", "C"]);
  });

  it("snaps the first chapter to 00:00 even when the model starts later", () => {
    const out = parseChapters("00:12 Cold open\n01:00 Topic", 600);
    expect(out[0]).toEqual({ time: 0, title: "Cold open" });
    expect(out[1].time).toBe(60);
  });

  it("strips leaked markdown emphasis and quotes from titles", () => {
    const out = parseChapters('00:00 **Intro**\n01:00 "The _real_ story"', 600);
    expect(out.map((c) => c.title)).toEqual(["Intro", "The real story"]);
  });

  it("returns [] on garbage (caller treats <2 as a failed run)", () => {
    expect(parseChapters("Sorry, I can't help with that.", 600)).toEqual([]);
  });

  it("works without a known duration (no clamping, still ordered + snapped)", () => {
    const out = parseChapters("00:05 A\n10:00 B", null);
    expect(out).toEqual([{ time: 0, title: "A" }, { time: 600, title: "B" }]);
  });
});

describe("sampleTranscriptEvenly", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `[${i}:00] line number ${i}`);

  it("returns everything verbatim when under budget", () => {
    const r = sampleTranscriptEvenly(lines, 1_000_000);
    expect(r.sampled).toBe(false);
    expect(r.text).toBe(lines.join("\n"));
  });

  it("samples across the WHOLE duration — first and last lines survive", () => {
    const r = sampleTranscriptEvenly(lines, 600);
    expect(r.sampled).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(600);
    const picked = r.text.split("\n");
    expect(picked[0]).toBe(lines[0]);
    expect(picked[picked.length - 1]).toBe(lines[lines.length - 1]);
    // Evenly spread, not a head-truncation: something from the middle made it.
    expect(picked.some((l) => /line number 4\d$/.test(l))).toBe(true);
  });

  it("degrades to first+last on a tiny budget", () => {
    const r = sampleTranscriptEvenly(lines, 10);
    expect(r.sampled).toBe(true);
    expect(r.text.split("\n").length).toBe(2);
  });
});

describe("chaptersToYouTube / chapterTimestamp", () => {
  it("formats MM:SS lines for sub-hour content", () => {
    const txt = chaptersToYouTube([
      { time: 0, title: "Intro" },
      { time: 725, title: "Wrap-up" },
    ]);
    expect(txt).toBe("00:00 Intro\n12:05 Wrap-up");
  });

  it("switches every line to H:MM:SS when any chapter passes the hour", () => {
    const txt = chaptersToYouTube([
      { time: 0, title: "Intro" },
      { time: 3723, title: "Late" },
    ]);
    expect(txt).toBe("0:00:00 Intro\n1:02:03 Late");
  });

  it("chapterTimestamp clamps negatives to zero", () => {
    expect(chapterTimestamp(-5, false)).toBe("00:00");
  });
});

describe("persistence round-trip", () => {
  // The helpers persist via localStorage; the node test env has none, so shim
  // a tiny Map-backed store before each test (mirrors review.test.ts).
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as Storage;
  });

  it("saves and reloads per source key, filtering corrupt entries", () => {
    const key = "test-src";
    saveChapters(key, [{ time: 0, title: "A" }, { time: 60, title: "B" }]);
    expect(loadChapters(key)).toEqual([{ time: 0, title: "A" }, { time: 60, title: "B" }]);
    // Corrupt blob → invalid rows dropped, no throw.
    localStorage.setItem("saucebunny.chapters." + key,
      JSON.stringify([{ time: 5, title: "ok" }, { time: "x", title: "bad" }, null, { time: 9, title: " " }]));
    expect(loadChapters(key)).toEqual([{ time: 5, title: "ok" }]);
    localStorage.removeItem("saucebunny.chapters." + key);
  });
});

/**
 * PROVENANCE, because "did you edit it" is a different question.
 *
 * The Regenerate confirm was gated on `editedRef` — "have you deleted a
 * chapter since the last generate". A list ADOPTED FROM THE CREATOR and never
 * touched has that flag false, so Regenerate replaced the publisher's own
 * chapter list with model output silently: the one case where what is already
 * there is more trustworthy than anything the app can make.
 */
describe("a chapter remembers where it came from", () => {
  beforeEach(() => localStorage.clear());

  it("marks adopted chapters as the creator's", () => {
    adoptSourceChapters("k", [{ time: 0, title: "Intro" }, { time: 60, title: "Part two" }]);
    const got = loadChapters("k");
    expect(got).toHaveLength(2);
    expect(got.every((c) => c.origin === "creator")).toBe(true);
    expect(hasCreatorChapters(got)).toBe(true);
  });

  it("says no for a hand-made or generated list", () => {
    // CANARY for the case above: a predicate that always returned true would
    // satisfy it while making every Regenerate ask the wrong question.
    saveChapters("k", [{ time: 0, title: "typed by hand" }]);
    expect(hasCreatorChapters(loadChapters("k"))).toBe(false);
    saveChapters("k2", [{ time: 0, title: "made up", origin: "generated" }]);
    expect(hasCreatorChapters(loadChapters("k2"))).toBe(false);
  });

  it("reads a list written before the field existed", () => {
    // Every chapter list already on disk. They must parse, and they must not
    // claim a provenance nobody recorded.
    localStorage.setItem("saucebunny.chapters.k", JSON.stringify([{ time: 0, title: "Old" }]));
    const got = loadChapters("k");
    expect(got).toHaveLength(1);
    expect(got[0].origin).toBeUndefined();
    expect(hasCreatorChapters(got), "unknown is not creator").toBe(false);
  });

  it("keeps refusing to adopt over a list that already exists", () => {
    // The pre-existing rule, re-checked because the map() now adds a field
    // and it would be easy to change what this returns by accident.
    saveChapters("k", [{ time: 0, title: "mine" }]);
    expect(adoptSourceChapters("k", [{ time: 5, title: "theirs" }])).toBe(false);
    expect(loadChapters("k")[0].title).toBe("mine");
  });
});

describe("the Regenerate confirm consults provenance", () => {
  it("asks hasCreatorChapters, not only editedRef", () => {
    // A wiring fact the unit tests above cannot see: they prove the predicate
    // is right, not that anything calls it. Deleting the call leaves both the
    // stamping and the predicate perfect and the warning gone - which is the
    // bug, exactly as it shipped.
    const src = readFileSync(
      join(__dirname, "..", "components", "AiChapters.tsx"), "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(src, "the confirm no longer asks where the chapters came from")
      .toMatch(/hasCreatorChapters\(chapters\)/);
    // And generated lists still say so, or the predicate has nothing to read.
    expect(src, "generated chapters are not stamped").toMatch(/origin: "generated"/);
  });
});
