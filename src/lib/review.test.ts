import { describe, it, expect, beforeEach } from "vitest";
import {
  emptyDoc, ensureVersion, setActiveVersion,
  addComment, editComment, deleteComment, toggleResolved, toggleLike,
  editReply, removeReply, ensureCommentIds,
  setStatus, statusOf, rootComments, repliesOf, sortComments,
  commentMarkers, openCount, reviewToMarkdown, reviewToCsv, reviewToEdl,
  reviewFingerprint, resolveByFingerprint, linkFingerprint,
  loadReviewHistory, upsertReviewHistory, removeReviewHistory, clearReviewHistory,
  buildComment, insertComment, setResolved, setLike, applyReviewOp, mergeReviewDoc,
  type ReviewDoc, type ReviewComment,
} from "./review";

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
    expect(l2.comments[0].likes).toEqual(["Sam"]); // no double-add
    expect(setLike(l2, "x1", "Sam", false).comments[0].likes).toEqual([]);
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
    expect(merged.comments[0].likes).toEqual(["Me"]);        // like survives (unioned)
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
    expect(setActiveVersion(next.doc, next.versionId).activeVersionId).toBe(next.versionId);
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
    expect(on.comments.find((c) => c.id === rootId)?.likes).toEqual(["Sam"]);
    const off = toggleLike(on, rootId, "Sam");
    expect(off.comments.find((c) => c.id === rootId)?.likes).toEqual([]);
  });
  it("collects multiple likers; toggling removes only that name", () => {
    const { d, rootId } = noted();
    let n = toggleLike(d, rootId, "Sam");
    n = toggleLike(n, rootId, "Alex");
    expect(n.comments.find((c) => c.id === rootId)?.likes).toEqual(["Sam", "Alex"]);
    n = toggleLike(n, rootId, "Sam");
    expect(n.comments.find((c) => c.id === rootId)?.likes).toEqual(["Alex"]);
  });
  it("likes a reply (flat array — same op); root untouched", () => {
    const { d, rootId, replyId } = noted();
    const n = toggleLike(d, replyId, "Sam");
    expect(repliesOf(n, rootId)[0].likes).toEqual(["Sam"]);
    expect(n.comments.find((c) => c.id === rootId)?.likes).toBeUndefined();
  });
  it("trims the name; empty names and unknown ids no-op", () => {
    const { d, rootId } = noted();
    const n = toggleLike(d, rootId, "  Sam  ");
    expect(n.comments.find((c) => c.id === rootId)?.likes).toEqual(["Sam"]);
    // The trimmed store means an untrimmed re-toggle still matches (removes).
    expect(toggleLike(n, rootId, "Sam ").comments.find((c) => c.id === rootId)?.likes).toEqual([]);
    expect(toggleLike(d, rootId, "   ")).toBe(d);
    expect(toggleLike(d, "nope", "Sam")).toBe(d);
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
  it("csv escapes quotes/newlines + uses SMPTE", () => {
    const csv = reviewToCsv(withComments(), 25);
    expect(csv.split("\n")[0]).toBe("Timecode,Resolved,Author,Comment");
    expect(csv).toContain("00:00:05:00");
    expect(csv).toContain('"tighten, says ""cut"" here"'); // quotes doubled, newline flattened
  });
  it("csv neutralizes formula-injection in author/comment cells", () => {
    const { doc, v } = seed();
    const d = addComment(doc, { versionId: v, timeStart: 1, body: '=HYPERLINK("http://evil","x")', author: "+ME" }, 1);
    const csv = reviewToCsv(d, 25);
    // Leading =/+ are forced to plain text with a single-quote prefix.
    expect(csv).toContain('"\'=HYPERLINK');
    expect(csv).toContain('"\'+ME"');
    expect(csv).not.toContain('"=HYPERLINK'); // never a bare formula leader
  });
  it("edl emits one numbered event + marker per comment", () => {
    const edl = reviewToEdl(withComments(), 25, "T");
    expect(edl).toContain("TITLE: T");
    expect(edl).toContain("001  AX");
    expect(edl).toContain("002  AX");
    expect(edl).toContain("|M:intro too long |D:1");
    expect(edl).toContain("|C:ResolveColorRed"); // unresolved
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
