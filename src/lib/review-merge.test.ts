import { describe, expect, it } from "vitest";
import { insertComment, mergeReviewDoc, type ReviewComment, type ReviewDoc } from "./review";

function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return { id: "shared", versionId: "v1", parentId: null, timeStart: 1, timeEnd: null,
    body: "Note", author: "Ada", resolved: false, createdAt: 10, updatedAt: 10,
    annotation: null, ...overrides };
}

function doc(comments: ReviewComment[], overrides: Partial<ReviewDoc> = {}): ReviewDoc {
  return { sourceKey: "review", versions: [{ id: "v1", label: "V1", path: "clip.mp4", addedAt: 1 }],
    activeVersionId: "v1", comments, status: {}, ...overrides };
}

function freeze(value: unknown): void {
  if (!value || typeof value !== "object") return;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
}

describe("snapshot comment priority (existing behavior)", () => {
  const cases: { rule: string; local: Partial<ReviewComment>; incoming: Partial<ReviewComment>; winner: string }[] = [
    { rule: "a higher local revision beats newer incoming restoration and edits",
      local: { revision: 3 }, incoming: { revision: 2, restoredAt: 100, updatedAt: 200 }, winner: "local" },
    { rule: "a higher incoming revision beats newer local restoration and edits",
      local: { revision: 2, restoredAt: 100, updatedAt: 200 }, incoming: { revision: 3 }, winner: "incoming" },
    { rule: "a newer local restoration beats an incoming edit at the same revision",
      local: { revision: 2, restoredAt: 30 }, incoming: { revision: 2, restoredAt: 20, updatedAt: 200 }, winner: "local" },
    { rule: "a newer incoming restoration beats a local edit at the same revision",
      local: { revision: 2, restoredAt: 20, updatedAt: 200 }, incoming: { revision: 2, restoredAt: 30 }, winner: "incoming" },
    { rule: "edit time decides when revision and restoration match",
      local: { revision: 2, restoredAt: 30, updatedAt: 40 }, incoming: { revision: 2, restoredAt: 30 }, winner: "local" },
    { rule: "the newer incoming edit wins",
      local: { updatedAt: 10 }, incoming: { updatedAt: 20 }, winner: "incoming" },
    { rule: "an exact tie retains the incoming comment",
      local: { revision: 2, restoredAt: 30 }, incoming: { revision: 2, restoredAt: 30 }, winner: "incoming" },
    { rule: "absent legacy coordinates mean zero",
      local: { updatedAt: 20 }, incoming: { revision: 0, restoredAt: 0 }, winner: "local" },
    { rule: "explicit zero and absent coordinates tie",
      local: { revision: 0, restoredAt: 0 }, incoming: {}, winner: "incoming" },
  ];

  it.each(cases)("$rule", ({ local, incoming, winner }) => {
    const ours = comment({ body: "local", ...local });
    const theirs = comment({ body: "incoming", ...incoming });
    const merged = mergeReviewDoc(doc([ours]), doc([theirs]));
    // All winner fields survive, not only the body; legacy likes keep their
    // existing explicit-undefined representation when neither copy has any.
    expect(merged.comments[0]).toStrictEqual({ ...(winner === "local" ? ours : theirs), likes: undefined });
  });

  it.each(["local", "incoming"])("merges reactions independently of the %s body winner", (winner) => {
    const local = doc([comment({ body: "local", revision: winner === "local" ? 2 : 1,
      likes: ["Ada", "Bo"], reactions: { "🎯": ["Ada"] },
      reactedAt: { "👍": { Ada: { on: false, at: 30 } } } })]);
    const incoming = doc([comment({ body: "incoming", revision: winner === "incoming" ? 2 : 1,
      likes: ["Ada", "Cy"], reactions: { "🎯": ["Cy"] },
      reactedAt: { "👍": { Ada: { on: true, at: 20 } } } })]);
    const before = structuredClone({ local, incoming });
    freeze(local);
    freeze(incoming);

    const merged = mergeReviewDoc(local, incoming);
    expect(merged.comments[0]).toMatchObject({ body: winner, likes: ["Cy", "Bo"],
      reactions: { "🎯": ["Cy", "Ada"] }, reactedAt: { "👍": { Ada: { on: false, at: 30 } } } });
    expect({ local, incoming }).toStrictEqual(before);
    expect(mergeReviewDoc(local, incoming)).toStrictEqual(merged);
  });
});

describe("insertion and snapshot deletion rules agree", () => {
  const cases: { rule: string; note?: Partial<ReviewComment>; deleted?: Record<string, number>; retained: boolean }[] = [
    { rule: "an absent deletion map retains the note", retained: true },
    { rule: "a zero deletion timestamp is not a deletion", deleted: { shared: 0 }, retained: true },
    { rule: "a root ignores an unrelated empty-string key", deleted: { "": 20 }, retained: true },
    { rule: "a deleted note stays deleted", deleted: { shared: 20 }, retained: false },
    { rule: "a later edit is not an explicit restoration", note: { updatedAt: 100 }, deleted: { shared: 20 }, retained: false },
    { rule: "a restoration tied with deletion stays deleted", note: { restoredAt: 20 }, deleted: { shared: 20 }, retained: false },
    { rule: "a restoration after deletion survives", note: { restoredAt: 21 }, deleted: { shared: 20 }, retained: true },
    { rule: "a late reply to a deleted parent stays deleted", note: { parentId: "root" }, deleted: { root: 20 }, retained: false },
    { rule: "the newer parent deletion wins over the reply's deletion",
      note: { parentId: "root", restoredAt: 21 }, deleted: { root: 30, shared: 20 }, retained: false },
    { rule: "the newer reply deletion wins over its parent's deletion",
      note: { parentId: "root", restoredAt: 21 }, deleted: { root: 20, shared: 30 }, retained: false },
    { rule: "a reply restored after both deletions survives",
      note: { parentId: "root", restoredAt: 31 }, deleted: { root: 30, shared: 20 }, retained: true },
  ];

  it.each(cases)("$rule", ({ note, deleted, retained }) => {
    const c = comment(note);
    const deletedDoc = doc([], deleted ? { deletedComments: deleted } : {});
    freeze(c);
    freeze(deletedDoc);
    const inserted = insertComment(deletedDoc, c);
    const merged = mergeReviewDoc(doc([c]), deletedDoc);
    const reverse = mergeReviewDoc(deletedDoc, doc([c]));
    const expected = retained ? [c] : [];
    expect(inserted.comments).toStrictEqual(expected);
    expect(merged.comments).toStrictEqual(expected);
    expect(reverse.comments).toStrictEqual(expected);
    if (!retained) expect(inserted).toBe(deletedDoc);
  });

  it("merges deletion clocks by newest timestamp before checking restoration", () => {
    const c = comment({ restoredAt: 25 });
    const local = doc([c], { deletedComments: { shared: 20, localOnly: 10 } });
    const incoming = doc([], { deletedComments: { shared: 30, incomingOnly: 5 } });
    const merged = mergeReviewDoc(local, incoming);
    expect(merged.comments).toEqual([]);
    expect(merged.deletedComments).toEqual({ shared: 30, localOnly: 10, incomingOnly: 5 });
  });
});

describe("snapshot structure and reference behavior", () => {
  it("keeps incoming order, appends local-only comments and does not mutate either input", () => {
    const local = doc([comment({ id: "local-only" }), comment({ body: "local", updatedAt: 20 })]);
    const incoming = doc([comment({ id: "incoming-only" }), comment({ body: "incoming" })]);
    const before = structuredClone({ local, incoming });
    freeze(local);
    freeze(incoming);
    const result = mergeReviewDoc(local, incoming);
    expect(result.comments.map(c => c.id)).toEqual(["incoming-only", "shared", "local-only"]);
    expect(result.comments[0]).not.toBe(incoming.comments[0]);
    expect(result.comments[1]).not.toBe(local.comments[1]);
    expect(result.comments[2]).toBe(local.comments[0]);
    expect(result.versions).toBe(incoming.versions);
    expect(result).not.toHaveProperty("deletedComments");
    expect(result).not.toHaveProperty("sync");
    expect({ local, incoming }).toStrictEqual(before);
  });

  it("takes a different source whole without reconciling its comments", () => {
    const local = doc([comment()], { deletedComments: { shared: 20 } });
    const incoming = doc([comment()], { sourceKey: "another-review" });
    freeze(local);
    freeze(incoming);
    expect(mergeReviewDoc(local, incoming)).toBe(incoming);
  });
});
