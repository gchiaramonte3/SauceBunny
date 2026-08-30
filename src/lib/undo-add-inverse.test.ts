import { describe, expect, it } from "vitest";
import {
  applyReviewOp, buildComment, inverseReviewOps, emptyDoc,
  type ReviewDoc, type ReviewOp,
} from "./review";

/**
 * UNDOING YOUR OWN COMMENT USED TO DELETE THE REPLIES TO IT.
 *
 * The inverse of an `add` is `{t:"del", id}`, and `deleteComment` filters
 * `c.parentId !== id` - so it removes every reply under that comment. The
 * inverse is computed when the comment is POSTED, deliberately (holding fifty
 * ReviewDocs on the stack was a memory leak), and at that moment there are no
 * replies. In a live session a peer can reply seconds later.
 *
 * So: post a comment, a peer replies, press cmd+Z. The del relays to every
 * machine and takes their words with it, and redo replays only the comment
 * captured at push time - which predates the reply. Nothing on the stack could
 * bring it back.
 *
 * `case "del"` already solved this exact problem: it captures the removed set
 * and resurrects "peers' replies included". It can, because a delete knows
 * what it is deleting. The fix is to compute what REDO restores at undo time
 * using that same case, which is what dispatchUndoable does now.
 *
 * These pin the lib half - that the del-inverse is the exact resurrect set -
 * since that is what the fix leans on.
 */

const root = buildComment({ versionId: "v1", timeStart: 5, timeEnd: null, body: "hold here", author: "Ada" }, 1000);
const reply = buildComment({ versionId: "v1", timeStart: 5, timeEnd: null, body: "agreed", author: "Lin", parentId: root.id }, 2000);

function docWith(...ops: ReviewOp[]): ReviewDoc {
  return ops.reduce((d, op) => applyReviewOp(d, op), emptyDoc("/movies/cut.mov"));
}

describe("deleting a comment is reversible, replies included", () => {
  it("the del-inverse resurrects the root AND every reply", () => {
    const doc = docWith({ t: "add", comment: root }, { t: "add", comment: reply });
    const inv = inverseReviewOps(doc, { t: "del", id: root.id });

    // Both, and as adds carrying the ORIGINAL comments - so authorship and
    // timestamps survive rather than being re-minted under the undoer's name.
    expect(inv).toHaveLength(2);
    const bodies = inv.map((o) => (o.t === "add" ? o.comment.body : o.t));
    expect(bodies.sort()).toEqual(["agreed", "hold here"]);
    const authors = inv.map((o) => (o.t === "add" ? o.comment.author : "?"));
    expect(authors, "a peer's reply must come back as THEIRS").toContain("Lin");
  });

  it("a delete really does take the replies, which is why the above matters", () => {
    // CANARY. If deleteComment stopped cascading, the resurrect set above
    // would be over-eager rather than exact, and this whole shape would be
    // the wrong fix.
    const doc = docWith({ t: "add", comment: root }, { t: "add", comment: reply });
    expect(doc.comments).toHaveLength(2);
    const after = applyReviewOp(doc, { t: "del", id: root.id });
    expect(after.comments, "the reply should have gone with its parent").toHaveLength(0);
  });

  it("round-trips: delete then resurrect restores both comments", () => {
    const doc = docWith({ t: "add", comment: root }, { t: "add", comment: reply });
    const inv = inverseReviewOps(doc, { t: "del", id: root.id });
    const deleted = applyReviewOp(doc, { t: "del", id: root.id });
    const restored = inv.reduce((d, op) => applyReviewOp(d, op), deleted);
    expect(restored.comments.map((c) => c.id).sort()).toEqual([root.id, reply.id].sort());
  });

  it("the add-inverse alone is NOT the whole story", () => {
    // The defect in one line: the inverse of adding the root is a bare del,
    // which is exactly one op no matter how many replies exist. That is why
    // redo cannot be built from it and has to be recomputed at undo time.
    const inv = inverseReviewOps(docWith({ t: "add", comment: root }), { t: "add", comment: root });
    expect(inv).toEqual([{ t: "del", id: root.id }]);
  });
});
