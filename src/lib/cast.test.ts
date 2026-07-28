import { describe, expect, it } from "vitest";
import {
  applyAssignment, autoMatch, castFromSpeakers, foldName, MAX_AVATAR_BYTES,
  newCast, newMember, sanitizeCast, sanitizeCastFile, type Cast,
} from "./cast";

const cast = (members: [string, string][]): Cast =>
  newCast("Show", members.map(([n, c]) => newMember(n, c)));

describe("foldName", () => {
  it("treats spacing and case as noise, and nothing else", () => {
    expect(foldName("  Ada   Lovelace ")).toBe(foldName("ada lovelace"));
    expect(foldName("Ada")).not.toBe(foldName("Adam"));
    // Not punctuation-insensitive: "Dr. Ada" and "Dr Ada" are different
    // people until a human says otherwise. Guessing is the failure mode.
    expect(foldName("Dr. Ada")).not.toBe(foldName("Dr Ada"));
  });
});

describe("autoMatch", () => {
  const c = cast([["Ada", "#FD8A8C"], ["Basil", "#0AF2CD"]]);

  it("matches only on an exact folded name", () => {
    const got = autoMatch(c, [
      { tag: "S0", name: "  ADA ", talkSeconds: 90 },
      { tag: "S1", name: "Bas", talkSeconds: 40 },
    ]);
    expect(got.S0).toBe(c.members[0].id);
    // "Bas" is a plausible abbreviation of "Basil" and that is exactly why it
    // must not match: attributing dialogue on a guess is unrecoverable.
    expect(got.S1).toBeNull();
  });

  it("gives every unmatched speaker an explicit null, not a missing key", () => {
    // The picker renders one row per target; a hole would render as undefined.
    const got = autoMatch(c, [{ tag: "S9", name: "SPEAKER_09", talkSeconds: 3 }]);
    expect(Object.keys(got)).toEqual(["S9"]);
    expect(got.S9).toBeNull();
  });

  it("lets one member claim only one speaker, and the lead wins", () => {
    // Two speakers with the same name is an un-made merge. Assigning the cast
    // member to both would silently do the merge for them, in the export.
    const got = autoMatch(c, [
      { tag: "LEAD", name: "Ada", talkSeconds: 900 },
      { tag: "BIT", name: "Ada", talkSeconds: 4 },
    ]);
    expect(got.LEAD).toBe(c.members[0].id);
    expect(got.BIT).toBeNull();
  });

  it("ignores blank names on both sides", () => {
    const blanky = newCast("X", [newMember("", "#fff000")]);
    const got = autoMatch(blanky, [{ tag: "S0", name: "   ", talkSeconds: 1 }]);
    expect(got.S0).toBeNull();
  });
});

describe("applyAssignment", () => {
  const c = cast([["Ada", "#FD8A8C"], ["Basil", "#0AF2CD"]]);

  it("produces the name AND colour writes together", () => {
    const out = applyAssignment(c, { S0: c.members[0].id, S1: c.members[1].id });
    expect(out.names).toEqual({ S0: "Ada", S1: "Basil" });
    expect(out.colors).toEqual({ S0: "#FD8A8C", S1: "#0AF2CD" });
    expect(out.count).toBe(2);
  });

  it("writes nothing for a speaker left unassigned", () => {
    // "Leave alone" has to mean leave alone: an unassigned speaker keeps the
    // name and colour it already had, rather than being blanked.
    const out = applyAssignment(c, { S0: c.members[0].id, S1: null });
    expect(out.names).toEqual({ S0: "Ada" });
    expect("S1" in out.colors).toBe(false);
    expect(out.count).toBe(1);
  });

  it("survives an assignment pointing at a deleted member", () => {
    const out = applyAssignment(c, { S0: "gone-id" });
    expect(out.count).toBe(0);
  });
});

describe("castFromSpeakers", () => {
  it("captures the transcript you already named", () => {
    const built = castFromSpeakers("The Show", [
      { tag: "S0", name: "Ada", color: "#FD8A8C" },
      { tag: "S1", name: "Basil", color: "#0AF2CD" },
    ]);
    expect(built.name).toBe("The Show");
    expect(built.members.map((m) => m.name)).toEqual(["Ada", "Basil"]);
    expect(built.members.map((m) => m.color)).toEqual(["#FD8A8C", "#0AF2CD"]);
  });

  it("drops the untagged bucket and duplicate names", () => {
    const built = castFromSpeakers("X", [
      { tag: "N", name: "Unassigned", color: "#AAAD98", skip: true },
      { tag: "S0", name: "Ada", color: "#FD8A8C" },
      { tag: "S1", name: "ada", color: "#0AF2CD" },
      { tag: "S2", name: "  ", color: "#FBD509" },
    ]);
    expect(built.members.map((m) => m.name)).toEqual(["Ada"]);
  });
});

describe("sanitizeCast", () => {
  it("keeps a well-formed cast intact", () => {
    const c = cast([["Ada", "#FD8A8C"]]);
    expect(sanitizeCast(JSON.parse(JSON.stringify(c)))).toEqual(c);
  });

  it("rejects a nameless cast rather than inventing one", () => {
    expect(sanitizeCast({ id: "a", name: "   ", members: [] })).toBeNull();
    expect(sanitizeCast(null)).toBeNull();
    expect(sanitizeCast("cast")).toBeNull();
  });

  it("replaces a non-hex colour instead of writing it into the DOM", () => {
    const out = sanitizeCast({
      name: "X",
      members: [{ name: "Ada", color: "red; background: url(evil)" }],
    });
    expect(out!.members[0].color).toBe("#AAAD98");
  });

  it("drops a remote avatar URL", () => {
    // An http avatar would make opening the cast manager a network fetch, in
    // an app whose entire premise is that it makes none.
    const out = sanitizeCast({
      name: "X",
      members: [{ name: "Ada", color: "#FD8A8C", avatar: "https://example.com/a.jpg" }],
    });
    expect(out!.members[0].avatar).toBeNull();
  });

  it("drops an avatar over the size cap", () => {
    const big = "data:image/jpeg;base64," + "A".repeat(MAX_AVATAR_BYTES);
    const out = sanitizeCast({ name: "X", members: [{ name: "Ada", color: "#FD8A8C", avatar: big }] });
    expect(out!.members[0].avatar).toBeNull();
  });

  it("keeps an inline avatar within the cap", () => {
    const ok = "data:image/jpeg;base64,AAAA";
    const out = sanitizeCast({ name: "X", members: [{ name: "Ada", color: "#FD8A8C", avatar: ok }] });
    expect(out!.members[0].avatar).toBe(ok);
  });

  it("skips nameless members without dropping the cast", () => {
    const out = sanitizeCast({
      name: "X",
      members: [{ name: "", color: "#FD8A8C" }, { name: "Ada", color: "#FD8A8C" }],
    });
    expect(out!.members.map((m) => m.name)).toEqual(["Ada"]);
  });
});

describe("sanitizeCastFile", () => {
  it("returns an empty list for junk rather than throwing at boot", () => {
    for (const junk of [null, 42, "casts", {}, { casts: "nope" }, []]) {
      expect(sanitizeCastFile(junk)).toEqual([]);
    }
  });

  it("keeps the first of two casts sharing an id", () => {
    const got = sanitizeCastFile({
      casts: [
        { id: "dupe", name: "First", members: [] },
        { id: "dupe", name: "Second", members: [] },
      ],
    });
    expect(got.map((c) => c.name)).toEqual(["First"]);
  });

  it("drops the bad entries and keeps the good ones", () => {
    const got = sanitizeCastFile({ casts: [{ name: "" }, null, { id: "a", name: "Good", members: [] }] });
    expect(got.map((c) => c.name)).toEqual(["Good"]);
  });
});
