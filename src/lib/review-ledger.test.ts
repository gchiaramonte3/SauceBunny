import { describe, expect, it } from "vitest";
import {
  ALL_NOTES, buildLedger, inLens, lensCount, lensLabel, lensStillValid,
  screeningSourceKeys, type LedgerLens,
} from "./review-ledger";
import type { ReviewComment } from "./review";
import type { ScreeningDoc } from "./screening";

/**
 * The ledger's whole job is attribution, so these are mostly about WHICH
 * source of truth it believes. The peer case is the one that matters: it is
 * the difference between a complete list and a list of only your own notes
 * that looks complete.
 */

const KEY = "/Movies/cut.mov";

function note(id: string, over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id, versionId: "v1", parentId: null, timeStart: 0, timeEnd: null,
    body: id, resolved: false, author: "Ana", createdAt: 1000, updatedAt: 1000,
    annotation: null, ...over,
  };
}

function screening(id: string, over: Partial<ScreeningDoc> = {}): ScreeningDoc {
  return {
    id, title: `Session ${id}`, startedAt: 1000, endedAt: 2000, role: "host",
    participants: [{ name: "Ana", isHost: true, joinedAt: 1000, leftAt: 0 }],
    segments: [{
      id: `${id}-seg`, kind: "file", url: null, fingerprint: null,
      localSourceKey: KEY, title: "cut", duration: 60,
      startedAt: 1000, endedAt: 2000, commentIds: [], watched: true,
    }],
    ...over,
  };
}

/** A screening whose segment claims these comment ids. */
function withIds(id: string, ids: string[], startedAt = 1000): ScreeningDoc {
  const sc = screening(id, { startedAt });
  return { ...sc, segments: [{ ...sc.segments[0], commentIds: ids }] };
}

describe("buildLedger, attribution", () => {
  it("credits a PEER's note to the session, which sessionId alone cannot do", () => {
    // THE CASE THE DESIGN TURNS ON. Screening ids are machine-local, so a note
    // relayed from a peer carries THEIR id - one that matches no screening
    // here. Reading comment.sessionId would drop it and show a list that looks
    // complete, which is the worst possible way to be wrong.
    const mine = note("mine", { sessionId: "s1" });
    const theirs = note("theirs", { author: "Bo", sessionId: "THEIR-LOCAL-UUID" });
    const led = buildLedger([withIds("s1", ["mine", "theirs"])], KEY, [mine, theirs]);
    expect(led.sessions).toHaveLength(1);
    expect(
      [...led.sessions[0].commentIds].sort(),
      "a peer's note was not credited to the session it was made in",
    ).toEqual(["mine", "theirs"]);
    expect(led.soloIds.size, "a note in a session was also counted as solo").toBe(0);
  });

  it("falls back to sessionId for our own note the screening never recorded", () => {
    const c = note("c1", { sessionId: "s1" });
    const led = buildLedger([withIds("s1", [])], KEY, [c]);
    expect(led.sessions[0].commentIds.has("c1")).toBe(true);
    expect(led.soloIds.has("c1")).toBe(false);
  });

  it("puts notes made alone in the solo bucket, not in some session", () => {
    const led = buildLedger([withIds("s1", ["a"])], KEY, [note("a"), note("b")]);
    expect([...led.soloIds]).toEqual(["b"]);
  });

  it("shows every note under All when there are no screenings at all", () => {
    // The invariant the whole feature must not break: a source opened solo,
    // with no Screenings folder, still shows everything ever said about it.
    const notes = [note("a"), note("b"), note("c")];
    const led = buildLedger([], KEY, notes);
    expect(led.sessions).toEqual([]);
    expect(led.soloIds.size).toBe(3);
    for (const c of notes) expect(inLens(ALL_NOTES, led, c.id)).toBe(true);
  });

  it("ignores segments for a DIFFERENT source in the same session", () => {
    // One session commonly watches several clips. Only this one's notes are
    // this source's ledger.
    const sc = screening("s1");
    const multi: ScreeningDoc = {
      ...sc,
      segments: [
        { ...sc.segments[0], commentIds: ["mine"] },
        { ...sc.segments[0], id: "other", localSourceKey: "/Movies/other.mov", commentIds: ["elsewhere"] },
      ],
    };
    // Only THIS source's notes are in this source's doc - the other clip's
    // note lives in its own. So the question is whether the other segment's
    // ids can be pulled in here, and they must not be.
    const led = buildLedger([multi], KEY, [note("mine")]);
    expect(
      [...led.sessions[0].commentIds],
      "a segment for another clip contributed its ids to this source's ledger",
    ).toEqual(["mine"]);
  });

  it("drops ids the doc no longer holds, so a deleted note leaves no phantom", () => {
    const led = buildLedger([withIds("s1", ["a", "deleted"])], KEY, [note("a")]);
    expect(led.sessions[0].commentIds.size).toBe(1);
  });

  it("places a REPLY with its parent rather than in its own bucket", () => {
    const root = note("r1");
    const reply = note("rep", { parentId: "r1", sessionId: "s2" });
    const led = buildLedger([withIds("s1", ["r1"])], KEY, [root, reply]);
    expect(led.sessions[0].commentIds.has("rep")).toBe(false);
    expect(led.soloIds.has("rep"), "a reply was bucketed on its own").toBe(false);
  });

  it("keeps a session that watched the source and said nothing", () => {
    const led = buildLedger([withIds("s1", [])], KEY, []);
    expect(led.sessions, "a silent session vanished from the history").toHaveLength(1);
    expect(led.sessions[0].commentIds.size).toBe(0);
  });

  it("omits a session that never watched this source", () => {
    const sc = screening("s9");
    const elsewhere: ScreeningDoc = {
      ...sc,
      segments: [{ ...sc.segments[0], localSourceKey: "/Movies/other.mov" }],
    };
    expect(buildLedger([elsewhere], KEY, []).sessions).toEqual([]);
  });

  it("reads backwards: newest session first", () => {
    const led = buildLedger(
      [withIds("old", ["a"], 1000), withIds("new", ["b"], 9000), withIds("mid", ["c"], 5000)],
      KEY, [note("a"), note("b"), note("c")],
    );
    expect(led.sessions.map((s) => s.id)).toEqual(["new", "mid", "old"]);
  });
});

describe("the lens", () => {
  const led = buildLedger([withIds("s1", ["a", "b"], 9000), withIds("s2", ["c"], 1000)],
    KEY, [note("a"), note("b"), note("c"), note("solo")]);

  it("All shows everything, a session shows only its own", () => {
    expect(lensCount(ALL_NOTES, led, 4)).toBe(4);
    const s1: LedgerLens = { kind: "session", id: "s1" };
    expect(lensCount(s1, led, 4)).toBe(2);
    expect(inLens(s1, led, "a")).toBe(true);
    expect(inLens(s1, led, "c")).toBe(false);
    expect(inLens(s1, led, "solo")).toBe(false);
  });

  it("the solo lens shows only what was written alone", () => {
    const solo: LedgerLens = { kind: "solo" };
    expect(lensCount(solo, led, 4)).toBe(1);
    expect(inLens(solo, led, "solo")).toBe(true);
  });

  it("names itself from the session's own title", () => {
    expect(lensLabel(ALL_NOTES, led)).toBe("All notes");
    expect(lensLabel({ kind: "session", id: "s1" }, led)).toBe("Session s1");
    expect(lensLabel({ kind: "solo" }, led)).toBe("Outside a session");
  });

  it("reports a lens whose session is gone, rather than showing an empty list", () => {
    // Sessions load asynchronously and a doc can be re-keyed under the panel,
    // so a selected lens can outlive what it named. Silently empty would read
    // as "nothing was said", which is a different and wrong statement.
    expect(lensStillValid({ kind: "session", id: "s1" }, led)).toBe(true);
    expect(lensStillValid({ kind: "session", id: "gone" }, led)).toBe(false);
    expect(lensStillValid(ALL_NOTES, led)).toBe(true);
  });
});

describe("screeningSourceKeys", () => {
  it("lists each source once, so the index can skip a screening unread", () => {
    const sc = screening("s1");
    const multi: ScreeningDoc = {
      ...sc,
      segments: [
        sc.segments[0],
        { ...sc.segments[0], id: "b", localSourceKey: "/Movies/other.mov" },
        { ...sc.segments[0], id: "c" },
        { ...sc.segments[0], id: "d", localSourceKey: null },
      ],
    };
    expect(screeningSourceKeys(multi)).toEqual([KEY, "/Movies/other.mov"]);
  });
});
