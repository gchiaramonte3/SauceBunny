import { describe, expect, it } from "vitest";
import {
  newScreening, openSegment, openSegmentOf,
  noteComment, unnoteComment, markWatched, noteParticipants, closeScreening,
  screeningIsWorthKeeping, screeningCommentCount,
} from "./screening";
import type { SessionSource } from "../hooks/use-co-review";

const web = (url: string, title: string): SessionSource => ({
  kind: "web", url, fingerprint: null, title, duration: 120, reviewKey: url,
});
const file = (fp: string, title: string): SessionSource => ({
  kind: "file", url: null, fingerprint: fp, title, duration: 60, reviewKey: fp,
});

describe("segments follow the room's source", () => {
  it("opening a second source closes the first, keeping its comments", () => {
    // The whole point: a session that watched two things remembers BOTH,
    // with each one's notes attached to it rather than merged or lost.
    let d = newScreening("s1", "Friday review", "host", 1000);
    d = openSegment(d, web("https://a", "Cut A"), "keyA", 1000);
    d = noteComment(d, "c1");
    d = openSegment(d, web("https://b", "Cut B"), "keyB", 2000);
    d = noteComment(d, "c2");

    expect(d.segments).toHaveLength(2);
    expect(d.segments[0].title).toBe("Cut A");
    expect(d.segments[0].commentIds).toEqual(["c1"]);
    expect(d.segments[0].endedAt, "the first segment is closed").toBe(2000);
    expect(d.segments[1].commentIds).toEqual(["c2"]);
    expect(openSegmentOf(d)?.title).toBe("Cut B");
  });

  it("re-announcing the same source does not start a duplicate segment", () => {
    // The host re-broadcasts the source on every join, so this fires often.
    let d = newScreening("s1", "R", "host", 0);
    d = openSegment(d, web("https://a", "Cut A"), "keyA", 100);
    d = openSegment(d, web("https://a", "Cut A"), "keyA", 200);
    expect(d.segments).toHaveLength(1);
  });

  it("distinguishes a file from a web source with the same title", () => {
    let d = newScreening("s1", "R", "host", 0);
    d = openSegment(d, web("https://a", "Same Name"), "k1", 100);
    d = openSegment(d, file("fp-1", "Same Name"), "k2", 200);
    expect(d.segments).toHaveLength(2);
    expect(d.segments[1].kind).toBe("file");
  });

  it("clearing the source closes the open segment without opening another", () => {
    let d = newScreening("s1", "R", "host", 0);
    d = openSegment(d, web("https://a", "Cut A"), "keyA", 100);
    d = openSegment(d, { kind: "none", url: null, fingerprint: null, title: null, duration: null, reviewKey: "" }, null, 300);
    expect(d.segments).toHaveLength(1);
    expect(openSegmentOf(d)).toBeNull();
    expect(d.segments[0].endedAt).toBe(300);
  });

  it("closing is idempotent", () => {
    let d = newScreening("s1", "R", "host", 0);
    d = openSegment(d, web("https://a", "A"), "k", 100);
    d = closeScreening(d, 200);
    const once = JSON.stringify(d);
    d = closeScreening(d, 999);
    expect(JSON.stringify(d)).toBe(once);
  });
});

describe("comment bookkeeping", () => {
  it("ignores a replayed comment id", () => {
    let d = newScreening("s1", "R", "host", 0);
    d = openSegment(d, web("https://a", "A"), "k", 100);
    d = noteComment(d, "c1");
    d = noteComment(d, "c1");
    expect(d.segments[0].commentIds).toEqual(["c1"]);
  });

  it("a deleted comment stops counting, in whichever segment held it", () => {
    let d = newScreening("s1", "R", "host", 0);
    d = openSegment(d, web("https://a", "A"), "k", 100);
    d = noteComment(d, "c1");
    d = openSegment(d, web("https://b", "B"), "k2", 200);
    d = noteComment(d, "c2");
    expect(screeningCommentCount(d)).toBe(2);
    d = unnoteComment(d, "c1"); // lives in the CLOSED first segment
    expect(screeningCommentCount(d)).toBe(1);
    expect(d.segments[0].commentIds).toEqual([]);
  });
});

describe("markWatched", () => {
  it("upgrades a segment we could not open at first", () => {
    // A guest without the file lists the segment as unwatched, then finds
    // their own copy: the record should reflect that they did watch it.
    let d = newScreening("s1", "R", "guest", 0);
    d = openSegment(d, file("fp-1", "Reel"), null, 100);
    expect(d.segments[0].watched).toBe(false);
    d = markWatched(d, "/Users/me/Reel.mov");
    expect(d.segments[0].watched).toBe(true);
    expect(d.segments[0].localSourceKey).toBe("/Users/me/Reel.mov");
  });
});

describe("screeningIsWorthKeeping", () => {
  it("discards a solo session that watched nothing", () => {
    expect(screeningIsWorthKeeping(newScreening("s", "R", "host", 0))).toBe(false);
  });

  it("keeps a session that watched something", () => {
    let d = newScreening("s", "R", "host", 0);
    d = openSegment(d, web("https://a", "A"), "k", 100);
    expect(screeningIsWorthKeeping(d)).toBe(true);
  });

  it("keeps a session where someone else showed up, even with no source", () => {
    let d = newScreening("s", "R", "host", 0);
    d = noteParticipants(d, [{ name: "Me", isHost: true }, { name: "Gasper", isHost: false }], 10);
    expect(screeningIsWorthKeeping(d)).toBe(true);
  });
});

/**
 * `participants` was declared on ScreeningDoc, written into index.json, and
 * rendered by the shelf - and the only assignment anywhere in the tree was a
 * test mutating the doc directly. Every screening in every library reads
 * "0 people", and screeningIsWorthKeeping's `participants.length > 1` clause
 * was unreachable, so a session where two people turned up and watched nothing
 * was thrown away as empty.
 */
describe("who was in the room", () => {
  it("admits arrivals and stamps departures", () => {
    let d = newScreening("s", "R", "host", 0);
    d = noteParticipants(d, [{ name: "Ada", isHost: true }], 100);
    d = noteParticipants(d, [{ name: "Ada", isHost: true }, { name: "Lin", isHost: false }], 200);
    expect(d.participants.map((p) => p.name)).toEqual(["Ada", "Lin"]);
    expect(d.participants[1].joinedAt, "Lin joined at 200, not at session start").toBe(200);

    d = noteParticipants(d, [{ name: "Ada", isHost: true }], 300);
    expect(d.participants[1].leftAt).toBe(300);
    expect(d.participants[0].leftAt, "Ada is still here").toBe(0);
  });

  it("returns the same object when the roster has not moved", () => {
    // The host re-broadcasts the roster on every join and every reconnect, and
    // the caller writes to disk on change. Without identity here that is a
    // multi-KB file write per broadcast.
    let d = newScreening("s", "R", "host", 0);
    d = noteParticipants(d, [{ name: "Ada", isHost: true }], 100);
    expect(noteParticipants(d, [{ name: "Ada", isHost: true }], 200)).toBe(d);
  });

  it("a reconnect reopens the row rather than filing a second one", () => {
    // Member ids are RECLAIMED on rejoin (the epoch bumps), so a peer
    // flickering off and back is ordinary rather than exceptional.
    let d = newScreening("s", "R", "host", 0);
    d = noteParticipants(d, [{ name: "Ada", isHost: true }, { name: "Lin", isHost: false }], 100);
    d = noteParticipants(d, [{ name: "Ada", isHost: true }], 200);
    d = noteParticipants(d, [{ name: "Ada", isHost: true }, { name: "Lin", isHost: false }], 300);
    expect(d.participants).toHaveLength(2);
    expect(d.participants[1].leftAt, "back in the room").toBe(0);
    expect(d.participants[1].joinedAt, "still the original arrival").toBe(100);
  });

  it("ending the screening stamps everyone still present", () => {
    // Without this half, every participant of every saved screening reads as
    // never having left - leftAt 0 forever.
    let d = newScreening("s", "R", "host", 0);
    d = noteParticipants(d, [{ name: "Ada", isHost: true }, { name: "Lin", isHost: false }], 100);
    d = openSegment(d, web("https://a", "A"), "k", 100);
    d = closeScreening(d, 900);
    expect(d.participants.every((p) => p.leftAt === 900)).toBe(true);
    expect(d.segments[0].endedAt, "and closes the running segment").toBe(900);
  });

  it("keeps a two-person session that watched nothing", () => {
    // The clause that was unreachable. This is a real memory: people met.
    let d = newScreening("s", "R", "host", 0);
    d = noteParticipants(d, [{ name: "Ada", isHost: true }, { name: "Lin", isHost: false }], 100);
    expect(screeningIsWorthKeeping(d)).toBe(true);
  });

  it("still discards a solo session that watched nothing", () => {
    // CANARY for the case above: if noteParticipants ever invented a row, or
    // screeningIsWorthKeeping started returning true unconditionally, that
    // test would keep passing while the library filled with empty screenings.
    let d = newScreening("s", "R", "host", 0);
    d = noteParticipants(d, [{ name: "Ada", isHost: true }], 100);
    expect(screeningIsWorthKeeping(d)).toBe(false);
  });
});
