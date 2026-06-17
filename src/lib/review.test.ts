import { describe, it, expect, beforeEach } from "vitest";
import {
  emptyDoc, ensureVersion, setActiveVersion,
  addComment, editComment, deleteComment, toggleResolved,
  setStatus, statusOf, rootComments, repliesOf, sortComments,
  commentMarkers, openCount, reviewToMarkdown, reviewToCsv, reviewToEdl,
  reviewFingerprint, resolveByFingerprint, linkFingerprint,
  loadReviewHistory, upsertReviewHistory, removeReviewHistory, type ReviewDoc,
} from "./review";

function seed(): { doc: ReviewDoc; v: string } {
  const r = ensureVersion(emptyDoc("/clip.mp4"), "/clip.mp4", "V1", 1000);
  return { doc: r.doc, v: r.versionId };
}

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
});
