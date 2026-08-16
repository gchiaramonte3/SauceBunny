import { describe, expect, it } from "vitest";
import { pushRecentClip, RECENT_CLIP_CAP } from "./recent-clips";
import type { RecentClip } from "../types";

/**
 * Two lines lifted out of App.tsx, and the reason to test them at all is the
 * cap: it decides WHICH export the user loses. Newest-first with a tail slice
 * is the only arrangement where re-exporting the same clip repeatedly cannot
 * push a different source out before the older exports of that same source.
 */
const clip = (id: string): RecentClip =>
  ({ id, title: id, path: `/x/${id}.mp4`, dur: "0:10", when: 0 } as RecentClip);

describe("pushRecentClip", () => {
  it("puts the newest first", () => {
    expect(pushRecentClip([clip("a")], clip("b")).map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("caps the list and drops the OLDEST", () => {
    const full = Array.from({ length: RECENT_CLIP_CAP }, (_, i) => clip(`c${i}`));
    const out = pushRecentClip(full, clip("new"));
    expect(out).toHaveLength(RECENT_CLIP_CAP);
    expect(out[0].id).toBe("new");
    expect(out.map((c) => c.id)).not.toContain(`c${RECENT_CLIP_CAP - 1}`);
  });

  it("does not mutate the list it was handed", () => {
    // The caller renders `prev`; rewriting it underneath would reorder the
    // sidebar mid-render.
    const prev = [clip("a"), clip("b")];
    pushRecentClip(prev, clip("c"));
    expect(prev.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("keeps duplicates rather than deduping", () => {
    // Deliberate: exporting the same range twice IS two files on disk, and the
    // sidebar groups by source at render time. Deduping here would hide one.
    const out = pushRecentClip([clip("a")], clip("a"));
    expect(out).toHaveLength(2);
  });
});
