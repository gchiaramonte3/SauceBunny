// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSourceMarks, marksFor, setSourceMarks } from "./source-marks";

const KEY = "saucebunny.sourceMarks";
const SRC = "/Users/x/Movies/interview.mov";

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("source marks", () => {
  it("round-trips a range", () => {
    setSourceMarks(SRC, { inFrames: 250, outFrames: 500 });
    expect(marksFor(SRC)).toEqual({ inFrames: 250, outFrames: 500 });
  });

  it("keeps FRAMES, not seconds", () => {
    // Converting on the way in and out would round twice and could move a
    // mark by a frame across one save/load cycle.
    setSourceMarks(SRC, { inFrames: 251, outFrames: 499 });
    const raw = JSON.parse(localStorage.getItem(KEY)!);
    expect(Object.values(raw)[0]).toEqual({ inFrames: 251, outFrames: 499 });
  });

  it("does not confuse two sources", () => {
    setSourceMarks(SRC, { inFrames: 1, outFrames: 2 });
    setSourceMarks("/other.mov", { inFrames: 10, outFrames: 20 });
    expect(marksFor(SRC).inFrames).toBe(1);
    expect(marksFor("/other.mov").inFrames).toBe(10);
  });

  it("finds a path that arrived in a different Unicode form", () => {
    // A rename can change only the normalisation form; the timecode store
    // keys the same way for the same reason.
    const nfd = "/Users/x/Movies/Café.mov".normalize("NFD");
    const nfc = "/Users/x/Movies/Café.mov".normalize("NFC");
    setSourceMarks(nfd, { inFrames: 5, outFrames: 9 });
    expect(marksFor(nfc)).toEqual({ inFrames: 5, outFrames: 9 });
  });

  it("keeps a lone in mark, which is a real state", () => {
    setSourceMarks(SRC, { inFrames: 100, outFrames: null });
    expect(marksFor(SRC)).toEqual({ inFrames: 100, outFrames: null });
  });

  it("forgets the entry when both marks are cleared", () => {
    // Otherwise the map grows a row for every source whose marks were merely
    // cleared, and never shrinks.
    setSourceMarks(SRC, { inFrames: 1, outFrames: 2 });
    setSourceMarks(SRC, { inFrames: null, outFrames: null });
    expect(loadSourceMarks()).toEqual({});
  });

  it("has no marks for a source it has never seen", () => {
    expect(marksFor("/never-opened.mov")).toEqual({ inFrames: null, outFrames: null });
    expect(marksFor(null)).toEqual({ inFrames: null, outFrames: null });
  });

  it("drops a stored range that is inverted or zero-length", () => {
    // Hand-editable file. Restoring one of these would set marks the export
    // then refuses, with nothing on screen explaining why.
    localStorage.setItem(KEY, JSON.stringify({
      [SRC]: { inFrames: 500, outFrames: 250 },
      "/b.mov": { inFrames: 10, outFrames: 10 },
    }));
    expect(loadSourceMarks()).toEqual({});
  });

  it("drops junk without taking the rest of the map with it", () => {
    localStorage.setItem(KEY, JSON.stringify({
      [SRC]: { inFrames: 250, outFrames: 500 },
      "/bad3.mov": "nonsense",
      "/bad4.mov": { inFrames: null, outFrames: null },
    }));
    expect(loadSourceMarks()).toEqual({ [SRC]: { inFrames: 250, outFrames: 500 } });
  });

  it("keeps the good half of a half-corrupt entry", () => {
    // A negative or fractional frame index is not something this app wrote, so
    // it goes - but the OTHER mark in that entry is still a real thing someone
    // set, and an out-only mark is a state the transport supports. Dropping
    // the whole row would lose it to fix a neighbour.
    localStorage.setItem(KEY, JSON.stringify({
      "/a.mov": { inFrames: -5, outFrames: 10 },
      "/b.mov": { inFrames: 1.5, outFrames: 10 },
    }));
    expect(loadSourceMarks()).toEqual({
      "/a.mov": { inFrames: null, outFrames: 10 },
      "/b.mov": { inFrames: null, outFrames: 10 },
    });
  });

  it("survives a corrupt file entirely", () => {
    localStorage.setItem(KEY, "[not an object]");
    expect(loadSourceMarks()).toEqual({});
  });
});
