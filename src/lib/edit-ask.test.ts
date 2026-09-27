import { describe, expect, it } from "vitest";
import type { EditDocument } from "../bindings/EditDocument";
import { askLines, askMentions, askRecords, mentionQuery, parseAskAnswer, scopeLines } from "./edit-ask";
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

  it("narrows to the people and sources a question mentions", () => {
    const lines = askLines(words, new Set());
    const mentions = askMentions(lanes, [{ id: "s2", name: "MG 1" }]);
    expect(mentions.map((m) => m.token)).toEqual(["@Rosa", "@DevPatel", "@MG1"]);
    expect(scopeLines(lines, "what does @devpatel say", mentions).map((line) => line.track)).toEqual(["dev"]);
    expect(scopeLines(lines, "anything", mentions)).toHaveLength(4);
    expect(mentionQuery("ask @Ro", 7)).toEqual({ start: 4, query: "ro" });
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
      { kind: "source", id: "bite-0", source: "s2", in_frame: 36, out_frame: 96 },
      { kind: "gap", id: "gap-1", frames: 24 },
      { kind: "source", id: "bite-1", source: "s1", in_frame: 0, out_frame: 36 },
    ]);
    expect(built.markers.map((m) => [m.frame, m.name])).toEqual([[0, "Rosa"], [84, "Rosa"]]);
  });
});
