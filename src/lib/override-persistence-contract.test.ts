import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * FIVE OF EIGHT, GUARDING A DELETE.
 *
 * `SpeakerOverrides` has eight sub-maps: global, turn, aliases, colors,
 * turnTag, cueTag, icons, splits. TranscriptViewer decided whether the whole
 * object was empty with a hand-listed disjunction over FIVE of them, and the
 * branch that emptiness guards calls `localStorage.removeItem`.
 *
 * So a user whose only edit was a per-cue reassignment - `cueTag`, the layer
 * that exists to separate two people the diarizer merged, and the single most
 * worthwhile speaker edit there is - was measured as having changed nothing,
 * and their overrides were DELETED from disk. Not "failed to save": removed.
 * Same for speaker icons, and for cue splits.
 *
 * The fix derives the check from the object, so a ninth sub-map is free. This
 * pins that it stays derived, because the failure mode of the hand-listed
 * version is silent, destructive, and exactly what happened.
 */

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("emptiness is derived from the shape, not listed by hand", () => {
  const viewer = read("src/components/TranscriptViewer.tsx");
  const helpers = read("src/components/transcript/helpers.tsx");

  it("knows how many sub-maps there are", () => {
    // CANARY: if this stops finding the type, every assertion below is vacuous.
    const block = /export type SpeakerOverrides = \{([\s\S]*?)\n\};/.exec(helpers);
    expect(block, "SpeakerOverrides not found").toBeTruthy();
    const fields = [...(block?.[1] ?? "").matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
    expect(fields.length, "fewer fields than expected").toBeGreaterThanOrEqual(8);
  });

  it("does not test the sub-maps one by one", () => {
    // The exact shape of the bug: `Object.keys(overrides.X).length === 0 && …`
    // repeated per field, which goes stale the moment a field is added and
    // takes a removeItem with it.
    const perField = [...viewer.matchAll(/Object\.keys\(overrides\.\w+\)\.length === 0/g)];
    expect(perField.map((m) => m[0]), "emptiness is hand-listed again").toEqual([]);
  });

  it("derives it over every value instead", () => {
    expect(viewer, "the derived emptiness check is gone")
      .toMatch(/Object\.values\(overrides\)\.every\(/);
  });

  it("reports a failed write rather than swallowing it", () => {
    // This write is the one that actually persists speaker renames, and it
    // bypassed saveJson - so it bypassed the notification path built for
    // exactly this family.
    const at = viewer.indexOf("localStorage.setItem(storageKey");
    expect(at, "the overrides write is gone").toBeGreaterThan(-1);
    const after = viewer.slice(at, at + 400);
    expect(after, "the overrides write still swallows its failure")
      .toMatch(/reportStorageProblem\(/);
  });
});
