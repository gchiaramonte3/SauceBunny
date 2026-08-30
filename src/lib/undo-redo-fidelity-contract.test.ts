import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * REDO MUST PUT BACK WHAT UNDO TOOK, not what the action originally added.
 *
 * The inverse of an `add` is `{t:"del", id}`, and `deleteComment` cascades to
 * every reply under that id. The inverse is computed EAGERLY when the comment
 * is posted - deliberately, because holding fifty ReviewDocs on the undo stack
 * was a memory leak - and at that moment the comment has no replies.
 *
 * In a live session a peer replies seconds later. Then cmd+Z on "add comment"
 * relays a del that takes their words off every machine, and redo replays the
 * single comment captured at push time. Nothing on the stack could restore the
 * reply. An undo that restores something DIFFERENT from what was there is
 * worse than no undo, and this restored strictly less.
 *
 * The fix keeps the eager inverse (the memory reason still holds) and computes
 * the REDO set when undo actually runs, off the freshest doc, using the `del`
 * case that already resurrects "peers' replies included".
 *
 * Pinned here because the lib tests cannot see ReviewPanel, and a component
 * test would have to stand up a session to reach it.
 */

const PANEL = join(__dirname, "..", "components", "ReviewPanel.tsx");

describe("redo restores what undo removed", () => {
  const src = readFileSync(PANEL, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

  it("finds dispatchUndoable", () => {
    // CANARY: a rename empties every assertion below.
    expect(src, "dispatchUndoable is gone").toMatch(/const dispatchUndoable = /);
  });

  it("recomputes the redo set at undo time for an add", () => {
    // The whole fix in one assertion: inside the undo closure, an `add` asks
    // the CURRENT doc what the del is about to remove.
    const at = src.indexOf("const dispatchUndoable = ");
    const body = src.slice(at, at + 2500);
    expect(body, "the undo closure no longer branches on an add")
      .toMatch(/op\.t === "add"/);
    expect(body, "redo is not rebuilt from the del-inverse of the freshest doc")
      .toMatch(/redoOps\s*=\s*inverseReviewOps\(/);
  });

  it("redo replays that set, not the original op", () => {
    const at = src.indexOf("const dispatchUndoable = ");
    const body = src.slice(at, at + 2500);
    // `redo: () => replayOps([restampReviewOp(op, …)])` is the shipped bug.
    expect(body, "redo replays the captured op instead of what undo removed")
      .not.toMatch(/redo:\s*\(\)\s*=>\s*replayOps\(\[restampReviewOp\(op/);
    expect(body).toMatch(/redoOps\.map\(/);
  });

  it("still computes the inverse eagerly, so the memory guard holds", () => {
    // The opposite failure: "fix" this by snapshotting the doc per entry and
    // fifty of them pin fifty ReviewDocs, which is the leak the eager inverse
    // exists to avoid.
    const at = src.indexOf("const dispatchUndoable = ");
    const body = src.slice(at, at + 2500);
    expect(body, "the eager inverse is gone - check this did not become a doc snapshot")
      .toMatch(/const inverse = inverseReviewOps\(before, op\)/);
  });
});
