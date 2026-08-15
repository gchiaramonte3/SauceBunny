import { describe, expect, it } from "vitest";
import { panelSnapshotsEqual, type PanelSnapshot } from "./use-panel-bus";

/**
 * The publish gate must notice every field it carries.
 *
 * `panelSnapshotsEqual` runs on every App render and decides whether the
 * floating panel hears about a change at all. Its own comment carries the rule
 * that keeps it honest: "Adding a field to PanelSnapshot? Compare it here too,
 * or the panel won't hear about changes to it."
 *
 * A rule kept by a comment is a rule that drifts, and this one drifts SILENTLY.
 * Miss a field and there is no crash, no type error and no failing test - the
 * panel just quietly stops updating for that one thing, in the window the user
 * opened precisely because they wanted to watch it.
 *
 * Two halves, and both are needed:
 *
 *   · The fixture below is typed `PanelSnapshot`, so ADDING a field to the type
 *     breaks compilation here until someone fills it in. That is the forcing
 *     function; it puts a human in front of this file at the right moment.
 *   · The loop then perturbs every key of that fixture and demands the gate
 *     notices. That is what catches the field they filled in but forgot to
 *     compare.
 *
 * Written by reading the gate, not by watching it fail: type and comparison
 * were in agreement at 15 fields each when this went in. The point is the
 * sixteenth.
 */
const BASE: PanelSnapshot = {
  queue: [],
  fps: 24,
  running: false,
  hasFolder: false,
  transcriptPath: null,
  transcriptOrigin: "unknown",
  transcriptPlayhead: null,
  transcriptArrivedTick: 0,
  regenerateBusy: false,
  canRegenerate: false,
  hasSource: false,
  aiModelId: "qwen",
  aiStyle: { format: "bullets", length: "standard" },
  chapterSourceKey: null,
  durationSec: null,
};

/** A value of the same shape that is not the value it was given. */
function perturb(value: unknown): unknown {
  if (typeof value === "string") return `${value}-changed`;
  if (typeof value === "number") return value + 1;
  if (typeof value === "boolean") return !value;
  if (value === null) return "now set";
  // `queue` is compared by REFERENCE (App replaces it immutably), so a fresh
  // array is a genuine change even when it is empty.
  if (Array.isArray(value)) return [...value, undefined];
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const key = Object.keys(obj)[0];
    return { ...obj, [key]: perturb(obj[key]) };
  }
  throw new Error("perturb has no case for this field; add one rather than skipping it");
}

describe("panel snapshot publish gate", () => {
  it("treats an unchanged snapshot as unchanged", () => {
    expect(panelSnapshotsEqual(BASE, { ...BASE })).toBe(true);
    expect(panelSnapshotsEqual(BASE, BASE)).toBe(true);
  });

  it("notices a change to EVERY field it carries", () => {
    const missed: string[] = [];
    for (const key of Object.keys(BASE) as (keyof PanelSnapshot)[]) {
      const changed = { ...BASE, [key]: perturb(BASE[key]) } as PanelSnapshot;
      if (panelSnapshotsEqual(BASE, changed)) missed.push(key);
    }
    expect(
      missed,
      `panelSnapshotsEqual ignores these fields, so the panel will never hear ` +
        `about changes to them. Compare them in the gate.`,
    ).toEqual([]);
  });

  it("looks INSIDE aiStyle rather than comparing it by reference", () => {
    // A nested object compared with === would report every render as a change
    // if App rebuilds it, or miss a real edit if App mutates it. Both halves
    // are worth pinning.
    expect(panelSnapshotsEqual(BASE, { ...BASE, aiStyle: { ...BASE.aiStyle } })).toBe(true);
    expect(
      panelSnapshotsEqual(BASE, { ...BASE, aiStyle: { ...BASE.aiStyle, length: "brief" } }),
    ).toBe(false);
  });

  it("keeps the live playhead out of the gate's business", () => {
    // The 4 Hz clock rides its own `panel:playhead` event precisely so it
    // cannot drag the debounced snapshot publish along at 4 Hz with it. A
    // field named for the live clock appearing in PanelSnapshot would be the
    // signal that the two channels have been merged by accident.
    expect(Object.keys(BASE)).not.toContain("playhead");
    expect(Object.keys(BASE)).not.toContain("playheadSeconds");
    expect(Object.keys(BASE)).not.toContain("currentTime");
  });
});
