// @vitest-environment jsdom
//
// jsdom, because the whole point is what survives when localStorage is wiped -
// and under the default node environment localStorage is a global that throws.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  linkFingerprint, rebuildFingerprintIndex, resolveByFingerprint,
  loadReview, saveReview,
} from "./review";
import { allReviewDocs, resetReviewStoreForTests } from "./review-store";

/**
 * THE NOTES WERE DURABLE; THE WAY BACK TO THEM WAS NOT. (docs/DATA-MODEL.md F6)
 *
 * A review doc is a real file in ~/Documents/Sauce Bunny/Reviews/, keyed by the
 * source PATH. Rename the source and the only thing that reconnects file to
 * notes is `resolveByFingerprint` - whose index lived only in localStorage:
 * evictable, clearable by the user, and never part of a backup of Documents.
 *
 * So the failure was quiet and complete. Every note still on disk, and the app
 * unable to find any of them for a source renamed since. Restoring Documents
 * did not help, because the map was never in Documents - the exact inverse of
 * that document's own placement rule.
 *
 * Measured before the fix: of 33 path-keyed entries in a real index, 8 pointed
 * at files that no longer existed, and NONE of the docs recorded a fingerprint,
 * because ReviewDoc had no field for one.
 */

beforeEach(() => { localStorage.clear(); resetReviewStoreForTests(); });
afterEach(() => { localStorage.clear(); });

describe("a review doc records how to find it again", () => {
  it("linking a fingerprint stamps the doc, not just the index", () => {
    saveReview(loadReview("/movies/cut.mov"));
    linkFingerprint("cut|1200|1920x1080", "/movies/cut.mov");

    const doc = loadReview("/movies/cut.mov");
    expect(doc.fingerprints, "the FILE must know its own fingerprint").toEqual(["cut|1200|1920x1080"]);
  });

  it("keeps every fingerprint a doc can be reached by", () => {
    // linkAsReviewVersion deliberately points several cuts of the same
    // material at one doc, and a fingerprint written before NFC normalisation
    // differs from today's for the same file. One value would drop the others.
    saveReview(loadReview("/movies/cut.mov"));
    linkFingerprint("a", "/movies/cut.mov");
    linkFingerprint("b", "/movies/cut.mov");
    expect(loadReview("/movies/cut.mov").fingerprints).toEqual(["a", "b"]);
  });

  it("does not conjure a doc for a source nobody has reviewed", () => {
    // CANARY. Stamping unconditionally would create an empty file per link,
    // and the shelf counts files.
    linkFingerprint("orphan", "/movies/never-opened.mov");
    expect([...allReviewDocs()].map((d) => d.sourceKey)).toEqual([]);
  });
});

describe("the folder can put the index back", () => {
  it("rebuilds links that localStorage lost", () => {
    saveReview(loadReview("/movies/cut.mov"));
    linkFingerprint("cut|1200|1920x1080", "/movies/cut.mov");
    expect(resolveByFingerprint("cut|1200|1920x1080")).toBe("/movies/cut.mov");

    // The failure this exists for: the docs survive, the index does not.
    localStorage.clear();
    expect(resolveByFingerprint("cut|1200|1920x1080"), "index really is gone").toBeNull();

    const added = rebuildFingerprintIndex(allReviewDocs());
    expect(added).toBe(1);
    expect(resolveByFingerprint("cut|1200|1920x1080"), "and the folder put it back")
      .toBe("/movies/cut.mov");
  });

  it("adds only - an existing link always wins", () => {
    // The index legitimately holds links no doc carries: entries written
    // before docs recorded fingerprints, and links made for docs that do not
    // exist yet. Treating the folder as authoritative would throw those away.
    saveReview(loadReview("/movies/cut.mov"));
    linkFingerprint("shared", "/movies/cut.mov");
    localStorage.clear();
    linkFingerprint("shared", "/movies/OTHER.mov"); // no doc; index-only

    const added = rebuildFingerprintIndex(allReviewDocs());
    expect(added, "nothing to add - the link already exists").toBe(0);
    expect(resolveByFingerprint("shared"), "the newer link is not clobbered")
      .toBe("/movies/OTHER.mov");
  });

  it("is a no-op when there is nothing to repair", () => {
    // CANARY for the case above: a rebuild that always writes would report
    // work it did not do, and would touch localStorage on every single boot.
    saveReview(loadReview("/movies/cut.mov"));
    linkFingerprint("cut", "/movies/cut.mov");
    expect(rebuildFingerprintIndex(allReviewDocs())).toBe(0);
  });

  it("ignores docs written before the field existed", () => {
    // Every doc on disk today. They must not break the walk.
    saveReview(loadReview("/movies/old.mov"));
    expect(loadReview("/movies/old.mov").fingerprints).toBeUndefined();
    expect(rebuildFingerprintIndex(allReviewDocs())).toBe(0);
  });
});
