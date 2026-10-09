import { describe, expect, it } from "vitest";
import type { EditDocument } from "../bindings/EditDocument";
import { addressOfCitation, addressOfWord, asksForCut, citeAddress, lineAddress, parseToolsAnswer, resolveProposal, toolsHistory } from "./edit-ask-tools";
import type { AskMessage } from "./edit-ask";
import type { TimelineWord } from "./edit-model";

const document: EditDocument = { schema_version: 1, title: "T", edit_rate: { numerator: 24, denominator: 1 }, start_timecode_frames: 0,
  sources: [{ id: "s1", name: "Kitchen", document_id: "doc" }], tracks: [{ id: "rosa", name: "Rosa", kind: "sound", source_tracks: { s1: "track 1" } }],
  segments: [], mutes: [], markers: [] };
const word = (cue: string, index: number, start: number): TimelineWord => ({ id: `s1:rosa:${cue}:${index}`, source: "s1", track: "rosa", cue, text: `w${index}`, start, end: start + 0.3 });

describe("Ask on tools", () => {
  it("spells an address exactly as the Rust context layer does (src-tauri/src/context/address.rs)", () => {
    // The same three cases are pinned in address.rs, so the two sides cannot drift.
    expect(lineAddress("ab", "track-3", "c 12")).toBe("saucebunny://sequence/ab/line/track-3/c%2012");
    expect(lineAddress("ab", "t", "é:1")).toBe("saucebunny://sequence/ab/line/t/%C3%A9:1");
    expect(lineAddress("ab", "a/b", "x")).toBe("saucebunny://sequence/ab/line/a%2Fb/x");
  });

  it("turns a cited address back into the words it names here, and anything else into nothing", () => {
    const words = [word("c:1", 0, 1), word("c:1", 1, 1.4), word("c2", 0, 5)];
    const cited = citeAddress("saucebunny://sequence/doc/line/track%201/c:1", document, words);
    expect(cited).toMatchObject({ source: "s1", track: "rosa", from: 1, text: "w0 w1", wordIds: ["s1:rosa:c:1:0", "s1:rosa:c:1:1"] });
    expect(addressOfWord(words[0], document)).toBe("saucebunny://sequence/doc/line/track%201/c:1");
    expect(addressOfCitation(cited!, document)).toBe("saucebunny://sequence/doc/line/track%201/c:1");
    expect(citeAddress("saucebunny://sequence/other/line/track%201/c:1", document, words)).toBeNull();
    expect(citeAddress("not an address", document, words)).toBeNull();
  });

  it("reads the answer, keeps only addresses, and shows a reply that is not JSON as words", () => {
    const parsed = parseToolsAnswer('Here: {"answer":"Found two.","lines":["saucebunny://sequence/a/line/1/c","12",3],"action":{"kind":"build","title":"Bites","lines":"same"}}');
    expect(parsed.lines).toEqual(["saucebunny://sequence/a/line/1/c"]);
    expect(parsed.action).toEqual({ kind: "build", title: "Bites", lines: ["saucebunny://sequence/a/line/1/c"] });
    expect(parseToolsAnswer("Nothing like that is said.")).toEqual({ text: "Nothing like that is said.", lines: [], action: null });
  });

  it("replays earlier answers with their lines as addresses", () => {
    const history = toolsHistory([{ id: "1", role: "you", text: "who moved?", lines: [], action: null },
      { id: "2", role: "ask", text: "Rosa.", lines: [{ source: "s1", track: "rosa", from: 1, to: 2, text: "w0", wordIds: ["s1:rosa:c2:0"] }], action: null }], document);
    expect(history).toEqual([{ role: "user", content: "who moved?" }, { role: "assistant", content: JSON.stringify({ answer: "Rosa.", lines: ["saucebunny://sequence/doc/line/track%201/c2"] }) }]);
  });

  describe("a story cut", () => {
    const a = "saucebunny://sequence/doc/line/track%201/c1", b = "saucebunny://sequence/doc/line/track%201/c2";

    it("reads beats with their lines by address, a line in one place only, and drops what names nothing", () => {
      const parsed = parseToolsAnswer(JSON.stringify({ answer: "Two beats.", lines: [], action: { kind: "cut", title: "The bet", target_seconds: 300, beats: [
        { title: "Setup", purpose: "The bet is made.", lines: [a, "L123", 7] },
        { title: "Again", lines: [a] },
        { title: "", lines: [b] },
      ] } }));
      expect(parsed.action).toEqual({ kind: "cut", title: "The bet", target: 300, beats: [
        { title: "Setup", purpose: "The bet is made.", lines: [a] }, { title: "Beat 3", purpose: "", lines: [b] }] });
      // No beat with a line is no proposal, and a nonsense target is no target.
      expect(parseToolsAnswer(JSON.stringify({ answer: "x", lines: [], action: { kind: "cut", title: "x", beats: [{ title: "A", lines: ["L1"] }] } })).action).toBeNull();
      expect(parseToolsAnswer(JSON.stringify({ answer: "x", lines: [], action: { kind: "cut", title: "x", target_seconds: -5, beats: [{ title: "A", lines: [a] }] } })).action)
        .toMatchObject({ target: null });
    });

    it("resolves each beat's lines here, and a beat whose lines are all elsewhere goes", () => {
      const words = [word("c1", 0, 1), word("c1", 1, 1.4)];
      const resolved = resolveProposal({ kind: "cut", title: "x", target: null, beats: [{ title: "A", purpose: "", lines: [a] }, { title: "B", purpose: "", lines: [b] }] },
        (address) => citeAddress(address, document, words));
      expect(resolved).toMatchObject({ kind: "cut", beats: [{ title: "A", lines: [{ text: "w0 w1" }] }] });
      expect(resolveProposal({ kind: "build", title: "x", lines: [b] }, (address) => citeAddress(address, document, words))).toBeNull();
    });

    it("is replayed whole, so a note on it revises that cut", () => {
      const cut: AskMessage = { id: "2", role: "ask", text: "A cut.", lines: [], action: { kind: "cut", title: "The bet", target: 60, beats: [
        { title: "Setup", purpose: "p", lines: [{ source: "s1", track: "rosa", from: 0, to: 1, text: "w0", wordIds: ["s1:rosa:c1:0"] }] }] } };
      const replayed = JSON.parse(toolsHistory([cut], document)[0].content);
      expect(replayed.action).toEqual({ kind: "cut", title: "The bet", target_seconds: 60, beats: [{ title: "Setup", purpose: "p", lines: [a] }] });
      // A note on it is a cut request; so is asking for one; a question is not.
      expect(asksForCut("make it shorter, open on Donny", [cut])).toBe(true);
      expect(asksForCut("a 5 minute story of the twins' rivalry", [])).toBe(true);
      expect(asksForCut("who talks about the bet?", [])).toBe(false);
    });
  });
});
