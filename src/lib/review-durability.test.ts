import { describe, expect, it } from "vitest";
import { applyReviewOp, buildComment, emptyDoc, inverseReviewOps, mergeReviewDoc } from "./review";

describe("review deletion durability", () => {
  const comment = buildComment({ versionId: "v", timeStart: 12, body: "Note", author: "A" }, 10);
  const base = applyReviewOp(emptyDoc("review"), { t: "add", comment });

  it("does not resurrect a saved deletion in either merge direction", () => {
    const deleted = applyReviewOp(base, { t: "del", id: comment.id, at: 20 });
    expect(mergeReviewDoc(base, deleted).comments).toEqual([]);
    expect(mergeReviewDoc(deleted, base).comments).toEqual([]);
    expect(applyReviewOp(deleted, { t: "add", comment }).comments).toEqual([]);
    expect(mergeReviewDoc(base, JSON.parse(JSON.stringify(deleted))).comments).toEqual([]);
  });

  it("only explicit undo restores a deleted note, including through an old snapshot", () => {
    const op = { t: "del" as const, id: comment.id, at: 20 };
    const deleted = applyReviewOp(base, op);
    const restored = inverseReviewOps(base, op, 20).reduce(applyReviewOp, deleted);
    expect(restored.comments).toHaveLength(1);
    expect(mergeReviewDoc(deleted, restored).comments).toHaveLength(1);
    expect(mergeReviewDoc(restored, deleted).comments).toHaveLength(1);
  });

  it("blocks late replies to a deleted thread but retains unrelated local notes", () => {
    const deleted = applyReviewOp(base, { t: "del", id: comment.id, at: 20 });
    const reply = buildComment({ versionId: "v", parentId: comment.id, timeStart: 12, body: "Reply", author: "B" }, 11);
    expect(applyReviewOp(deleted, { t: "add", comment: reply }).comments).toEqual([]);
    const unrelated = buildComment({ versionId: "v", timeStart: 22, body: "Local", author: "A" }, 30);
    const local = applyReviewOp(base, { t: "add", comment: unrelated });
    expect(mergeReviewDoc(local, deleted).comments.map((c) => c.id)).toEqual([unrelated.id]);
  });
});
