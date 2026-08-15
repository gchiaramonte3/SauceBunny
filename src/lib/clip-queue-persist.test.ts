// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { loadClipQueue, saveClipQueue } from "./storage";
import { isQueuedClip } from "../types";

/**
 * The queue was the least protected object in the app: plain component state,
 * no persistence, and two one-click paths that wiped it with no confirmation
 * and no undo — while clearing recents, deleting cached files and removing a
 * library root all asked first. Each row is a range somebody marked by hand,
 * so it is the one thing in the workspace that cannot be recreated by pressing
 * a button again.
 */
const row = (over: Record<string, unknown> = {}) => ({
  id: "a", source: { kind: "file", path: "/x.mov" }, fps: 24,
  title: "x", thumbnail: null, inFrames: 0, outFrames: 48,
  filename: "clip", format: "mp4", reencode: false, captions: false,
  status: "queued", ...over,
});

beforeEach(() => localStorage.clear());

describe("clip queue persistence", () => {
  it("brings back the row that was mid-export when the app went away", () => {
    // Only "queued" used to persist, so quitting during an export dropped the
    // row being exported: everything else in the queue survived and the range
    // the user was actually working on did not. It returns as "queued"
    // because nothing starts the queue on boot, so that is both the safe
    // state and the true one.
    saveClipQueue([
      row({ id: "waiting", status: "queued" }),
      row({ id: "in-flight", status: "running" }),
    ]);
    const back = loadClipQueue(isQueuedClip);
    expect(back.map((c) => c.id).sort()).toEqual(["in-flight", "waiting"]);
    expect(back.every((c) => c.status === "queued")).toBe(true);
  });

  it("survives a round trip", () => {
    saveClipQueue([row({ id: "a" }), row({ id: "b" })]);
    expect(loadClipQueue(isQueuedClip).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("keeps the marks, which are the part that cannot be recreated", () => {
    saveClipQueue([row({ inFrames: 123, outFrames: 456, fps: 23.976 })]);
    const [back] = loadClipQueue(isQueuedClip);
    expect(back.inFrames).toBe(123);
    expect(back.outFrames).toBe(456);
    // fps travels with the ITEM, never read from the live player, because the
    // player may be showing a different source by the time this runs.
    expect(back.fps).toBe(23.976);
  });

  it("drops finished and failed rows", () => {
    // A done row points at a file on disk and a failed one at an error from a
    // session that is over. Restoring them would greet the user with
    // yesterday's results in a panel that is meant to be a to-do list.
    //
    // A "running" row used to be listed here too, and that was the mistake:
    // the reasoning above is about RESULTS, and an export that was still going
    // when the app went away is not a result, it is unfinished work. It has
    // its own test below.
    saveClipQueue([
      row({ id: "keep" }),
      row({ id: "done", status: "done" }),
      row({ id: "failed", status: "failed" }),
    ]);
    expect(loadClipQueue(isQueuedClip).map((c) => c.id)).toEqual(["keep"]);
  });

  it("stores nothing at all when there is nothing to resume", () => {
    saveClipQueue([row({ status: "done" })]);
    expect(localStorage.getItem("saucebunny.clipQueue")).toBeNull();
    expect(loadClipQueue(isQueuedClip)).toEqual([]);
  });

  it("survives one corrupt row instead of losing the rest", () => {
    // This is JSON a PREVIOUS BUILD wrote, so it is untrusted in the same way
    // a wire message is. One malformed entry must not cost the user the queue.
    localStorage.setItem("saucebunny.clipQueue", JSON.stringify([
      row({ id: "good" }),
      { id: "bad", status: "queued" },            // no source, no fps
      row({ id: "alsobad", fps: 0 }),             // fps 0 would divide by zero
      row({ id: "good2" }),
    ]));
    expect(loadClipQueue(isQueuedClip).map((c) => c.id)).toEqual(["good", "good2"]);
  });

  it("survives outright garbage in the key", () => {
    for (const junk of ['"not an array"', "{}", "null", "["]) {
      localStorage.setItem("saucebunny.clipQueue", junk);
      expect(loadClipQueue(isQueuedClip)).toEqual([]);
    }
  });
});
