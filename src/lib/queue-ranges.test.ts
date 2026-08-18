import { describe, expect, it } from "vitest";
import { currentQueueSource, queuedRangesForSource, sameQueueSource } from "./queue-ranges";
import type { QueuedClip } from "../types";

/**
 * Reported as "a brand new fresh link already has in and out points applied".
 *
 * It did. The timeline drew a band for every clip in the queue, and the queue
 * is cross-source by design — so a clip queued from one video put its marks on
 * the next video's timeline, where they are indistinguishable from your own
 * selection.
 */
const clip = (id: string, source: QueuedClip["source"]): QueuedClip => ({
  id, source, fps: 25, title: id, thumbnail: null,
  inFrames: 100, outFrames: 200, filename: id, format: "1080",
  status: "queued",
} as QueuedClip);

const FILE_A = { kind: "file", path: "/a.mp4" } as const;
const FILE_B = { kind: "file", path: "/b.mp4" } as const;
const WEB_A = { kind: "web", url: "https://x.com/1" } as const;
const WEB_B = { kind: "web", url: "https://x.com/2" } as const;

describe("queued ranges are scoped to the loaded source", () => {
  const queue = [clip("a", FILE_A), clip("b", FILE_B), clip("w", WEB_A)];

  it("draws only the clips queued from this file", () => {
    const got = queuedRangesForSource(queue, currentQueueSource("file", "/a.mp4", null));
    expect(got.map((c) => c.id)).toEqual(["a"]);
  });

  it("draws only the clips queued from this web source", () => {
    const got = queuedRangesForSource(queue, currentQueueSource("youtube", null, "https://x.com/1"));
    expect(got.map((c) => c.id)).toEqual(["w"]);
  });

  it("draws NOTHING when the loaded source has no queued clips", () => {
    // The reported symptom: a fresh link showing someone else's marks.
    const got = queuedRangesForSource(queue, currentQueueSource("youtube", null, "https://x.com/999"));
    expect(got, "another source's marks bled onto a fresh link").toEqual([]);
  });

  it("draws nothing when no source is loaded", () => {
    expect(queuedRangesForSource(queue, currentQueueSource("file", null, null))).toEqual([]);
    expect(queuedRangesForSource(queue, currentQueueSource("youtube", null, null))).toEqual([]);
  });

  it("never matches across kinds, even on equal strings", () => {
    // A file at "/x" and a web source named "/x" are different things; a
    // loose compare would put one's marks on the other.
    expect(sameQueueSource(FILE_A, WEB_A)).toBe(false);
    expect(sameQueueSource({ kind: "file", path: "/x" }, { kind: "web", url: "/x" })).toBe(false);
  });

  it("keeps every clip that really is from this source", () => {
    const many = [clip("a1", FILE_A), clip("a2", FILE_A), clip("b", FILE_B)];
    const got = queuedRangesForSource(many, currentQueueSource("file", "/a.mp4", null));
    expect(got.map((c) => c.id)).toEqual(["a1", "a2"]);
  });

  it("distinguishes sources that differ only late in the string", () => {
    expect(sameQueueSource(WEB_A, WEB_B)).toBe(false);
    expect(sameQueueSource(FILE_A, FILE_B)).toBe(false);
    expect(sameQueueSource(FILE_A, { kind: "file", path: "/a.mp4" })).toBe(true);
  });
});
