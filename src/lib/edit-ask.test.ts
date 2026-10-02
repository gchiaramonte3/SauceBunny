import { describe, expect, it } from "vitest";
import type { EditDocument } from "../bindings/EditDocument";
import { askLines, askMentions, askRecords, mentionQuery, parseAskAnswer, scopeLines, askFindPrompt, askParts, parseAskFind, askBuildTitle, asksToBuild } from "./edit-ask";
import type { TimelineWord } from "./edit-model";
import { layoutEditBites } from "./edit-stringout";

const word = (id: string, track: string, start: number, source = "s1"): TimelineWord => ({ id, source, track, text: id, start, end: start + 0.4 });
const words = [word("so", "rosa", 1), word("I", "rosa", 1.5), word("yeah", "dev", 1.6), word("later", "rosa", 5), word("hi", "sam", 2, "s2")];
const lanes = [{ id: "rosa", name: "Rosa", track: 1 }, { id: "dev", name: "Dev Patel", track: 2 }];

describe("Ask in String Outs", () => {
  it("reads the transcript as numbered lines per person, split on pauses and sources", () => {
    const lines = askLines(words, new Set(["later"]));
    expect(lines.map((line) => [line.id, line.source, line.track, line.words.map((w) => w.id).join(" "), line.inEdit])).toEqual([
      [0, "s1", "rosa", "so I", false], [1, "s1", "dev", "yeah", false], [2, "s1", "rosa", "later", true], [3, "s2", "sam", "hi", false],
    ]);
    expect(JSON.parse(askRecords(lines, (t) => t, (s) => s)[2])).toMatchObject({ id: 2, who: "rosa", inEdit: true, text: "later" });
  });

  it("ends a line where a transcript cue ends, even with no pause, so a line is a sentence", () => {
    const cued = [{ ...word("I", "rosa", 1), cue: "c1" }, { ...word("was", "rosa", 1.5), cue: "c1" }, { ...word("Then", "rosa", 2), cue: "c2" }, { ...word("we", "rosa", 2.5), cue: "c2" }];
    expect(askLines(cued, new Set()).map((line) => line.words.map((w) => w.id).join(" "))).toEqual(["I was", "Then we"]);
    // Canary: the same words without cues run on, the old behaviour this replaces.
    expect(askLines(cued.map(({ cue: _cue, ...rest }) => rest), new Set())).toHaveLength(1);
  });

  it("keeps each record short: source only when there are several, inEdit only when true, at in source timecode", () => {
    const one = askLines(words.filter((w) => w.source === "s1"), new Set(["later"]));
    const records = askRecords(one, (t) => t, (s) => s, (source, seconds) => `${source}@${seconds}`).map((record) => JSON.parse(record));
    expect(records[0]).toEqual({ id: 0, who: "rosa", at: "s1@1", text: "so I" });
    expect(records[2]).toEqual({ id: 2, who: "rosa", at: "s1@5", inEdit: true, text: "later" });
    const both = askRecords(askLines(words, new Set()), (t) => t, (s) => `Scene ${s}`).map((record) => JSON.parse(record));
    expect(both.every((record) => typeof record.source === "string")).toBe(true);
  });

  it("narrows to the people and sources a question mentions", () => {
    const lines = askLines(words, new Set());
    const mentions = askMentions(lanes, [{ id: "s2", name: "MG 1" }]);
    expect(mentions.map((m) => m.token)).toEqual(["@Rosa", "@DevPatel", "@MG1"]);
    expect(scopeLines(lines, "what does @devpatel say", mentions).map((line) => line.track)).toEqual(["dev"]);
    expect(scopeLines(lines, "anything", mentions)).toHaveLength(4);
    expect(mentionQuery("ask @Ro", 7)).toEqual({ start: 4, query: "ro" });
  });

  it("finds a person from the start of their name, but not when it could be two people", () => {
    const lines = askLines(words, new Set());
    const mentions = askMentions([...lanes, { id: "devon", name: "Devon", track: 3 }], []);
    // @Dev begins both Dev Patel and Devon, so it narrows to nobody rather than guessing.
    expect(scopeLines(lines, "what does @Dev say", mentions)).toHaveLength(4);
    expect(scopeLines(lines, "what does @DevP say", mentions).map((line) => line.track)).toEqual(["dev"]);
    expect(scopeLines(lines, "@ros everything", mentions).map((line) => line.track)).toEqual(["rosa", "rosa"]);
  });

  it("lets the model say all or same instead of listing every line twice", () => {
    // Everything one person says: a local model's 1,200-token answer used to cut
    // the list short, and a truncated reply has no action to apply.
    expect(parseAskAnswer('{"answer":"All of Rosa.","lines":"all","action":{"kind":"build","title":"Rosa","lines":"same"}}', 3))
      .toEqual({ text: "All of Rosa.", lines: [0, 1, 2], action: { kind: "build", title: "Rosa", lines: [0, 1, 2] } });
    expect(parseAskAnswer('{"answer":"Two.","lines":[2,0],"action":{"kind":"build","title":"Two"}}', 3).action)
      .toEqual({ kind: "build", title: "Two", lines: [2, 0] });
    expect(parseAskAnswer('{"answer":"x","lines":[1],"action":{"kind":"build","title":"All","lines":"all"}}', 3).action?.lines).toEqual([0, 1, 2]);
    // "same" never makes a remove: removing needs lines named on purpose.
    expect(parseAskAnswer('{"answer":"x","lines":[1],"action":{"kind":"remove","lines":"same"}}', 3).action).toBeNull();
  });

  it("keeps real ids only, and shows a reply that slipped its format as a plain answer", () => {
    expect(parseAskAnswer('```json\n{"answer":"Two lines.","lines":[0,9,0],"action":{"kind":"build","title":"Rosa moves","lines":[2,0]}}\n```', 4))
      .toEqual({ text: "Two lines.", lines: [0], action: { kind: "build", title: "Rosa moves", lines: [2, 0] } });
    expect(parseAskAnswer('{"answer":"ok","lines":[1],"action":{"kind":"remove","lines":[7]}}', 4)).toEqual({ text: "ok", lines: [1], action: null });
    expect(parseAskAnswer("Rosa says it twice.", 4)).toEqual({ text: "Rosa says it twice.", lines: [], action: null });
  });

  it("builds a new string out across sources in the old one's frame", () => {
    const base: EditDocument = { schema_version: 1, title: "First", edit_rate: { numerator: 24, denominator: 1 }, start_timecode_frames: 86400,
      sources: [{ id: "s1", name: "A", document_id: "a" }, { id: "s2", name: "B", document_id: "b" }],
      tracks: [{ id: "rosa", name: "Rosa", kind: "sound", source_tracks: { s1: "1" } }], segments: [], mutes: [{ source: "s1", track: "rosa", in_frame: 0, out_frame: 5 }], markers: [] };
    const built = layoutEditBites(base, [{ source: "s2", track: "rosa", from: 2, to: 3, text: "hi" }, { source: "s1", track: "rosa", from: 0.2, to: 1, text: "so" }], "Ask pull", { s1: 1.5, s2: 10 });
    expect(built.title).toBe("Ask pull");
    expect(built.sources).toBe(base.sources);
    expect(built.mutes).toEqual([]);
    expect(built.segments).toEqual([
      { kind: "source", id: "bite-0", source: "s2", in_frame: 36, out_frame: 96, tracks: ["rosa"] },
      { kind: "gap", id: "gap-1", frames: 24 },
      { kind: "source", id: "bite-1", source: "s1", in_frame: 0, out_frame: 36, tracks: ["rosa"] },
    ]);
    expect(built.tracks.map((track) => track.featured)).toEqual([true]);
    expect(built.markers.map((m) => [m.frame, m.name])).toEqual([[0, "Rosa"], [84, "Rosa"]]);
  });
});

describe("reading a long transcript in parts", () => {
  it("splits records into parts that fit, keeping every record once and in order", () => {
    const records = ["a".repeat(40), "b".repeat(40), "c".repeat(40), "d".repeat(90), "e"];
    expect(askParts(records, 100)).toEqual([[0, 1], [2], [3, 4]]);
    // A record bigger than a part still gets a part of its own rather than being dropped.
    expect(askParts(["x".repeat(500)], 100)).toEqual([[0]]);
  });

  it("reads which lines a part named, and nothing from a reply that is not the JSON asked for", () => {
    expect(parseAskFind('Sure: {"lines":[2,0,2,9]}', 3)).toEqual([2, 0]);
    expect(parseAskFind("I found the tired lines", 3)).toEqual([]);
    expect(parseAskFind('{"lines":"all"}', 2)).toEqual([0, 1]);
    expect(askFindPrompt("everything tired")).toContain('"everything tired"');
  });
});

describe("a build the model forgot to propose", () => {
  it("knows a request to build, and names it after the people mentioned", () => {
    expect(asksToBuild("find every line where @ISABELLA says she is tired and build a string out of those lines")).toBe(true);
    expect(asksToBuild("make a sequence of Rosa's bites")).toBe(true);
    expect(asksToBuild("who is tired?")).toBe(false);
    // Tokens as askMentions makes them, WITH their @: a fixture that left the @
    // off hid a title that searched for "@@ISABELLA" and so never named anyone.
    const mentions = askMentions([{ id: "isabella", name: "ISABELLA", track: 1 }, { id: "nat", name: "NATHANIEL", track: 2 }, { id: "rosa", name: "Rosa", track: 3 }], []);
    expect(mentions[0].token).toBe("@ISABELLA");
    expect(askBuildTitle("when @ISABELLA or @nathaniel say hard", mentions)).toBe("ISABELLA and NATHANIEL, from Ask");
    // A person found from the start of their name counts, as it does when reading.
    expect(askBuildTitle("everything @isa says tired", mentions)).toBe("ISABELLA, from Ask");
    expect(askBuildTitle("everything tired", mentions)).toBe("From Ask");
  });
});
