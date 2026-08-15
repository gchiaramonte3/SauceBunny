import { describe, expect, it } from "vitest";
import { coercePanelSnapshot, panelSnapshotsEqual, type PanelSnapshot } from "./use-panel-bus";

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

const BASE_DEFAULTS = coercePanelSnapshot({});

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

/**
 * The panel seeds its FIRST render from localStorage, before any event can
 * arrive. The hazard is not corrupt JSON - the try/catch around the read
 * handles that - it is a structurally valid object written by an older build,
 * which parses fine and then throws inside a child that reads `.format` or
 * `.map` on a field that did not exist yet. In a separate window, where the
 * main window sees nothing wrong.
 */
describe("coercePanelSnapshot", () => {
  it("passes a current snapshot through unchanged", () => {
    const full = { ...BASE, fps: 25, aiModelId: "claude" };
    expect(coercePanelSnapshot(full)).toEqual(full);
  });

  it("fills a field an older build never wrote", () => {
    const old = { ...BASE } as Record<string, unknown>;
    delete old.chapterSourceKey;
    delete old.durationSec;
    const got = coercePanelSnapshot(old);
    expect(got.chapterSourceKey).toBe(null);
    expect(got.durationSec).toBe(null);
  });

  it("never hands a child an aiStyle it cannot read", () => {
    // `.format` and `.length` are read straight through by the AI pane.
    for (const bad of [undefined, null, "bullets", 3, []]) {
      const got = coercePanelSnapshot({ ...BASE, aiStyle: bad });
      expect(typeof got.aiStyle.format).toBe("string");
      expect(typeof got.aiStyle.length).toBe("string");
    }
    // A half-written one keeps the half that is real.
    expect(coercePanelSnapshot({ ...BASE, aiStyle: { format: "prose" } }).aiStyle)
      .toEqual({ format: "prose", length: "standard" });
  });

  it("never hands a child a queue it cannot map", () => {
    for (const bad of [undefined, null, "[]", 0, {}]) {
      expect(Array.isArray(coercePanelSnapshot({ ...BASE, queue: bad }).queue)).toBe(true);
    }
  });

  it("falls back whole when the mirror is not an object at all", () => {
    for (const junk of [null, undefined, 42, "snapshot", true]) {
      expect(coercePanelSnapshot(junk)).toEqual(BASE_DEFAULTS);
    }
  });

  it("keeps real values rather than resetting everything on one bad field", () => {
    // A panel showing four real values and one default beats one that flashes
    // empty and waits for the next publish.
    const got = coercePanelSnapshot({ ...BASE, fps: 25, running: true, aiStyle: null });
    expect(got.fps).toBe(25);
    expect(got.running).toBe(true);
    expect(got.aiStyle).toEqual({ format: "bullets", length: "standard" });
  });
});
