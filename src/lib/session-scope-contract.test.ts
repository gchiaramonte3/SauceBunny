import { describe, expect, it } from "vitest";
import { stampOpWithSession } from "../hooks/use-co-review";
import { newScreening, openSegment, closeScreening } from "./screening";
import type { ReviewComment, ReviewOp } from "./review";
import type { SessionSource } from "../hooks/use-co-review";

/**
 * THE ONE IDEA WORTH TAKING FROM THE W3C WEB ANNOTATION DATA MODEL.
 *
 * WADM's `scope` is the observation that "which context was this made in"
 * belongs on the annotation rather than being reconstructed later. A note here
 * already carries two clocks - timeStart is media time, createdAt is wall time
 * - and this is the third: which room, watching what.
 *
 * The vocabulary is NOT worth taking, and neither is anything else in the
 * spec. The fields this app's correctness depends on (reactedAt, the
 * millisecond `at`, resolved, the drawing tombstones and their (at, id) total
 * order) have no home in any JSON-LD context, and a conforming processor drops
 * unmapped terms on expand/compact - so a "portable" file would round-trip
 * through a real WADM tool having lost exactly the fields that make it
 * correct. Naming this `scope` instead of `sessionId` would buy nothing.
 *
 * THE DIRECTION IS THE DESIGN: the note points at the session; the session
 * never holds the note. Guarded below, because a second annotation model
 * growing inside the screening doc is the failure this whole shape exists to
 * prevent.
 */

const src = (url: string): SessionSource => ({
  kind: "web", url, fingerprint: null, title: "Cut A", duration: 120, reviewKey: url,
});

const comment = (id: string, parentId: string | null = null): ReviewComment => ({
  id, versionId: "v1", parentId, timeStart: 5, timeEnd: null,
  body: "hold on this frame", resolved: false, author: "Ada",
  createdAt: 1000, updatedAt: 1000, annotation: null,
});

const add = (c: ReviewComment): ReviewOp => ({ t: "add", comment: c });

describe("a note remembers which session it was made in", () => {
  it("stamps the session and the open segment", () => {
    let sc = newScreening("s-1", "Friday review", "host", 0);
    sc = openSegment(sc, src("https://a"), "keyA", 100);

    const out = stampOpWithSession(add(comment("c1")), sc);
    expect(out.t).toBe("add");
    if (out.t !== "add") return;
    expect(out.comment.sessionId).toBe("s-1");
    expect(out.comment.segmentId).toBe(sc.segments[0].id);
  });

  it("stamps a reply too", () => {
    // A reply's parent carries a session, but a reply can be written in a
    // LATER one - so inheriting from the parent would be wrong.
    let sc = newScreening("s-1", "R", "host", 0);
    sc = openSegment(sc, src("https://a"), "keyA", 100);
    const out = stampOpWithSession(add(comment("c2", "c1")), sc);
    if (out.t !== "add") return;
    expect(out.comment.sessionId).toBe("s-1");
  });

  it("names no segment once the room has stopped watching", () => {
    // A CLOSED segment is what the room used to be on. Reporting it would
    // claim the note was made against something that was no longer up.
    let sc = newScreening("s-1", "R", "host", 0);
    sc = openSegment(sc, src("https://a"), "keyA", 100);
    sc = closeScreening(sc, 200);
    const out = stampOpWithSession(add(comment("c1")), sc);
    if (out.t !== "add") return;
    expect(out.comment.sessionId, "the session is still a fact").toBe("s-1");
    expect(out.comment.segmentId).toBeUndefined();
  });

  it("leaves a solo note alone", () => {
    // No session, no stamp, and the SAME object back - solo editing is the
    // common path and must not allocate a copy of every comment.
    const op = add(comment("c1"));
    expect(stampOpWithSession(op, null)).toBe(op);
  });

  it("does not stamp anything that is not a creation", () => {
    // A stamp is a fact about when a note was WRITTEN. Applying one to an edit
    // or a relayed op invents that fact.
    let sc = newScreening("s-1", "R", "host", 0);
    sc = openSegment(sc, src("https://a"), "keyA", 100);
    const edit: ReviewOp = { t: "edit", id: "c1", body: "changed", at: 2000 };
    expect(stampOpWithSession(edit, sc)).toBe(edit);
  });
});

describe("the session record holds no note content", () => {
  it("carries ids and nothing else", () => {
    // THE ACID TEST, in structural form: opening a source solo, with no
    // screening file present, must still show every note made about it in a
    // session. That holds only while the screening is an INDEX - the moment a
    // body, a time or an author lands in here there are two copies of a note
    // and they can disagree.
    let sc = newScreening("s-1", "R", "host", 0);
    sc = openSegment(sc, src("https://a"), "keyA", 100);
    const json = JSON.stringify(sc);

    // CANARY: there is something in the record to inspect. An empty screening
    // trivially contains no comment body.
    expect(sc.segments.length).toBeGreaterThan(0);
    expect(json).not.toContain("hold on this frame");
    for (const seg of sc.segments) {
      expect(Object.keys(seg)).not.toContain("comments");
      expect(Object.keys(seg)).not.toContain("bodies");
    }
  });
});
