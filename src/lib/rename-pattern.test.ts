import { describe, expect, it } from "vitest";
import { buildRenamePlan, expandPattern, extOf, stemOf, type RenameItem } from "./rename-pattern";

/**
 * Bulk rename is the one Library action that can destroy a day's work in a
 * single press, so every failure mode is decided here, before any IO exists to
 * get it wrong. A green preview that then overwrites a file is the outcome all
 * of this is written to prevent.
 */
const item = (path: string, extra: Partial<RenameItem> = {}): RenameItem => ({ path, ...extra });

describe("stemOf / extOf", () => {
  it("splits on the LAST dot", () => {
    expect(stemOf("a.b.mp4")).toBe("a.b");
    expect(extOf("a.b.mp4")).toBe("mp4");
  });

  it("treats a leading dot as a hidden file, not an extension", () => {
    // ".zshrc" has no extension. Splitting on the leading dot would rename it
    // to "" and produce a file with an empty stem.
    expect(stemOf(".zshrc")).toBe(".zshrc");
    expect(extOf(".zshrc")).toBe("");
  });

  it("handles a name with no dot at all", () => {
    expect(stemOf("README")).toBe("README");
    expect(extOf("README")).toBe("");
  });
});

describe("expandPattern", () => {
  const it0 = item("/m/Interview Final.mp4", { modifiedMs: Date.UTC(2026, 6, 4, 12), durationSec: 3725 });

  it("substitutes the tokens", () => {
    expect(expandPattern("{name}", it0, 0)).toBe("Interview Final");
    expect(expandPattern("{ext}", it0, 0)).toBe("mp4");
    expect(expandPattern("{counter}", it0, 4)).toBe("5");
  });

  it("pads the counter to the width asked for", () => {
    expect(expandPattern("{counter:03}", it0, 0)).toBe("001");
    expect(expandPattern("{counter:03}", it0, 41)).toBe("042");
    // A number wider than the padding is not truncated.
    expect(expandPattern("{counter:2}", it0, 999)).toBe("1000");
  });

  it("renders duration without colons, because a filename cannot hold them", () => {
    expect(expandPattern("{duration}", it0, 0)).toBe("1-02-05");
  });

  it("renders unknown values as empty rather than as 'undefined' or 'NaN'", () => {
    const bare = item("/m/x.mp4");
    expect(expandPattern("{date}", bare, 0)).toBe("");
    expect(expandPattern("{duration}", bare, 0)).toBe("");
    expect(expandPattern("{duration}", item("/m/x.mp4", { durationSec: Number.NaN }), 0)).toBe("");
  });

  it("leaves an unrecognised token literal so a typo is visible", () => {
    // Silently dropping it would show a plausible-looking name in the preview
    // and quietly lose whatever the user meant.
    expect(expandPattern("{nmae} v2", it0, 0)).toBe("{nmae} v2");
  });

  it("combines tokens with literal text", () => {
    expect(expandPattern("{name} - {counter:02}", it0, 2)).toBe("Interview Final - 03");
  });
});

describe("buildRenamePlan — the extension", () => {
  it("preserves it when the pattern does not mention one", () => {
    // Losing the extension on a bulk rename is how a folder of video becomes
    // unopenable.
    const p = buildRenamePlan([item("/m/a.mp4")], "Take {counter}");
    expect(p.rows[0].to).toBe("Take 1.mp4");
  });

  it("does not double it when the pattern already ends in one", () => {
    const p = buildRenamePlan([item("/m/a.mp4")], "{name}.mp4");
    expect(p.rows[0].to).toBe("a.mp4");
  });

  it("matches the existing extension case-insensitively", () => {
    const p = buildRenamePlan([item("/m/a.MP4")], "{name}.mp4");
    expect(p.rows[0].to).toBe("a.mp4");
  });
});

describe("buildRenamePlan — collisions", () => {
  it("catches two rows landing on the same name", () => {
    const p = buildRenamePlan([item("/m/a.mp4"), item("/m/b.mp4")], "Same");
    expect(p.rows[0].problem).toBeNull();
    expect(p.rows[1].problem).toMatch(/row 1/);
    expect(p.ok).toBe(false);
  });

  it("catches a collision that differs only by CASE", () => {
    // APFS and HFS+ are case-insensitive by default, so these are one file.
    // Comparing case-sensitively would call this batch clean and then let the
    // second write clobber the first.
    const p = buildRenamePlan([item("/m/a.mp4"), item("/m/b.mp4")], "{name}");
    expect(p.ok).toBe(true); // sanity: distinct stems are fine
    const clash = buildRenamePlan([item("/m/Interview.mp4"), item("/m/interview.mp4")], "Interview");
    expect(clash.rows[1].problem).toMatch(/row 1/);
  });

  it("does NOT flag the same name in a different folder", () => {
    const p = buildRenamePlan([item("/one/a.mp4"), item("/two/b.mp4")], "Take 1");
    expect(p.ok).toBe(true);
  });

  it("catches a collision with a file that was never selected", () => {
    // Without the existing-names list the preview stays green right up until
    // the write fails or overwrites something outside the batch.
    const p = buildRenamePlan([item("/m/a.mp4")], "Archive", ["/m/Archive.mp4"]);
    expect(p.rows[0].problem).toMatch(/already exists/);
  });

  it("lets a row keep its own name", () => {
    // Renaming A to A is a no-op, not a collision with itself.
    const p = buildRenamePlan([item("/m/Keep.mp4")], "{name}", ["/m/Keep.mp4"]);
    expect(p.rows[0].problem).toBeNull();
    expect(p.changed).toBe(0);
  });
});

describe("buildRenamePlan — illegal names", () => {
  it("rejects the two characters macOS will not take", () => {
    // ':' looks legal and is not. Finder displays it as '/', so the name on
    // screen would not be the name on disk.
    expect(buildRenamePlan([item("/m/a.mp4")], "a/b").rows[0].problem).toMatch(/\/ or :/);
    expect(buildRenamePlan([item("/m/a.mp4")], "a:b").rows[0].problem).toMatch(/\/ or :/);
  });

  it("ALLOWS spaces and hyphens, which are ordinary in real filenames", () => {
    // Guarding the guard: an over-broad illegal set would reject
    // "Interview Final-v2", which is what people actually type.
    const p = buildRenamePlan([item("/m/a.mp4")], "Interview Final-v2");
    expect(p.rows[0].problem).toBeNull();
    expect(p.rows[0].to).toBe("Interview Final-v2.mp4");
  });

  it("rejects an empty result", () => {
    expect(buildRenamePlan([item("/m/a.mp4")], "").rows[0].problem).toMatch(/empty/i);
    expect(buildRenamePlan([item("/m/a.mp4")], "   ").rows[0].problem).toMatch(/empty/i);
    // A pattern of only an unknown-value token also produces nothing.
    expect(buildRenamePlan([item("/m/a.mp4")], "{date}").rows[0].problem).toMatch(/empty/i);
  });

  it("rejects a name that would hide the file", () => {
    expect(buildRenamePlan([item("/m/a.mp4")], ".hidden").rows[0].problem).toMatch(/dot/i);
  });

  it("rejects a name past the filesystem limit", () => {
    expect(buildRenamePlan([item("/m/a.mp4")], "x".repeat(300)).rows[0].problem).toMatch(/too long/i);
  });
});

describe("buildRenamePlan — the summary the UI acts on", () => {
  it("is not ok when ANY row has a problem, so apply stays all-or-nothing", () => {
    const p = buildRenamePlan([item("/m/a.mp4"), item("/m/b.mp4")], "Same");
    expect(p.ok).toBe(false);
    expect(p.rows.filter((r) => r.problem === null)).toHaveLength(1);
  });

  it("is not ok for an empty selection", () => {
    expect(buildRenamePlan([], "{name}").ok).toBe(false);
  });

  it("counts only rows that actually change", () => {
    const p = buildRenamePlan([item("/m/a.mp4"), item("/m/b.mp4")], "{name}");
    expect(p.ok).toBe(true);
    expect(p.changed).toBe(0);
  });

  it("counts a case-only rename as a change", () => {
    // The filesystem is case-INSENSITIVE but case-PRESERVING, so this is a real
    // edit the user asked for and expects to see happen.
    const p = buildRenamePlan([item("/m/interview.mp4")], "Interview");
    expect(p.rows[0].to).toBe("Interview.mp4");
    expect(p.changed).toBe(1);
  });

  it("keeps rows aligned to the input, so the preview table can zip them", () => {
    const items = [item("/m/a.mp4"), item("/m/b.mp4"), item("/m/c.mp4")];
    const p = buildRenamePlan(items, "{name} {counter}");
    expect(p.rows.map((r) => r.path)).toEqual(items.map((i) => i.path));
    expect(p.rows.map((r) => r.to)).toEqual(["a 1.mp4", "b 2.mp4", "c 3.mp4"]);
  });
});
