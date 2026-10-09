import { describe, expect, it } from "vitest";
import type { EditDocument } from "../bindings/EditDocument";
import type { EditSegment } from "../bindings/EditSegment";
import type { TimelineWord } from "./edit-model";
import { clearOfWords, exchangesOf, stackConversations } from "./edit-exchanges";
import { layoutEditBites } from "./edit-stringout";

const base = (segments: EditSegment[] = [], markers: EditDocument["markers"] = []): EditDocument => ({
  schema_version: 2, title: "Twins", edit_rate: { numerator: 24, denominator: 1 }, start_timecode_frames: 86400,
  sources: [{ id: "s1", name: "HEAT 1", document_id: "h1" }],
  tracks: [{ id: "donny", name: "DONNY", kind: "sound", source_tracks: { s1: "14" } }, { id: "gilio", name: "GILIO", kind: "sound", source_tracks: { s1: "16" } },
    { id: "aidan", name: "AIDAN", kind: "sound", source_tracks: { s1: "11" } }],
  segments, mutes: [], markers });
let made = 0;
const word = (track: string, start: number, end: number, text: string, heardOn?: string): TimelineWord =>
  ({ id: `w${made++}`, source: "s1", track, text, start, end, ...(heardOn ? { heardOn } : {}) });
const line = (track: string, from: number, to: number, text = "line") => ({ source: "s1", track, from, to, text });

describe("exchanges", () => {
  it("joins stretches that run on from each other in one source, whoever speaks them", () => {
    const exchanges = exchangesOf([
      { source: "s1", lanes: ["donny"], from: 10, to: 14 },
      { source: "s1", lanes: ["gilio"], from: 14.5, to: 18 },              // the reply
      { source: "s1", lanes: ["donny"], from: 15, to: 16 },                // said over it
      { source: "s1", lanes: ["gilio"], from: 30, to: 32 },                // twelve seconds on: a new one
      { source: "s2", lanes: ["gilio"], from: 32.5, to: 33 },              // another source
      { source: "s2", lanes: ["donny"], from: 33.2, to: 34, alone: true }, // never joins
    ], 2);
    expect(exchanges.map((x) => [x.source, x.from, x.to, x.lanes, x.members])).toEqual([
      ["s1", 10, 18, ["donny", "gilio"], [0, 1, 2]], ["s1", 30, 32, ["gilio"], [3]], ["s2", 32.5, 33, ["gilio"], [4]], ["s2", 33.2, 34, ["donny"], [5]]]);
  });

  it("moves edges out of words, by a second and a half at most", () => {
    expect(clearOfWords(5, 9, [word("donny", 4, 5.5, "so"), word("gilio", 8.5, 12, "nooo")])).toEqual([4, 10.5]);
    expect(clearOfWords(5, 9, [word("donny", 5, 6, "on"), word("gilio", 8, 9, "the edge")])).toEqual([5, 9]);
  });
});

describe("Ask's string out, bundled", () => {
  it("plays a back-and-forth as one clip with both mics open, a marker on each line and filler only between exchanges", () => {
    const built = layoutEditBites(base(), [line("donny", 10, 14, "We'll see."), line("gilio", 14.6, 18, "Nah."), line("donny", 40, 42, "Later.")],
      "Twins", { s1: 100 }, [word("donny", 10, 10.4, "We'll"), word("gilio", 14.6, 15, "Nah")]);
    expect(built.segments).toEqual([
      { kind: "source", id: "bite-0", source: "s1", in_frame: 228, out_frame: 456, tracks: ["donny", "gilio"] },
      { kind: "gap", id: "gap-2", frames: 24 },
      { kind: "source", id: "bite-2", source: "s1", in_frame: 948, out_frame: 1032, tracks: ["donny"] },
    ]);
    // Gilio's marker sits where his own handle would have started him, inside the exchange.
    expect(built.markers.map((m) => [m.frame, m.name, m.comment])).toEqual([[0, "DONNY", "We'll see."], [110, "GILIO", "Nah."], [252, "DONNY", "Later."]]);
    expect(built.tracks.filter((track) => track.featured !== false).map((track) => track.id)).toEqual(["donny", "gilio"]);
  });

  it("opens a listener's mic when they react into it, not when it only carries the speaker or someone outside the cut", () => {
    const lines = [line("donny", 10, 14), line("gilio", 30, 33)];
    const laugh = [word("donny", 11, 11.4, "made"), word("gilio", 11.1, 11.5, "made"), word("gilio", 12, 12.3, "Ha!"), word("aidan", 12.5, 13, "Yo")];
    expect(layoutEditBites(base(), lines, "x", { s1: 100 }, laugh).segments[0]).toMatchObject({ tracks: ["donny", "gilio"] });
    // Donny heard on Gilio's mic, and a word the bleed resolver says is someone else's: Gilio stays closed.
    const echo = [word("donny", 11, 11.4, "made"), word("gilio", 11.1, 11.5, "Made."), word("gilio", 12, 12.3, "this", "14")];
    expect(layoutEditBites(base(), lines, "x", { s1: 100 }, echo).segments[0]).toMatchObject({ tracks: ["donny"] });
  });

  it("ends an exchange after a word on an open mic rather than inside it", () => {
    // Gilio is mid-word when Donny's tail handle runs out at 15 s.
    const words = [word("donny", 10, 14, "long"), word("gilio", 13, 13.3, "wait"), word("gilio", 14.8, 15.6, "seriously")];
    const built = layoutEditBites(base(), [line("donny", 10, 14), line("gilio", 60, 61)], "x", { s1: 100 }, words);
    expect(built.segments[0]).toMatchObject({ in_frame: 228, out_frame: 375, tracks: ["donny", "gilio"] });
  });
});

describe("stacking an existing string out", () => {
  const clip = (id: string, track: string, inFrame: number, outFrame: number, extra: Partial<Extract<EditSegment, { kind: "source" }>> = {}): EditSegment =>
    ({ kind: "source", id, source: "s1", in_frame: inFrame, out_frame: outFrame, tracks: [track], ...extra });
  const gap = (id: string): EditSegment => ({ kind: "gap", id, frames: 24 });
  const marker = (id: string, frame: number, track: string) => ({ id, frame, track, name: track.toUpperCase(), comment: id, color: "cyan" });
  // As Ask laid it out: Donny, Gilio straight on, Donny again, then Gilio's interjection REPLAYED after the line
  // it interrupted, each alone on its own track with a second of filler between; then a lifted clip and a lone one.
  const twins = () => base([
    clip("a", "donny", 240, 336), gap("g1"), clip("b", "gilio", 336, 432), gap("g2"), clip("c", "donny", 432, 456, { layers: { donny: 1 } }), gap("g3"),
    clip("d", "gilio", 420, 444), gap("g4"), clip("e", "donny", 2400, 2496, { overrides: { donny: { source: null, in_frame: 0 } } }), gap("g5"),
    clip("f", "gilio", 4800, 4896),
  ], [marker("m-a", 0, "donny"), marker("m-b", 120, "gilio"), marker("m-d", 288, "gilio"), marker("m-e", 336, "donny")]);

  it("makes each back-and-forth one clip with both people on their own tracks, and keeps everything else as it was", () => {
    const { document, stacked } = stackConversations(twins(), [], { s1: 1000 }, 2);
    expect(stacked).toBe(1);
    expect(document.segments).toEqual([
      // No frame of the interjection plays twice, and no filler sits inside the conversation.
      { kind: "source", id: "a", source: "s1", in_frame: 240, out_frame: 456, tracks: ["donny", "gilio"], layers: { donny: 1 } },
      gap("g4"),
      clip("e", "donny", 2400, 2496, { overrides: { donny: { source: null, in_frame: 0 } } }),
      gap("g5"),
      clip("f", "gilio", 4800, 4896),
    ]);
    // Markers stay on the source frame they marked.
    expect(document.markers.map((m) => [m.id, m.frame])).toEqual([["m-a", 0], ["m-b", 96], ["m-d", 180], ["m-e", 240]]);
  });

  it("opens a listener on a lone clip, and leaves a string out with nothing to stack untouched", () => {
    const lone = base([clip("a", "donny", 240, 336), gap("g1"), clip("f", "gilio", 4800, 4896)]);
    const { document, stacked } = stackConversations(lone, [word("gilio", 11, 11.4, "Ha!")], { s1: 1000 }, 2);
    expect(stacked).toBe(1);
    expect(document.segments[0]).toMatchObject({ id: "a", tracks: ["donny", "gilio"] });
    const quiet = stackConversations(lone, [], { s1: 1000 }, 2);
    expect(quiet.stacked).toBe(0);
    expect(quiet.document).toBe(lone);
  });
});
