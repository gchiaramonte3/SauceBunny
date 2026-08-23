import { describe, expect, it } from "vitest";
import { mergeCasts } from "./cast-merge";
import type { Cast } from "./cast";

const cast = (id: string, updatedAt: number, name = id): Cast =>
  ({ id, name, updatedAt, members: [] });

const T = (...pairs: [string, number][]) => new Map(pairs);

describe("mergeCasts", () => {
  it("keeps a cast the other window added while we were not looking", () => {
    // THE bug. Both windows hold their own list and wrote the whole file, so
    // whichever saved last erased the other's additions.
    const disk = [cast("theirs", 200), cast("mine", 100)];
    const local = [cast("mine", 100)];           // we never saw "theirs"
    const out = mergeCasts(disk, local, T(["mine", 100]), T());
    expect(out.map((c) => c.id).sort(), "the other window's cast was erased")
      .toEqual(["mine", "theirs"]);
  });

  it("our edit wins over the disk copy of the same cast", () => {
    const disk = [cast("a", 100, "old name")];
    const local = [cast("a", 300, "new name")];
    const out = mergeCasts(disk, local, T(["a", 300]), T());
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("new name");
  });

  it("does not resurrect a cast we deleted", () => {
    // A blind union would bring it straight back on the next merge.
    const disk = [cast("gone", 100)];
    const out = mergeCasts(disk, [], T(), T(["gone", 200]));
    expect(out).toEqual([]);
  });

  it("lets the other window's LATER edit beat our delete", () => {
    // Deleting and then someone renaming it elsewhere: the rename is newer
    // intent, so the cast survives. Losing it would be the same clobber in
    // the other direction.
    const disk = [cast("x", 500, "renamed over there")];
    const out = mergeCasts(disk, [], T(), T(["x", 200]));
    expect(out.map((c) => c.id)).toEqual(["x"]);
    expect(out[0].name).toBe("renamed over there");
  });

  it("does not carry our own untouched stale copy over a newer disk one", () => {
    // We loaded "a" at boot and never edited it; the other window has since
    // renamed it. Ours is stale and must not win.
    const disk = [cast("a", 900, "their rename")];
    const local = [cast("a", 100, "what we booted with")];
    const out = mergeCasts(disk, local, T(), T());
    expect(out[0].name).toBe("their rename");
  });

  it("returns newest first, which is the order the picker shows", () => {
    const out = mergeCasts(
      [cast("old", 100), cast("new", 900), cast("mid", 500)], [], T(), T(),
    );
    expect(out.map((c) => c.id)).toEqual(["new", "mid", "old"]);
  });

  it("is a plain pass-through when the disk is empty and nothing was deleted", () => {
    const local = [cast("a", 100)];
    expect(mergeCasts([], local, T(["a", 100]), T())).toEqual(local);
  });

  it("survives an empty everything", () => {
    expect(mergeCasts([], [], T(), T())).toEqual([]);
  });
});
