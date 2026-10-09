import { describe, expect, it } from "vitest";
import type { EditDocument } from "../bindings/EditDocument";
import { fromDocument } from "./edit-document";
import { ghostLines, placeWords, type TimelineWord } from "./edit-model";
import { CUT_BEAT_PAUSE_SECONDS, CUT_HEAD_SECONDS, CUT_TAIL_SECONDS, estimateCut, fillersIn, layoutStoryCut, type StoryLine } from "./edit-story";

const people = ["donny", "gilio", "aidan"];
const base = (): EditDocument => ({
  schema_version: 2, title: "Twins", edit_rate: { numerator: 24, denominator: 1 }, start_timecode_frames: 86400,
  sources: [{ id: "s1", name: "HEAT 1", document_id: "h1" }],
  tracks: people.map((id, n) => ({ id, name: id.toUpperCase(), kind: "sound" as const, source_tracks: { s1: String(10 + n) } })),
  segments: [], mutes: [], markers: [] });
let made = 0;
const word = (track: string, start: number, end: number, text: string, cue: string): TimelineWord => ({ id: `w${made++}`, source: "s1", track, text, start, end, cue });
/** A line as Ask cites it: its words, from first to last. */
const line = (said: TimelineWord[]): StoryLine => ({ source: "s1", track: said[0].track, from: said[0].start, to: said[said.length - 1].end,
  text: said.map((item) => item.text).join(" "), wordIds: said.map((item) => item.id) });

describe("a story cut, laid out", () => {
  // Donny sets up the bet at 10 s and pays it off at 200 s; Gilio answers at 15 s.
  const setup = [word("donny", 10, 10.5, "We", "d1"), word("donny", 10.6, 11.2, "bet", "d1"), word("donny", 11.3, 12, "dinner.", "d1")];
  const reply = [word("gilio", 13, 13.4, "You're", "g1"), word("gilio", 13.5, 14, "on.", "g1")];
  const payoff = [word("donny", 200, 200.5, "Pay", "d2"), word("donny", 200.6, 201, "up.", "d2")];
  const later = [word("gilio", 60, 61, "Whatever.", "g2")];
  const words = [...setup, ...reply, ...payoff, ...later];
  const cut = { title: "The bet", target: 10, beats: [
    { title: "The bet", lines: [line(setup), line(reply)] },
    { title: "Pay up", lines: [line(payoff), line(later)] },
  ] };

  it("butts lines within a beat, pauses between beats, and names each beat on its first marker", () => {
    const { document } = layoutStoryCut(base(), cut, { s1: 600 }, words);
    // The bet and its answer follow each other: one stretch. The payoff and Gilio's later line are apart: two, butted.
    expect(document.segments.map((segment) => segment.kind === "gap" ? ["gap", segment.frames] : ["clip", segment.in_frame, segment.out_frame, segment.tracks])).toEqual([
      ["clip", Math.floor((10 - CUT_HEAD_SECONDS) * 24), Math.ceil((14 + CUT_TAIL_SECONDS) * 24), ["donny", "gilio"]],
      ["gap", CUT_BEAT_PAUSE_SECONDS * 24],
      ["clip", Math.floor((200 - CUT_HEAD_SECONDS) * 24), Math.ceil((201 + CUT_TAIL_SECONDS) * 24), ["donny"]],
      ["clip", Math.floor((60 - CUT_HEAD_SECONDS) * 24), Math.ceil((61 + CUT_TAIL_SECONDS) * 24), ["gilio"]],
    ]);
    expect(document.markers.map((marker) => [marker.name, marker.comment])).toEqual([
      ["DONNY", "Beat 1 · The bet: We bet dinner."], ["GILIO", "You're on."], ["DONNY", "Beat 2 · Pay up: Pay up."], ["GILIO", "Whatever."]]);
    expect(document.title).toBe("The bet");
    // Patched from nothing, in the order people first speak.
    expect(document.tracks.filter((track) => track.featured !== false).map((track) => track.id)).toEqual(["donny", "gilio"]);
  });

  it("never joins two beats into one stretch, however close their lines sit in the source", () => {
    const { document } = layoutStoryCut(base(), { title: "x", target: null, beats: [{ title: "A", lines: [line(setup)] }, { title: "B", lines: [line(reply)] }] }, { s1: 600 }, words);
    expect(document.segments.map((segment) => segment.kind)).toEqual(["source", "gap", "source"]);
  });

  it("is focused on the people its markers name", () => {
    // Aidan talks over the bet on his own mic: he joins the clip as a listener, muted.
    const aside = word("aidan", 11, 11.4, "Ha!", "a1");
    const { document } = layoutStoryCut(base(), { title: "x", target: null, beats: [{ title: "A", lines: [line(setup)] }, { title: "B", lines: [line([word("aidan", 300, 301, "Later.", "a2")])] }] }, { s1: 600 }, [...words, aside]);
    expect(document.segments[0]).toMatchObject({ tracks: ["donny", "aidan"] });
    expect(document.mutes.map((mute) => mute.track)).toEqual(["aidan"]);
  });
});

describe("tightening a cut", () => {
  it("takes the fillers and a stammer's first word out of the lines it cites, and nothing else", () => {
    const said = [word("donny", 1, 1.3, "Um,", "c"), word("donny", 1.4, 1.6, "I", "c"), word("donny", 1.65, 1.8, "I", "c"), word("donny", 1.9, 2.3, "won,", "c"),
      word("donny", 2.4, 2.6, "go", "c"), word("donny", 2.65, 2.8, "go", "c"), word("donny", 2.9, 3.1, "uh", "c")];
    const elsewhere = word("gilio", 5, 5.2, "um", "g");
    const removed = fillersIn([...said, elsewhere], new Set(said.map((item) => item.id)));
    // "go go" is said on purpose; Gilio's um is not in a cited line.
    expect([...removed].map((id) => [...said, elsewhere].find((item) => item.id === id)!.text)).toEqual(["Um,", "I", "uh"]);
  });

  it("never treats the end of one line and the start of the next as a stammer", () => {
    const first = word("donny", 1, 1.2, "the", "c1"), second = word("donny", 1.3, 1.5, "the", "c2");
    expect(fillersIn([first, second], new Set([first.id, second.id])).size).toBe(0);
  });

  it("cuts a clean filler so it shows as a removed line, and leaves one someone talks under", () => {
    const said = [word("donny", 10, 10.5, "So", "d"), word("donny", 11, 11.4, "um", "d"), word("donny", 12, 12.5, "we", "d"), word("donny", 13, 13.4, "uh", "d"), word("donny", 14, 14.5, "won.", "d")];
    // Gilio talks over Donny's "uh"; he is in the clip because he has a line of his own later.
    const over = word("gilio", 13.1, 13.5, "Yeah", "g1");
    const all = [...said, over, word("gilio", 300, 301, "Later.", "g2")];
    const { document, trimmed } = layoutStoryCut(base(), { title: "x", target: null, beats: [{ title: "A", lines: [line(said)] }, { title: "B", lines: [line([all[all.length - 1]])] }] }, { s1: 600 }, all);
    expect(trimmed).toBe(1);
    const { timeline } = fromDocument(document);
    // Heard, not merely on the track: the "uh" under Gilio is neither cut nor muted.
    const playing = placeWords(all, timeline).filter((item) => item.word.track === "donny" && !item.muted).map((item) => item.word.text);
    expect(playing).toEqual(["So", "we", "uh", "won."]);
    expect(ghostLines(timeline, all).flatMap((ghost) => ghost.words.map((item) => item.text))).toContain("um");
  });
});

describe("a cut's running time before it is built", () => {
  it("adds stretches, handles and the pauses between beats that play", () => {
    const at = (from: number, to: number) => ({ source: "s1", from, to });
    const estimate = estimateCut([{ lines: [at(10, 12), at(13, 14)] }, { lines: [] }, { lines: [at(200, 201), at(60, 61)] }]);
    const handles = CUT_HEAD_SECONDS + CUT_TAIL_SECONDS;
    expect(estimate.beats).toEqual([4 + handles, 0, 2 + 2 * handles]);
    expect(estimate.seconds).toBeCloseTo(6 + 3 * handles + CUT_BEAT_PAUSE_SECONDS);
  });
});
