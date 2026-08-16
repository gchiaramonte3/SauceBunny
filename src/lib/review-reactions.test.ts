import { describe, expect, it } from "vitest";
import { mergeReviewDoc, reactionsOf, setLike, applyReviewOp, type ReviewDoc, type ReviewComment } from "./review";

/**
 * Un-reacting has to survive a merge.
 *
 * `mergeReviewDoc` unions reactions, and a union is a grow-only set: it can
 * represent "Ana reacted" but has no way to represent "Ana un-reacted". So the
 * removal is the one edit the merge silently discards, and it discards it
 * every time - the resurrected reaction is written back to disk, so the next
 * merge resurrects it again. Clicking the emoji again to take it off does not
 * help, because that removal is discarded the same way.
 *
 * The live session was never the problem: `like` is a SET op, so during a
 * session everyone lands on the same value. It is the reconcile at the edges -
 * a doc loaded from disk, a peer joining with an older copy, a session ending
 * against a file saved before the un-react - where union meets stale state.
 *
 * This is the same shape the file already solves for edits, resolves and
 * statuses: carry the time of the op and let the later one win. `like` was
 * simply the one mutation op that never carried its timestamp.
 */

const NOW = 1_700_000_000_000;

function comment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: "c1", versionId: "v1", parentId: null, timeStart: 1, timeEnd: null,
    body: "note", resolved: false, author: "Ana", createdAt: NOW, updatedAt: NOW,
    annotation: null, ...over,
  };
}

/** No cast: if ReviewDoc gains a required field, this stops compiling rather
 *  than quietly testing a shape the app never produces. */
function doc(comments: ReviewComment[]): ReviewDoc {
  return { sourceKey: "k", versions: [], activeVersionId: null, comments, status: {} };
}

describe("un-reacting survives a merge", () => {
  it("does not resurrect a reaction the user took off", () => {
    // Ana reacts, and that state reaches the other side.
    const reacted = setLike(doc([comment()]), "c1", "Ana", true, "👍", NOW);
    const peerCopy = structuredClone(reacted);

    // Ana takes it off. The peer's copy is now stale.
    const removed = setLike(reacted, "c1", "Ana", false, "👍", NOW + 1000);
    expect(reactionsOf(removed.comments[0])["👍"]).toBeUndefined();

    // Reconcile against the stale copy - the removal must hold.
    const merged = mergeReviewDoc(removed, peerCopy);
    expect(reactionsOf(merged.comments[0])["👍"] ?? []).not.toContain("Ana");
  });

  it("holds the removal no matter which side of the merge it is on", () => {
    const reacted = setLike(doc([comment()]), "c1", "Ana", true, "👍", NOW);
    const stale = structuredClone(reacted);
    const removed = setLike(reacted, "c1", "Ana", false, "👍", NOW + 1000);

    // Merge is called in both directions across the app; neither may resurrect.
    expect(reactionsOf(mergeReviewDoc(stale, removed).comments[0])["👍"] ?? []).not.toContain("Ana");
    expect(reactionsOf(mergeReviewDoc(removed, stale).comments[0])["👍"] ?? []).not.toContain("Ana");
  });

  it("stays removed when the merge runs again on its own output", () => {
    // The resurrected value used to be written back to disk, so the bug was
    // not a one-off flicker - it came back on every subsequent reconcile.
    const reacted = setLike(doc([comment()]), "c1", "Ana", true, "👍", NOW);
    const stale = structuredClone(reacted);
    const removed = setLike(reacted, "c1", "Ana", false, "👍", NOW + 1000);

    let merged = mergeReviewDoc(removed, stale);
    for (let i = 0; i < 3; i += 1) merged = mergeReviewDoc(merged, stale);
    expect(reactionsOf(merged.comments[0])["👍"] ?? []).not.toContain("Ana");
  });

  it("still unions concurrent reactions from different people", () => {
    // The union is RIGHT for adds - two people reacting at once must both
    // land. Only removal needed the extra information.
    const base = doc([comment()]);
    const ana = setLike(base, "c1", "Ana", true, "👍", NOW);
    const raj = setLike(base, "c1", "Raj", true, "👍", NOW + 5);
    const merged = mergeReviewDoc(ana, raj);
    expect(reactionsOf(merged.comments[0])["👍"]?.sort()).toEqual(["Ana", "Raj"]);
  });

  it("keeps one person's other emoji when they drop a different one", () => {
    let d = doc([comment()]);
    d = setLike(d, "c1", "Ana", true, "👍", NOW);
    d = setLike(d, "c1", "Ana", true, "🎯", NOW + 1);
    const stale = structuredClone(d);
    const dropped = setLike(d, "c1", "Ana", false, "👍", NOW + 1000);

    const merged = mergeReviewDoc(dropped, stale);
    expect(reactionsOf(merged.comments[0])["👍"] ?? []).not.toContain("Ana");
    expect(reactionsOf(merged.comments[0])["🎯"] ?? []).toContain("Ana");
  });

  it("breaks a same-millisecond collision the same way on both machines", () => {
    // Two peers, one clock tick, opposite ops. Whatever the rule is, both
    // sides must apply it identically or they diverge permanently. `on` wins,
    // matching how the relay breaks its other ties.
    const on = setLike(doc([comment()]), "c1", "Ana", true, "👍", NOW);
    const off = setLike(setLike(doc([comment()]), "c1", "Ana", true, "👍", NOW - 1),
      "c1", "Ana", false, "👍", NOW);
    const a = reactionsOf(mergeReviewDoc(on, off).comments[0])["👍"] ?? [];
    const b = reactionsOf(mergeReviewDoc(off, on).comments[0])["👍"] ?? [];
    expect(a).toEqual(b);
    expect(a).toContain("Ana");
  });

  it("lets a later re-react win over the removal", () => {
    // Off, then on again: the newest op is what counts, in both directions.
    const on1 = setLike(doc([comment()]), "c1", "Ana", true, "👍", NOW);
    const off = setLike(on1, "c1", "Ana", false, "👍", NOW + 10);
    const on2 = setLike(off, "c1", "Ana", true, "👍", NOW + 20);
    expect(reactionsOf(mergeReviewDoc(on2, off).comments[0])["👍"]).toContain("Ana");
    expect(reactionsOf(mergeReviewDoc(off, on2).comments[0])["👍"]).toContain("Ana");
  });
});

describe("the like op carries its time", () => {
  it("records when the reaction happened, like every other mutation op", () => {
    // edit / resolve / status all carry `at`. `like` was the only one that
    // did not, which is why the merge had nothing to compare.
    const d = applyReviewOp(doc([comment()]), { t: "like", id: "c1", name: "Ana", liked: true, emoji: "👍", at: NOW });
    const stale = structuredClone(d);
    const off = applyReviewOp(d, { t: "like", id: "c1", name: "Ana", liked: false, emoji: "👍", at: NOW + 1000 });
    expect(reactionsOf(mergeReviewDoc(off, stale).comments[0])["👍"] ?? []).not.toContain("Ana");
  });

  it("still applies an op from a peer that sends no timestamp", () => {
    // Older builds relay `like` without `at`. It must still react, rather
    // than being dropped for lacking a field it never had.
    const d = applyReviewOp(doc([comment()]), { t: "like", id: "c1", name: "Ana", liked: true, emoji: "👍" });
    expect(reactionsOf(d.comments[0])["👍"]).toContain("Ana");
  });
});

describe("docs written before any of this", () => {
  it("keeps unioning where it has no history to go on", () => {
    // A legacy doc records membership but not when it was set. Union is the
    // best available answer there, and is what shipped - no regression.
    const legacy = doc([comment({ reactions: { "👍": ["Ana"] } })]);
    const other = doc([comment({ reactions: { "👍": ["Raj"] } })]);
    expect(reactionsOf(mergeReviewDoc(legacy, other).comments[0])["👍"]?.sort()).toEqual(["Ana", "Raj"]);
  });

  it("lets a real removal beat a legacy doc that only knows membership", () => {
    // One side says "Ana un-reacted at T", the other just says "Ana is in the
    // list" with no idea when. The side that knows when is the newer fact.
    const legacy = doc([comment({ reactions: { "👍": ["Ana"] } })]);
    const removed = setLike(doc([comment({ reactions: { "👍": ["Ana"] } })]), "c1", "Ana", false, "👍", NOW + 1000);
    expect(reactionsOf(mergeReviewDoc(removed, legacy).comments[0])["👍"] ?? []).not.toContain("Ana");
  });

  it("still folds the legacy likes field in", () => {
    const old = doc([comment({ likes: ["Ana"] })]);
    expect(reactionsOf(old.comments[0])["👍"]).toEqual(["Ana"]);
  });
});
