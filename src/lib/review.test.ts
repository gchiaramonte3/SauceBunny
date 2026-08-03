import { describe, it, expect, beforeEach } from "vitest";
import {
  emptyDoc, ensureVersion,
  editComment, deleteComment,
  editReply, removeReply, ensureCommentIds,
  setStatus, statusOf, reactionsOf, rootComments, repliesOf, sortComments,
  commentMarkers, openCount, reviewToMarkdown,
  reviewFingerprint, resolveByFingerprint, linkFingerprint,
  loadReviewHistory, upsertReviewHistory, removeReviewHistory, clearReviewHistory,
  buildComment, insertComment, setResolved, setLike, applyReviewOp, mergeReviewDoc,
  inverseReviewOps, restampReviewOp,
  annotationHasContent, annotationsOf, labelSuffix, sanitizeDocForWire,
  setActiveVersion, carriedComments, versionStem, versionCandidates,
  type ReviewDoc, type ReviewComment, type AnnotationStrokes, attributeReviewOp,
} from "./review";

// Fixture shims over the live primitives - the one-shot legacy wrappers
// (addComment / toggleLike / toggleResolved / setActiveVersion) left the
// prod API in the giant review; the idempotent forms are what ship.
const addComment = (doc: ReviewDoc, c: Parameters<typeof buildComment>[0], now = Date.now()) =>
  insertComment(doc, buildComment(c, now));
const toggleLike = (doc: ReviewDoc, id: string, name: string) => {
  const c = doc.comments.find((x) => x.id === id);
  const liked = !(c ? (reactionsOf(c)["👍"] ?? []) : []).includes(name.trim());
  return setLike(doc, id, name, liked);
};
const toggleResolved = (doc: ReviewDoc, id: string, now = Date.now()) => {
  const c = doc.comments.find((x) => x.id === id);
  return setResolved(doc, id, !c?.resolved, now);
};

const thumbsOf = (doc: ReviewDoc, id: string) => {
  const c = doc.comments.find((x) => x.id === id);
  return c ? reactionsOf(c)["👍"] ?? [] : [];
};

function seed(): { doc: ReviewDoc; v: string } {
  const r = ensureVersion(emptyDoc("/clip.mp4"), "/clip.mp4", "V1", 1000);
  return { doc: r.doc, v: r.versionId };
}

describe("co-review op relay (applyReviewOp)", () => {
  const mk = (v: string, id: string, at = 1000): ReviewComment =>
    ({ ...buildComment({ versionId: v, timeStart: 1, body: "hi", author: "A" }, at), id });

  it("insertComment is idempotent by id (add op replays safely)", () => {
    const { doc, v } = seed();
    const c = mk(v, "x1");
    const once = insertComment(doc, c);
    const twice = insertComment(once, c);
    expect(once.comments).toHaveLength(1);
    expect(twice.comments).toHaveLength(1); // no duplicate on replay
  });

  it("two peers' add ops commute to the same doc regardless of order", () => {
    const { doc, v } = seed();
    const a = mk(v, "a"); const b = mk(v, "b");
    const ab = applyReviewOp(applyReviewOp(doc, { t: "add", comment: a }), { t: "add", comment: b });
    const ba = applyReviewOp(applyReviewOp(doc, { t: "add", comment: b }), { t: "add", comment: a });
    expect(ab.comments.map((c) => c.id).sort()).toEqual(ba.comments.map((c) => c.id).sort());
    expect(ab.comments).toHaveLength(2);
  });

  it("resolve/like ops are SET (idempotent), not toggle", () => {
    const { doc, v } = seed();
    const d0 = insertComment(doc, mk(v, "x1"));
    const r1 = applyReviewOp(d0, { t: "resolve", id: "x1", resolved: true, at: 2000 });
    const r2 = applyReviewOp(r1, { t: "resolve", id: "x1", resolved: true, at: 2000 });
    expect(r2.comments[0].resolved).toBe(true); // replay doesn't flip it back
    const l1 = applyReviewOp(d0, { t: "like", id: "x1", name: "Sam", liked: true });
    const l2 = applyReviewOp(l1, { t: "like", id: "x1", name: "Sam", liked: true });
    expect(reactionsOf(l2.comments[0])["👍"]).toEqual(["Sam"]); // no double-add
    expect(reactionsOf(setLike(l2, "x1", "Sam", false).comments[0])["👍"] ?? []).toEqual([]);
  });

  it("edit is last-writer-wins by timestamp (concurrent edits converge)", () => {
    const { doc, v } = seed();
    const d0 = insertComment(doc, mk(v, "x1", 1000));
    // Apply the LATER edit first, then the EARLIER one — the later must win.
    const late = applyReviewOp(d0, { t: "edit", id: "x1", body: "late", at: 3000 });
    const both = applyReviewOp(late, { t: "edit", id: "x1", body: "early", at: 2000 });
    expect(both.comments[0].body).toBe("late");
    expect(setResolved(d0, "x1", true, 4000).comments[0].updatedAt).toBe(4000);
  });

  it("mergeReviewDoc keeps a local in-flight comment the snapshot lacks", () => {
    const { doc, v } = seed();
    const shared = insertComment(doc, mk(v, "host1"));      // host's doc (snapshot)
    const local = insertComment(shared, mk(v, "mine"));      // + my not-yet-echoed comment
    const merged = mergeReviewDoc(local, shared);            // adopt snapshot, keep mine
    expect(merged.comments.map((c) => c.id).sort()).toEqual(["host1", "mine"]);
  });

  it("mergeReviewDoc keeps the newer edit + unions likes", () => {
    const { doc, v } = seed();
    const base = insertComment(doc, mk(v, "x1", 1000));
    const incoming = setResolved(base, "x1", false, 1000);   // snapshot: unresolved
    const local = setLike(setResolved(base, "x1", true, 2000), "x1", "Me", true); // mine: resolved + liked
    const merged = mergeReviewDoc(local, incoming);
    expect(merged.comments[0].resolved).toBe(true);          // newer local edit kept
    expect(reactionsOf(merged.comments[0])["👍"]).toEqual(["Me"]);        // like survives (unioned)
  });
});

describe("versions", () => {
  it("adds a version and makes the first one active", () => {
    const { doc, v } = seed();
    expect(doc.versions).toHaveLength(1);
    expect(doc.activeVersionId).toBe(v);
  });
  it("reuses the version for the same path; adds a new one for a new path", () => {
    const { doc, v } = seed();
    const same = ensureVersion(doc, "/clip.mp4");
    expect(same.versionId).toBe(v);
    expect(same.doc.versions).toHaveLength(1);
    const next = ensureVersion(same.doc, "/clip_v2.mp4", "V2");
    expect(next.doc.versions).toHaveLength(2);
    expect(next.versionId).not.toBe(v);
    expect(next.doc.activeVersionId).toBe(v); // active stays on the first
  });
});

describe("version stacks", () => {
  /** A two-version doc with notes on both: the shape a real stack has after
   *  one round of producer notes and one new render. */
  function stack() {
    const s = seed();
    const v2 = ensureVersion(s.doc, "/clip_v2.mp4", "V2", 2000);
    let doc = setActiveVersion(v2.doc, v2.versionId);
    doc = addComment(doc, { versionId: s.v, timeStart: 30, body: "old open", author: "Nika" }, 10);
    doc = addComment(doc, { versionId: s.v, timeStart: 10, body: "old resolved", author: "Nika" }, 11);
    doc = addComment(doc, { versionId: v2.versionId, timeStart: 5, body: "new note", author: "Nika" }, 12);
    const resolved = doc.comments.find((c) => c.body === "old resolved")!;
    doc = setResolved(doc, resolved.id, true);
    return { doc, v1: s.v, v2: v2.versionId };
  }

  it("setActiveVersion switches, and refuses an id the doc does not have", () => {
    const { doc, v1 } = stack();
    expect(setActiveVersion(doc, v1).activeVersionId).toBe(v1);
    expect(setActiveVersion(doc, "nope").activeVersionId).toBe(doc.activeVersionId);
  });

  it("carries UNRESOLVED notes from other versions, tagged with their origin", () => {
    // The point of the whole stack: v1's open notes stay visible over v2.
    const { doc } = stack();
    const carried = carriedComments(doc, doc.activeVersionId);
    expect(carried).toHaveLength(1);
    expect(carried[0].comment.body).toBe("old open");
    expect(carried[0].versionLabel).toBe("V1");
  });

  it("carries nothing for a single-version doc, whatever its comments", () => {
    const s = seed();
    const doc = addComment(s.doc, { versionId: s.v, timeStart: 1, body: "x", author: "N" });
    expect(carriedComments(doc, s.v)).toHaveLength(0);
  });

  it("does not carry the active version's own comments", () => {
    const { doc, v1 } = stack();
    // Viewed from v1, the carried list is v2's open notes, not v1's.
    const carried = carriedComments(doc, v1);
    expect(carried.map((c) => c.comment.body)).toEqual(["new note"]);
  });
});

describe("version identity (stem + candidates)", () => {
  it("reduces render decorations to the cut's name", () => {
    expect(versionStem("LMH_Reunion_v2_FINAL (1).mp4")).toBe("lmh reunion");
    expect(versionStem("LMH Reunion v3")).toBe("lmh reunion");
    expect(versionStem("LMH Reunion")).toBe("lmh reunion");
    expect(versionStem("Reunion FINAL final2 copy.mov")).toBe("reunion");
    expect(versionStem("interview 2026-08-03.mp4")).toBe("interview");
  });

  it("does not reduce different cuts to the same stem", () => {
    expect(versionStem("LMH Reunion Part 2")).not.toBe(versionStem("LMH Reunion"));
    expect(versionStem("Harry Interview")).not.toBe(versionStem("Amber Interview"));
  });

  it("offers only same-stem history, newest first, never the file itself", () => {
    const history = [
      { key: "/a/reunion_v1.mp4", title: "Reunion v1", path: "/a/reunion_v1.mp4", updatedAt: 100, count: 9 },
      { key: "/a/reunion_v2.mp4", title: "Reunion v2", path: "/a/reunion_v2.mp4", updatedAt: 200, count: 3 },
      { key: "/a/other.mp4", title: "Something else", path: "/a/other.mp4", updatedAt: 300, count: 1 },
    ];
    const got = versionCandidates("Reunion_v3.mp4", "/a/reunion_v3.mp4", history);
    expect(got.map((h) => h.key)).toEqual(["/a/reunion_v2.mp4", "/a/reunion_v1.mp4"]);
    // And a title with an empty stem can never match the world.
    expect(versionCandidates("v2.mp4", null, history)).toHaveLength(0);
  });
});

describe("comments", () => {
  it("adds root comments + threaded replies", () => {
    const { doc, v } = seed();
    const d1 = addComment(doc, { versionId: v, timeStart: 12.5, body: "tighten this cut", author: "Me" }, 2000);
    const root = d1.comments[0];
    expect(root.parentId).toBeNull();
    expect(root.timeStart).toBe(12.5);
    expect(root.resolved).toBe(false);
    const d2 = addComment(d1, { versionId: v, timeStart: 12.5, body: "agreed", author: "Me", parentId: root.id }, 2100);
    expect(repliesOf(d2, root.id)).toHaveLength(1);
    expect(rootComments(d2, v)).toHaveLength(1); // replies aren't roots
  });
  it("edits, resolves, and deletes (cascading replies)", () => {
    const { doc, v } = seed();
    let d = addComment(doc, { versionId: v, timeStart: 1, body: "a", author: "Me" }, 10);
    const root = d.comments[0];
    d = addComment(d, { versionId: v, timeStart: 1, body: "reply", author: "Me", parentId: root.id }, 11);
    d = editComment(d, root.id, "a (edited)", 12);
    expect(d.comments.find((c) => c.id === root.id)?.body).toBe("a (edited)");
    d = toggleResolved(d, root.id, 13);
    expect(d.comments.find((c) => c.id === root.id)?.resolved).toBe(true);
    d = deleteComment(d, root.id); // removes the root AND its reply
    expect(d.comments).toHaveLength(0);
  });
});

describe("replies", () => {
  /** Root + two replies under it (plus their ids) for the reply-op tests. */
  function threaded(): { d: ReviewDoc; v: string; rootId: string; r1: string; r2: string } {
    const { doc, v } = seed();
    let d = addComment(doc, { versionId: v, timeStart: 3, body: "root", author: "Me" }, 10);
    const rootId = d.comments[0].id;
    d = addComment(d, { versionId: v, timeStart: 3, body: "first", author: "Me", parentId: rootId }, 11);
    d = addComment(d, { versionId: v, timeStart: 3, body: "second", author: "You", parentId: rootId }, 12);
    const [r1, r2] = repliesOf(d, rootId).map((r) => r.id);
    return { d, v, rootId, r1, r2 };
  }

  it("editReply round-trips a body edit (and bumps updatedAt, only on that reply)", () => {
    const { d, v, rootId, r1, r2 } = threaded();
    const next = editReply(d, v, rootId, r1, "first (edited)", 99);
    const edited = next.comments.find((c) => c.id === r1)!;
    expect(edited.body).toBe("first (edited)");
    expect(edited.updatedAt).toBe(99);
    expect(next.comments.find((c) => c.id === r2)?.body).toBe("second"); // sibling untouched
    expect(next.comments.find((c) => c.id === rootId)?.body).toBe("root"); // root untouched
  });
  it("editReply no-ops on unknown ids (wrong reply / parent / version)", () => {
    const { d, v, rootId, r1 } = threaded();
    expect(editReply(d, v, rootId, "nope", "x")).toBe(d);
    expect(editReply(d, v, "nope", r1, "x")).toBe(d);      // reply exists, wrong parent
    expect(editReply(d, "nope", rootId, r1, "x")).toBe(d); // reply exists, wrong version
  });
  it("removeReply deletes just that reply; unknown ids no-op", () => {
    const { d, v, rootId, r1, r2 } = threaded();
    const next = removeReply(d, v, rootId, r1);
    expect(repliesOf(next, rootId).map((r) => r.id)).toEqual([r2]);
    expect(rootComments(next, v)).toHaveLength(1); // root survives
    expect(removeReply(d, v, rootId, "nope")).toBe(d);
    expect(removeReply(d, v, "nope", r1)).toBe(d);
  });
  it("ensureCommentIds assigns an id to a legacy reply without one", () => {
    const { d, rootId } = threaded();
    // Simulate a doc persisted before reply ids were guaranteed.
    const legacy: ReviewDoc = {
      ...d,
      comments: [...d.comments, { ...d.comments[1], id: "" as ReviewComment["id"], body: "legacy" }],
    };
    const repaired = ensureCommentIds(legacy);
    const fixed = repaired.comments.find((c) => c.body === "legacy")!;
    expect(fixed.id).toBeTruthy();
    expect(fixed.parentId).toBe(rootId); // threading preserved
    // Every comment ends up addressable, and an already-sound doc is untouched.
    expect(repaired.comments.every((c) => c.id)).toBe(true);
    expect(ensureCommentIds(d)).toBe(d);
  });
});

describe("likes", () => {
  /** Root + one reply (plus their ids) for the like-toggle tests. */
  function noted(): { d: ReviewDoc; v: string; rootId: string; replyId: string } {
    const { doc, v } = seed();
    let d = addComment(doc, { versionId: v, timeStart: 4, body: "root", author: "Me" }, 10);
    const rootId = d.comments[0].id;
    d = addComment(d, { versionId: v, timeStart: 4, body: "reply", author: "You", parentId: rootId }, 11);
    return { d, v, rootId, replyId: repliesOf(d, rootId)[0].id };
  }

  it("toggles a like on, then off", () => {
    const { d, rootId } = noted();
    const on = toggleLike(d, rootId, "Sam");
    expect(thumbsOf(on, rootId)).toEqual(["Sam"]);
    const off = toggleLike(on, rootId, "Sam");
    expect(thumbsOf(off, rootId)).toEqual([]);
  });
  it("collects multiple likers; toggling removes only that name", () => {
    const { d, rootId } = noted();
    let n = toggleLike(d, rootId, "Sam");
    n = toggleLike(n, rootId, "Alex");
    expect(thumbsOf(n, rootId)).toEqual(["Sam", "Alex"]);
    n = toggleLike(n, rootId, "Sam");
    expect(thumbsOf(n, rootId)).toEqual(["Alex"]);
  });
  it("likes a reply (flat array — same op); root untouched", () => {
    const { d, rootId, replyId } = noted();
    const n = toggleLike(d, replyId, "Sam");
    expect(reactionsOf(repliesOf(n, rootId)[0])["👍"]).toEqual(["Sam"]);
    expect(thumbsOf(n, rootId)).toEqual([]);
  });
  it("trims the name; empty names and unknown ids no-op", () => {
    const { d, rootId } = noted();
    const n = toggleLike(d, rootId, "  Sam  ");
    expect(thumbsOf(n, rootId)).toEqual(["Sam"]);
    // The trimmed store means an untrimmed re-toggle still matches (removes).
    expect(thumbsOf(toggleLike(n, rootId, "Sam "), rootId)).toEqual([]);
    expect(toggleLike(d, rootId, "   ")).toBe(d);
    expect(toggleLike(d, "nope", "Sam")).toBe(d);
  });
});

describe("annotation labels", () => {
  const stroke = { color: "#ff3b30", size: 8, pts: [[0.1, 0.1], [0.2, 0.2]] as [number, number][] };
  const labeled: AnnotationStrokes = { strokes: [stroke], labels: [{ text: "Fix this", x: 0.25, y: 0.75 }] };
  const labelsOnly: AnnotationStrokes = { strokes: [], labels: [{ text: "Here", x: 0.5, y: 0.5 }] };

  it("annotationHasContent covers strokes, labels, both, and neither", () => {
    expect(annotationHasContent(null)).toBe(false);
    expect(annotationHasContent({ strokes: [] })).toBe(false);
    expect(annotationHasContent({ strokes: [stroke] })).toBe(true);   // old-shape doc: no labels field
    expect(annotationHasContent(labelsOnly)).toBe(true);
    expect(annotationHasContent(labeled)).toBe(true);
  });

  it("labels survive a persistence round-trip (and their absence is preserved)", () => {
    const { doc, v } = seed();
    const withLabels = addComment(doc, { versionId: v, timeStart: 3, body: "x", author: "Me", annotation: labeled }, 10);
    const oldShape = addComment(doc, { versionId: v, timeStart: 3, body: "y", author: "Me", annotation: { strokes: [stroke] } }, 10);
    const rt = (d: ReviewDoc) => JSON.parse(JSON.stringify(d)) as ReviewDoc;
    expect(rt(withLabels).comments[0].annotation?.labels).toEqual([{ text: "Fix this", x: 0.25, y: 0.75 }]);
    // Old docs never grow a labels field just by passing through ops.
    const edited = editComment(rt(oldShape), oldShape.comments[0].id, "y2", 20);
    expect("labels" in (edited.comments[0].annotation ?? {})).toBe(false);
  });

  it("labels ride the co-review add op and doc merge untouched", () => {
    const { doc, v } = seed();
    const c = buildComment({ versionId: v, timeStart: 1, body: "note", author: "A", annotation: labeled }, 10);
    // Op relay serializes the comment as opaque JSON — simulate the wire.
    const wire = JSON.parse(JSON.stringify({ t: "add", comment: c }));
    const applied = applyReviewOp(doc, wire);
    expect(applied.comments[0].annotation).toEqual(labeled);
    // Snapshot merge keeps the labeled comment whole.
    const merged = mergeReviewDoc(applied, doc);
    expect(merged.comments[0].annotation?.labels).toHaveLength(1);
  });

  it("annotationsOf includes labels-only annotations and carries the author", () => {
    const { doc, v } = seed();
    const d = addComment(doc, { versionId: v, timeStart: 7, body: "", author: "Sam", annotation: labelsOnly }, 10);
    const anns = annotationsOf(d, v);
    expect(anns).toHaveLength(1);
    expect(anns[0].author).toBe("Sam");
    expect(anns[0].strokes.labels?.[0].text).toBe("Here");
  });

  it("labelSuffix renders every label; empty without any", () => {
    const { doc, v } = seed();
    const many: AnnotationStrokes = { strokes: [], labels: [{ text: "One", x: 0, y: 0 }, { text: "Two", x: 1, y: 1 }] };
    const d = addComment(doc, { versionId: v, timeStart: 1, body: "b", author: "Me", annotation: many }, 1);
    expect(labelSuffix(d.comments[0])).toBe(' [label: "One"] [label: "Two"]');
    const plain = addComment(doc, { versionId: v, timeStart: 1, body: "b", author: "Me" }, 1);
    expect(labelSuffix(plain.comments[0])).toBe("");
  });

  it("labels appear in the Markdown / CSV / EDL exports, escaped per format", () => {
    const { doc, v } = seed();
    const ann: AnnotationStrokes = { strokes: [], labels: [{ text: 'Trim [here] "now"', x: 0.5, y: 0.5 }] };
    const d = addComment(doc, { versionId: v, timeStart: 5, body: "intro", author: "Me", annotation: ann }, 1);
    const md = reviewToMarkdown(d, "T");
    expect(md).toContain('intro [label: "Trim \\[here\\] "now""]'); // md-escaped brackets
  });
});

describe("sort + selectors", () => {
  it("sorts by time / newest / oldest", () => {
    const { doc, v } = seed();
    let d = addComment(doc, { versionId: v, timeStart: 30, body: "late", author: "Me" }, 100);
    d = addComment(d, { versionId: v, timeStart: 5, body: "early", author: "Me" }, 200);
    expect(rootComments(d, v, "time").map((c) => c.body)).toEqual(["early", "late"]);
    expect(sortComments(rootComments(d, v), "newest").map((c) => c.body)).toEqual(["early", "late"]);
    expect(sortComments(rootComments(d, v), "oldest").map((c) => c.body)).toEqual(["late", "early"]);
  });
  it("markers + open count track unresolved root comments", () => {
    const { doc, v } = seed();
    let d = addComment(doc, { versionId: v, timeStart: 5, body: "x", author: "Me" }, 1);
    d = addComment(d, { versionId: v, timeStart: 9, body: "y", author: "Me" }, 2);
    expect(commentMarkers(d, v)).toHaveLength(2);
    expect(openCount(d, v)).toBe(2);
    d = toggleResolved(d, d.comments[0].id);
    expect(openCount(d, v)).toBe(1);
    expect(commentMarkers(d, v).find((m) => m.id === d.comments[0].id)?.resolved).toBe(true);
  });
});

describe("approval status", () => {
  it("defaults to pending; round-trips state + note", () => {
    const { doc, v } = seed();
    expect(statusOf(doc, v).state).toBe("pending");
    const d = setStatus(doc, v, "changes", "fix audio at 0:12", 500);
    expect(statusOf(d, v)).toMatchObject({ state: "changes", note: "fix audio at 0:12" });
    expect(statusOf(setStatus(d, v, "approved"), v).state).toBe("approved");
  });

  it("status op sets + overrides with LWW (stale op skipped)", () => {
    const { doc, v } = seed();
    const d1 = applyReviewOp(doc, { t: "status", versionId: v, state: "approved", reviewer: "Nika", at: 100 });
    expect(statusOf(d1, v)).toMatchObject({ state: "approved", reviewer: "Nika" });
    const d2 = applyReviewOp(d1, { t: "status", versionId: v, state: "changes", reviewer: "Ada", at: 200 });
    expect(statusOf(d2, v)).toMatchObject({ state: "changes", reviewer: "Ada" });
    // Late-arriving stale op loses.
    const d3 = applyReviewOp(d2, { t: "status", versionId: v, state: "approved", reviewer: "Nika", at: 150 });
    expect(statusOf(d3, v).state).toBe("changes");
  });

  it("undo inverse restores the prior verdict, reviewer included", () => {
    const { doc, v } = seed();
    const before = applyReviewOp(doc, { t: "status", versionId: v, state: "changes", reviewer: "Ada", at: 100 });
    const op = { t: "status" as const, versionId: v, state: "approved" as const, reviewer: "Nika", at: 200 };
    const after = applyReviewOp(before, op);
    const inv = inverseReviewOps(before, op, 300);
    const undone = inv.reduce(applyReviewOp, after);
    expect(statusOf(undone, v)).toMatchObject({ state: "changes", reviewer: "Ada" });
  });

  it("merge keeps the NEWER verdict per version from either side", () => {
    const { doc, v } = seed();
    const local = applyReviewOp(doc, { t: "status", versionId: v, state: "approved", reviewer: "Nika", at: 500 });
    const incoming = applyReviewOp(doc, { t: "status", versionId: v, state: "changes", reviewer: "Ada", at: 300 });
    expect(statusOf(mergeReviewDoc(local, incoming), v)).toMatchObject({ state: "approved", reviewer: "Nika" });
    expect(statusOf(mergeReviewDoc(incoming, local), v)).toMatchObject({ state: "approved", reviewer: "Nika" });
  });
});

describe("export", () => {
  function withComments(): ReviewDoc {
    const { doc, v } = seed();
    let d = setStatus(doc, v, "changes", "needs work", 1);
    d = addComment(d, { versionId: v, timeStart: 65, body: "tighten, says \"cut\"\nhere", author: "Me" }, 2);
    d = addComment(d, { versionId: v, timeStart: 5, body: "intro too long", author: "Me" }, 3);
    return d;
  }
  it("markdown lists comments by time + status", () => {
    const md = reviewToMarkdown(withComments(), "My Clip");
    expect(md).toContain("# Review — My Clip");
    expect(md).toContain("Changes requested — needs work");
    expect(md.indexOf("intro too long")).toBeLessThan(md.indexOf("tighten")); // time-sorted
    expect(md).toContain("[00:00:05]");
  });
});

describe("emoji reactions", () => {
  it("sets and clears a non-thumbs emoji; chips read via reactionsOf", () => {
    const { doc, v } = seed();
    const d = addComment(doc, { versionId: v, timeStart: 1, body: "n", author: "Me" }, 1);
    const id = d.comments[0].id;
    const on = setLike(d, id, "Sam", true, "🎉");
    expect(reactionsOf(on.comments[0])["🎉"]).toEqual(["Sam"]);
    const off = setLike(on, id, "Sam", false, "🎉");
    expect(reactionsOf(off.comments[0])["🎉"]).toBeUndefined();
  });
  it("legacy likes fold into the 👍 chip and un-react cleanly", () => {
    const { doc, v } = seed();
    const d = addComment(doc, { versionId: v, timeStart: 1, body: "n", author: "Me" }, 1);
    const legacy = { ...d, comments: d.comments.map((c) => ({ ...c, likes: ["Old"] })) };
    expect(reactionsOf(legacy.comments[0])["👍"]).toEqual(["Old"]);
    const off = setLike(legacy, legacy.comments[0].id, "Old", false);
    expect(reactionsOf(off.comments[0])["👍"] ?? []).toEqual([]);
  });
  it("mergeReviewDoc unions reactions per emoji", () => {
    const { doc, v } = seed();
    const d = addComment(doc, { versionId: v, timeStart: 1, body: "n", author: "Me" }, 1);
    const id = d.comments[0].id;
    const a = setLike(d, id, "Sam", true, "❤️");
    const b = setLike(d, id, "Alex", true, "❤️");
    const merged = mergeReviewDoc(a, b);
    expect(reactionsOf(merged.comments[0])["❤️"]?.sort()).toEqual(["Alex", "Sam"]);
  });
});

describe("fingerprint index + history", () => {
  // The helpers persist via localStorage; the node test env has none, so shim
  // a tiny Map-backed store before each test.
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as Storage;
  });

  it("fingerprint is location-independent (filename + duration + dims + size)", () => {
    // A moved/renamed copy has the same intrinsic props (incl. byte size), so it
    // resolves to the same key regardless of path. Duration is matched to tenths.
    const a = reviewFingerprint("/Users/me/WING IT.mp4".split("/").pop()!, 237.98, 1920, 1080, 12_345_678);
    const b = reviewFingerprint("WING IT.mov".replace(".mov", ".mp4"), 238.0, 1920, 1080, 12_345_678);
    expect(a).toBe(b);
  });
  it("fingerprint disambiguates two same-length, same-dimension clips by byte size", () => {
    const a = reviewFingerprint("intro.mp4", 10, 1920, 1080, 5_000_000);
    const b = reviewFingerprint("intro.mp4", 10, 1920, 1080, 7_000_000);
    expect(a).not.toBe(b); // different content → different review, no collision
  });
  it("resolves a clip to its prior review key once linked", () => {
    const fp = reviewFingerprint("clip.mp4", 60, 1280, 720);
    expect(resolveByFingerprint(fp)).toBeNull();
    linkFingerprint(fp, "/original/path/clip.mp4");
    expect(resolveByFingerprint(fp)).toBe("/original/path/clip.mp4");
  });
  it("history upserts by key (newest first) and removes", () => {
    upsertReviewHistory({ key: "k1", title: "One", path: "/one.mp4", updatedAt: 10, count: 2 });
    upsertReviewHistory({ key: "k2", title: "Two", path: "/two.mp4", updatedAt: 20, count: 1 });
    upsertReviewHistory({ key: "k1", title: "One", path: "/one.mp4", updatedAt: 30, count: 5 }); // update
    const list = loadReviewHistory();
    expect(list.map((e) => e.key)).toEqual(["k1", "k2"]); // k1 newest after update
    expect(list[0].count).toBe(5);
    removeReviewHistory("k1");
    expect(loadReviewHistory().map((e) => e.key)).toEqual(["k2"]);
  });
  it("clearReviewHistory drops the whole list in one go", () => {
    upsertReviewHistory({ key: "k1", title: "One", path: "/one.mp4", updatedAt: 10, count: 2 });
    upsertReviewHistory({ key: "k2", title: "Two", path: "/two.mp4", updatedAt: 20, count: 1 });
    expect(loadReviewHistory()).toHaveLength(2);
    clearReviewHistory();
    expect(loadReviewHistory()).toEqual([]);
  });
});

describe("undo inverse ops (inverseReviewOps / restampReviewOp)", () => {
  const mk = (v: string, id: string, over: Partial<ReviewComment> = {}): ReviewComment =>
    ({ ...buildComment({ versionId: v, timeStart: 1, body: "hi", author: "A" }, 1000), id, ...over });

  it("add ⇄ del round-trips, preserving the original id + timestamps", () => {
    const { doc, v } = seed();
    const c = mk(v, "c1");
    const addOp = { t: "add", comment: c } as const;
    const after = applyReviewOp(doc, addOp);
    const undone = inverseReviewOps(doc, addOp, 2000).reduce(applyReviewOp, after);
    expect(undone.comments).toEqual(doc.comments);
    // redo replays the SAME comment object → identical row, no duplicate
    const redone = applyReviewOp(applyReviewOp(undone, addOp), addOp);
    expect(redone.comments).toHaveLength(1);
    expect(redone.comments[0]).toEqual(c); // id + createdAt/updatedAt intact
  });

  it("del of a root resurrects the root AND its replies (peer replies included)", () => {
    const { doc, v } = seed();
    const root = mk(v, "r1");
    const mine = mk(v, "p1", { parentId: "r1", author: "A" });
    const peers = mk(v, "p2", { parentId: "r1", author: "Peer" });
    let d = [root, mine, peers].reduce((acc, c) => insertComment(acc, c), doc);
    const delOp = { t: "del", id: "r1" } as const;
    const before = d;
    d = applyReviewOp(d, delOp);
    expect(d.comments).toHaveLength(0);
    const undone = inverseReviewOps(before, delOp, 5000).reduce(applyReviewOp, d);
    expect(undone.comments).toHaveLength(3);
    expect(undone.comments.find((c) => c.id === "p2")?.author).toBe("Peer");
  });

  it("delReply inverse re-adds just that reply; unknown reply → no ops", () => {
    const { doc, v } = seed();
    const root = mk(v, "r1");
    const reply = mk(v, "p1", { parentId: "r1" });
    const before = insertComment(insertComment(doc, root), reply);
    const op = { t: "delReply", versionId: v, commentId: "r1", replyId: "p1" } as const;
    const after = applyReviewOp(before, op);
    const undone = inverseReviewOps(before, op, 5000).reduce(applyReviewOp, after);
    expect(undone.comments).toEqual(expect.arrayContaining(before.comments));
    expect(undone.comments).toHaveLength(2);
    expect(inverseReviewOps(doc, op, 5000)).toEqual([]); // reply not in doc
  });

  it("edit inverse restores the old body — and a FRESH `at` beats the LWW guard", () => {
    const { doc, v } = seed();
    const before = insertComment(doc, mk(v, "c1", { body: "old" }));
    const editOp = { t: "edit", id: "c1", body: "new", at: 2000 } as const;
    const after = applyReviewOp(before, editOp);
    expect(after.comments[0].body).toBe("new");
    // Inverse stamped LATER than the edit → wins LWW and restores "old".
    const undone = inverseReviewOps(before, editOp, 3000).reduce(applyReviewOp, after);
    expect(undone.comments[0].body).toBe("old");
    // Redo must be re-stamped: the verbatim op (at=2000) would now LOSE.
    expect(applyReviewOp(undone, editOp).comments[0].body).toBe("old");
    const redone = applyReviewOp(undone, restampReviewOp(editOp, 4000));
    expect(redone.comments[0].body).toBe("new");
  });

  it("resolve inverse restores the doc's previous resolved state", () => {
    const { doc, v } = seed();
    const before = insertComment(doc, mk(v, "c1"));
    const op = { t: "resolve", id: "c1", resolved: true, at: 2000 } as const;
    const after = applyReviewOp(before, op);
    expect(after.comments[0].resolved).toBe(true);
    const inv = inverseReviewOps(before, op, 3000);
    expect(inv).toEqual([{ t: "resolve", id: "c1", resolved: false, at: 3000 }]);
    expect(applyReviewOp(after, inv[0]).comments[0].resolved).toBe(false);
  });

  it("editReply inverse addresses the reply through its full path", () => {
    const { doc, v } = seed();
    const root = mk(v, "r1");
    const reply = mk(v, "p1", { parentId: "r1", body: "old" });
    const before = insertComment(insertComment(doc, root), reply);
    const op = { t: "editReply", versionId: v, commentId: "r1", replyId: "p1", body: "new", at: 2000 } as const;
    const after = applyReviewOp(before, op);
    const undone = inverseReviewOps(before, op, 3000).reduce(applyReviewOp, after);
    expect(undone.comments.find((c) => c.id === "p1")?.body).toBe("old");
  });

  it("restampReviewOp only touches LWW ops", () => {
    const del = { t: "del", id: "x" } as const;
    expect(restampReviewOp(del, 9000)).toBe(del); // non-LWW → same object
    const res = restampReviewOp({ t: "resolve", id: "x", resolved: true, at: 1 }, 9000);
    expect(res).toEqual({ t: "resolve", id: "x", resolved: true, at: 9000 });
  });
});

describe("mergeReviewDoc across different sources", () => {
  const doc = (sourceKey: string, comments: ReviewComment[]): ReviewDoc => ({
    sourceKey, versions: [], activeVersionId: null, comments, status: {},
  });
  // Build through the real constructor so this test can't drift from the shape.
  const comment = (id: string, body: string): ReviewComment => ({
    ...buildComment({ versionId: "v1", timeStart: 1, body, author: "A" }),
    id,
  });

  it("refuses to fold one source's comments into another's document", () => {
    // The data-loss path: a session that switched sources used to end with
    // mergeReviewDoc(loadReview(A), docForB), which unioned B's comments into
    // A's file and restamped it with B's key.
    const a = doc("sourceA", [comment("a1", "about A")]);
    const b = doc("sourceB", [comment("b1", "about B")]);
    const merged = mergeReviewDoc(a, b);
    expect(merged.sourceKey).toBe("sourceB");
    expect(merged.comments.map((c) => c.id)).toEqual(["b1"]);
    expect(merged.comments.some((c) => c.id === "a1"),
      "A's comments must never appear in B's document").toBe(false);
  });

  it("still merges normally when both sides describe the same source", () => {
    const mine = doc("same", [comment("mine", "local only")]);
    const theirs = doc("same", [comment("theirs", "remote only")]);
    const merged = mergeReviewDoc(mine, theirs);
    expect(merged.sourceKey).toBe("same");
    expect(merged.comments.map((c) => c.id).sort()).toEqual(["mine", "theirs"]);
  });
});

describe("wire sanitization (sanitizeDocForWire)", () => {
  // The audit's regression contract: a serialized session broadcast must
  // never carry a host-local filesystem identity.
  const HOST_MARKERS = ["/Users/", "/Volumes/", "file://", "C:\\"];

  it("replaces a path sourceKey with the wire key and strips version paths", () => {
    const doc = emptyDoc("/Users/alice/Clients/Confidential Project/rough-cut.mov");
    const { doc: withV } = ensureVersion(doc, "/Volumes/RAID/Confidential Project/rough-cut.mov", "rough-cut.mov");
    const wired = sanitizeDocForWire(withV, "fp-1a2b3c4d");
    expect(wired.sourceKey).toBe("fp-1a2b3c4d");
    expect(wired.versions[0].path).toBe("");
    expect(wired.versions[0].id).toBe(withV.versions[0].id);     // shared identity survives
    expect(wired.versions[0].label).toBe(withV.versions[0].label);
    const serialized = JSON.stringify(wired);
    for (const marker of HOST_MARKERS) expect(serialized).not.toContain(marker);
  });

  it("passes web-keyed docs through untouched (the room is already watching the URL)", () => {
    const doc = emptyDoc("https://youtu.be/abc123");
    const { doc: withV } = ensureVersion(doc, "https://youtu.be/abc123", "V1");
    const wired = sanitizeDocForWire(withV, "fp-unused");
    expect(wired.sourceKey).toBe("https://youtu.be/abc123");
    expect(wired.versions[0].path).toBe("https://youtu.be/abc123");
  });

  it("never leaks the path even when no wire key exists yet", () => {
    const wired = sanitizeDocForWire(emptyDoc("/Users/alice/cut.mov"), null);
    expect(JSON.stringify(wired)).not.toContain("/Users/");
  });

  it("does not mutate the host's copy", () => {
    const doc = emptyDoc("/Users/alice/cut.mov");
    const { doc: withV } = ensureVersion(doc, "/Users/alice/cut.mov");
    sanitizeDocForWire(withV, "fp-x");
    expect(withV.sourceKey).toBe("/Users/alice/cut.mov"); // sessionDoc keeps the real key
    expect(withV.versions[0].path).toBe("/Users/alice/cut.mov");
  });
});

describe("attributeReviewOp — a peer cannot sign as somebody else (r148)", () => {
  const stolen = { t: "status" as const, versionId: "v1", state: "approved" as const, reviewer: "Gasper", at: 100 };

  it("rewrites a forged verdict to whoever the host says sent it", () => {
    // The hole: ReviewOp names its own author and the relay is payload
    // agnostic, so a guest could stamp the source-level verdict as the host.
    const fixed = attributeReviewOp(stolen, "Nika");
    expect(fixed).toMatchObject({ t: "status", reviewer: "Nika", state: "approved" });
  });

  it("rewrites a forged comment author and a forged reaction", () => {
    const comment = {
      id: "c1", versionId: "v1", parentId: null, timeStart: 1, timeEnd: null,
      body: "ship it", resolved: false, author: "Gasper",
      createdAt: 1, updatedAt: 1, annotation: null,
    };
    expect(attributeReviewOp({ t: "add", comment }, "Nika"))
      .toMatchObject({ comment: { author: "Nika", body: "ship it" } });
    expect(attributeReviewOp({ t: "like", id: "c1", name: "Gasper", liked: true }, "Nika"))
      .toMatchObject({ name: "Nika" });
  });

  it("leaves an honest op untouched (same object, no churn)", () => {
    const honest = { ...stolen, reviewer: "Nika" };
    expect(attributeReviewOp(honest, "Nika")).toBe(honest);
  });

  it("leaves an UNSTAMPED op alone rather than dropping the sender's work", () => {
    // An older peer sends no `from`. Unattributed is not forged; discarding
    // it would silently lose that person's notes.
    expect(attributeReviewOp(stolen, "")).toBe(stolen);
  });

  it("passes through ops that carry no identity at all", () => {
    const edit = { t: "edit" as const, id: "c1", body: "x", at: 5 };
    const del = { t: "del" as const, id: "c1" };
    expect(attributeReviewOp(edit, "Nika")).toBe(edit);
    expect(attributeReviewOp(del, "Nika")).toBe(del);
  });
});
