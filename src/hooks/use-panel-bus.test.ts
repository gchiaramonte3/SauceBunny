import { describe, expect, it } from "vitest";
import { panelSnapshotsEqual, type PanelSnapshot } from "./use-panel-bus";

/**
 * panelSnapshotsEqual is the publish gate for the cross-window panel bus:
 * a false negative would spam events on every render (the idle-traffic bug
 * r89 removed), a false positive would freeze the popped-out panel. Pin the
 * field-by-field semantics, especially queue-by-reference.
 */

function snap(): PanelSnapshot {
  return {
    queue: [],
    fps: 30,
    running: false,
    hasFolder: false,
    transcriptPath: "/tmp/a.srt",
    transcriptOrigin: "whisper",
    transcriptPlayhead: 1.25,
    transcriptArrivedTick: 3,
    regenerateBusy: false,
    canRegenerate: true,
    hasSource: true,
    aiModelId: "qwen3-4b-instruct",
    aiStyle: { format: "bullets", length: "standard" },
    chapterSourceKey: "src-key",
    durationSec: 90,
  };
}

describe("panelSnapshotsEqual", () => {
  it("treats two content-identical snapshots as equal when queue is shared", () => {
    const a = snap();
    const b = { ...snap(), queue: a.queue, aiStyle: { ...a.aiStyle } };
    expect(panelSnapshotsEqual(a, b)).toBe(true);
  });

  it("compares aiStyle by value, not reference", () => {
    const a = snap();
    const b = { ...snap(), queue: a.queue };
    expect(panelSnapshotsEqual(a, b)).toBe(true);
    b.aiStyle = { format: "prose", length: "standard" };
    expect(panelSnapshotsEqual(a, b)).toBe(false);
  });

  it("compares queue by reference — a rebuilt array must publish", () => {
    const a = snap();
    const b = { ...snap(), queue: [] };
    expect(panelSnapshotsEqual(a, b)).toBe(false);
  });

  it("detects a change in every scalar field", () => {
    const base = snap();
    const changed: Array<Partial<PanelSnapshot>> = [
      { fps: 24 },
      { running: true },
      { hasFolder: true },
      { transcriptPath: null },
      { transcriptOrigin: "captions" },
      { transcriptPlayhead: 1.3 },
      { transcriptArrivedTick: 4 },
      { regenerateBusy: true },
      { canRegenerate: false },
      { hasSource: false },
      { aiModelId: "other-model" },
      { chapterSourceKey: null },
      { durationSec: 91 },
    ];
    for (const patch of changed) {
      const b = { ...base, ...patch, queue: base.queue, aiStyle: { ...base.aiStyle } };
      expect(panelSnapshotsEqual(base, b), JSON.stringify(patch)).toBe(false);
    }
  });

  it("treats the per-frame playhead as a real change (debounce coalesces it, the gate must not)", () => {
    const a = snap();
    const b = { ...snap(), queue: a.queue, transcriptPlayhead: a.transcriptPlayhead! + 1 / 30 };
    expect(panelSnapshotsEqual(a, b)).toBe(false);
  });
});
