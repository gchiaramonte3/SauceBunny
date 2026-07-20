import { describe, expect, it } from "vitest";
import {
  newScreening, openSegment, closeSegment, openSegmentOf,
  noteComment, unnoteComment, markWatched,
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
    d = closeSegment(d, 200);
    const once = JSON.stringify(d);
    d = closeSegment(d, 999);
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
    const d = newScreening("s", "R", "host", 0);
    d.participants = [{ name: "Me", isHost: true }, { name: "Gasper", isHost: false }];
    expect(screeningIsWorthKeeping(d)).toBe(true);
  });
});
