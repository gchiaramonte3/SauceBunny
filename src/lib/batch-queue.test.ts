import { describe, expect, it } from "vitest";
import {
  batchProgress, batchSummary, cancelBatch, EMPTY_BATCH, markItem, nextPending, startBatch,
  type BatchState,
} from "./batch-queue";

/**
 * The interesting cases are all failures: one file blowing up mid-run, and the
 * user stopping a run that has already written output to disk.
 */

const files = ["a", "b", "c"].map((n) => ({ path: `/m/${n}.mp4`, name: `${n}.mp4` }));
const statuses = (s: BatchState) => s.items.map((i) => i.status).join(",");

/** Drive the queue the way the hook does, with a per-file outcome. */
function run(s: BatchState, outcome: (name: string) => "done" | "error"): BatchState {
  for (;;) {
    const i = nextPending(s);
    if (i < 0) return s;
    s = markItem(s, i, "running");
    const r = outcome(s.items[i].name);
    s = markItem(s, i, r, r === "error" ? "boom" : undefined);
  }
}

describe("a clean run", () => {
  it("walks every file in the order given", () => {
    const seen: string[] = [];
    const end = run(startBatch(files), (n) => { seen.push(n); return "done"; });
    expect(seen).toEqual(["a.mp4", "b.mp4", "c.mp4"]);
    expect(statuses(end)).toBe("done,done,done");
    expect(batchProgress(end).finished).toBe(true);
  });

  it("reports progress as it goes", () => {
    let s = startBatch(files);
    s = markItem(s, 0, "done");
    s = markItem(s, 1, "running");
    const p = batchProgress(s);
    expect(p.done).toBe(1);
    expect(p.running?.name).toBe("b.mp4");
    expect(p.settled).toBe(1);
    expect(p.finished).toBe(false);
    expect(batchSummary(p)).toBe("Transcribing b.mp4 · 2 of 3");
  });
});

describe("one file failing", () => {
  it("does NOT stop the batch", () => {
    // The whole reason the queue records per-file status. Aborting on the first
    // bad file leaves the user to work out which of seventeen it was.
    const seen: string[] = [];
    const end = run(startBatch(files), (n) => { seen.push(n); return n === "b.mp4" ? "error" : "done"; });
    expect(seen).toHaveLength(3); // c still ran
    expect(statuses(end)).toBe("done,error,done");
  });

  it("keeps the reason against that file", () => {
    let s = startBatch(files);
    s = markItem(s, 1, "error", "codec not supported");
    expect(s.items[1].error).toBe("codec not supported");
    expect(s.items[0].error).toBeUndefined();
  });

  it("still counts as finished, and says what happened", () => {
    const end = run(startBatch(files), (n) => (n === "b.mp4" ? "error" : "done"));
    const p = batchProgress(end);
    expect(p.finished).toBe(true);
    expect(batchSummary(p)).toBe("2 transcribed · 1 failed");
  });
});

describe("cancelling", () => {
  it("skips what has not started and stops handing out work", () => {
    let s = startBatch(files);
    s = markItem(s, 0, "done");
    s = cancelBatch(s);
    expect(statuses(s)).toBe("done,skipped,skipped");
    expect(nextPending(s)).toBe(-1);
  });

  it("does NOT rewrite a file that already finished", () => {
    let s = startBatch(files);
    s = markItem(s, 0, "done");
    s = markItem(s, 1, "error", "boom");
    s = cancelBatch(s);
    expect(s.items[0].status).toBe("done");
    expect(s.items[1].status).toBe("error");
  });

  it("leaves the IN-FLIGHT file running rather than calling it skipped", () => {
    // It may already have written a partial .srt. Marking it skipped would
    // claim the file was untouched, which is the one thing we know is false.
    let s = startBatch(files);
    s = markItem(s, 1, "running");
    s = cancelBatch(s);
    expect(statuses(s)).toBe("skipped,running,skipped");
    expect(batchProgress(s).running?.name).toBe("b.mp4");
    expect(batchProgress(s).finished).toBe(false); // still settling
  });

  it("is finished once the in-flight file resolves", () => {
    let s = startBatch(files);
    s = markItem(s, 1, "running");
    s = cancelBatch(s);
    s = markItem(s, 1, "done");
    expect(batchProgress(s).finished).toBe(true);
    expect(batchSummary(batchProgress(s))).toBe("1 transcribed · 2 skipped");
  });
});

describe("edges", () => {
  it("an empty batch is not 'finished', because it never ran", () => {
    // Callers use `finished` to decide whether to show a result summary, and
    // summarising a run that never happened is noise.
    expect(batchProgress(EMPTY_BATCH).finished).toBe(false);
    expect(batchSummary(batchProgress(EMPTY_BATCH))).toBe("");
    expect(nextPending(EMPTY_BATCH)).toBe(-1);
  });

  it("marking an index that is not there changes nothing", () => {
    const s = startBatch(files);
    expect(markItem(s, 99, "done")).toBe(s);
    expect(markItem(s, -1, "done")).toBe(s);
  });

  it("a single-file batch behaves like the batch it is", () => {
    const end = run(startBatch([files[0]]), () => "done");
    expect(batchProgress(end).finished).toBe(true);
    expect(batchSummary(batchProgress(end))).toBe("1 transcribed");
  });
});
