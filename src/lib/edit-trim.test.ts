import { describe, expect, it } from "vitest";
import { layerClips, programDuration, type Layering, type Timeline } from "./edit-model";
import { copyClips, cutsOn, extractClips, liftClips, moveClips, nearestCut, pasteClips, slide, slip, trim, type TrimContext } from "./edit-trim";

// 25 fps, so a frame is 0.04 s. A1 holds Kara (source 10-14 s) then Stef (50-54 s);
// A2 holds Bob under Kara's clip. Source "s" is 100 s long.
const fps = 25, f = 1 / fps;
const layering: Layering = { carries: () => ["kara", "stef", "bob"], home: (lane) => ({ kara: 1, stef: 3, bob: 2 } as Record<string, number>)[lane] };
const ctx: TrimContext = { layering, durationOf: () => 100, fps };
const scene = (): Timeline => ({ segments: [
  { id: "one", source: "s", srcIn: 10, srcOut: 14, tracks: ["kara", "bob"], layers: { kara: 1, bob: 2 } },
  { id: "two", source: "s", srcIn: 50, srcOut: 54, tracks: ["stef"], layers: { stef: 1 } },
], mutes: [] });
const round = (n: number) => Math.round(n * 1000) / 1000;
const track = (edit: Timeline, layer: number) => layerClips(edit, layer, layering).map((clip) => [clip.lane, round(clip.from), round(clip.to), round(clip.srcIn), round(clip.srcOut)]);
const done = <T,>(result: T | { refusal: string }): T => { if (result && typeof result === "object" && "refusal" in result) throw new Error(result.refusal); return result as T; };

describe("trim on record tracks", () => {
  it("finds a track's cuts, and U seats a roll at the one nearest the playhead on every selected track that has it", () => {
    expect(cutsOn(layerClips(scene(), 1, layering)).map(round)).toEqual([0, 4, 8]);
    expect(nearestCut(scene(), [1], 3.7, layering)).toEqual([{ layer: 1, at: 4, side: "both" }]);
    // A2's clip also ends at 4: both tracks roll together.
    expect(nearestCut(scene(), [1, 2], 4.2, layering)).toEqual([{ layer: 1, at: 4, side: "both" }, { layer: 2, at: 4, side: "both" }]);
  });

  it("a roll moves the cut on that track alone: one clip gives what the other takes, and nothing moves", () => {
    const later = done(trim(scene(), [{ layer: 1, at: 4, side: "both" }], 2, true, ctx, 3));
    expect(track(later.edit, 1)).toEqual([["kara", 0, 4.08, 10, 14.08], ["stef", 4.08, 8, 50.08, 54]]);
    expect(programDuration(later.edit)).toBeCloseTo(8, 6);
    expect(later.rollers).toEqual([{ layer: 1, at: 4 + 2 * f, side: "both" }]);
    // Bob, on A2, is untouched by a roll on A1.
    expect(track(later.edit, 2)).toEqual([["bob", 0, 4, 10, 14]]);
    const earlier = done(trim(scene(), [{ layer: 1, at: 4, side: "both" }], -2, true, ctx, 3));
    expect(track(earlier.edit, 1)).toEqual([["kara", 0, 3.92, 10, 13.92], ["stef", 3.92, 8, 49.92, 54]]);
  });

  it("stops at the source's media and says so, and refuses a trim with no room at all", () => {
    const tight = scene();
    tight.segments[1] = { ...tight.segments[1], srcIn: 0.04, srcOut: 4.04 };
    const limited = done(trim(tight, [{ layer: 1, at: 4, side: "both" }], -5, true, ctx, 3));
    expect(limited.frames).toBe(-1);
    expect(limited.limited).toBe("no more source media");
    const none = trim(done(trim(tight, [{ layer: 1, at: 4, side: "both" }], -1, true, ctx, 3)).edit, [{ layer: 1, at: 4 - f, side: "both" }], -1, true, ctx, 3);
    expect(none).toEqual({ refusal: "It cannot trim that way: no more source media." });
  });

  it("one side ripples: lengthening opens time on every track, with filler on the others", () => {
    const longer = done(trim(scene(), [{ layer: 1, at: 4, side: "a" }], 2, true, ctx, 3));
    expect(programDuration(longer.edit)).toBeCloseTo(8.08, 6);
    expect(track(longer.edit, 1)).toEqual([["kara", 0, 4.08, 10, 14.08], ["stef", 4.08, 8.08, 50, 54]]);
    expect(track(longer.edit, 2)).toEqual([["bob", 0, 4, 10, 14]]);
  });

  it("a ripple that shortens takes the same frames from every track, so it is refused where another track has a clip, unless that track trims too", () => {
    expect(trim(scene(), [{ layer: 1, at: 4, side: "a" }], -2, true, ctx, 3)).toEqual({
      refusal: "That would take 2 frames from A2 too, which is not in this trim. Add a roller on A2, or trim without ripple." });
    const both = done(trim(scene(), [{ layer: 1, at: 4, side: "a" }, { layer: 2, at: 4, side: "a" }], -2, true, ctx, 3));
    expect(programDuration(both.edit)).toBeCloseTo(7.92, 6);
    expect(track(both.edit, 1)).toEqual([["kara", 0, 3.92, 10, 13.92], ["stef", 3.92, 7.92, 50, 54]]);
    expect(track(both.edit, 2)).toEqual([["bob", 0, 3.92, 10, 13.92]]);
  });

  it("with ripple off, one side is an overwrite trim: shortening leaves filler and nothing moves", () => {
    const shorter = done(trim(scene(), [{ layer: 1, at: 4, side: "a" }], -2, false, ctx, 3));
    expect(programDuration(shorter.edit)).toBeCloseTo(8, 6);
    expect(track(shorter.edit, 1)).toEqual([["kara", 0, 3.92, 10, 13.92], ["stef", 4, 8, 50, 54]]);
    // B-side ripple keeps its cut where it is; the rest closes up.
    const head = done(trim(scene(), [{ layer: 1, at: 4, side: "b" }], -2, true, ctx, 3));
    expect(track(head.edit, 1)).toEqual([["kara", 0, 4, 10, 14], ["stef", 4, 8.08, 49.92, 54]]);
    expect(head.rollers[0].at).toBe(4);
  });

  it("refuses rollers that do not make one trim, and an edit with nothing on that track", () => {
    expect(trim(scene(), [{ layer: 1, at: 4, side: "a" }, { layer: 2, at: 4, side: "both" }], 1, true, ctx, 3))
      .toEqual({ refusal: "These rollers do not make one trim. Put them all on the A side, the B side, or both." });
    expect(trim(scene(), [{ layer: 3, at: 4, side: "both" }], 1, true, ctx, 3)).toEqual({ refusal: "There is no edit on A3 there." });
  });
});

describe("slip, slide and moving clips", () => {
  it("slip plays the clip from elsewhere in its source and keeps its place", () => {
    const slipped = done(slip(scene(), { layer: 1, from: 0 }, 3, ctx));
    expect(track(slipped.edit, 1)).toEqual([["kara", 0, 4, 10.12, 14.12], ["stef", 4, 8, 50, 54]]);
  });

  it("slide moves the clip along its track, the clip after giving way and filler behind it", () => {
    const slid = done(slide(scene(), { layer: 1, from: 0 }, 2, ctx));
    expect(track(slid.edit, 1)).toEqual([["kara", 0.08, 4.08, 10, 14], ["stef", 4.08, 8, 50.08, 54]]);
    expect(slid.pick).toEqual({ layer: 1, from: 2 * f });
    expect(track(slid.edit, 2)).toEqual([["bob", 0, 4, 10, 14]]);
  });

  it("moves clips as Avid's red segment arrow: filler where they were, overwriting where they land, on any track", () => {
    const moved = done(moveClips(scene(), [{ layer: 1, from: 4 }], 0, 2, ctx));
    expect(track(moved.edit, 1)).toEqual([["kara", 0, 4, 10, 14]]);
    expect(track(moved.edit, 3)).toEqual([["stef", 4, 8, 50, 54]]);
    expect(moved.picks).toEqual([{ layer: 3, from: 4 }]);
    const nudged = done(moveClips(scene(), [{ layer: 1, from: 0 }], 1, 0, ctx));
    expect(track(nudged.edit, 1)).toEqual([["kara", 0.04, 4.04, 10, 14], ["stef", 4.04, 8, 50.04, 54]]);
    expect(moveClips(scene(), [{ layer: 1, from: 0 }], -1, 0, ctx)).toEqual({ refusal: "That would move a clip before the start of the string out." });
  });

  it("copies clips as Media Composer's Option-drag: the original stays and the copy overwrites where it lands", () => {
    const copied = done(moveClips(scene(), [{ layer: 1, from: 4 }], 10 / f, 2, ctx, true));
    expect(track(copied.edit, 1)).toEqual([["kara", 0, 4, 10, 14], ["stef", 4, 8, 50, 54]]);
    expect(track(copied.edit, 3)).toEqual([["stef", 14, 18, 50, 54]]);
    expect(copied.picks).toEqual([{ layer: 3, from: 14 }]);
    expect(moveClips(scene(), [{ layer: 1, from: 4 }], 0, 0, ctx, true)).toEqual({ refusal: "Drag the copy somewhere else first." });
  });

  it("copies clips and pastes them over the playhead on their own tracks, as far apart as they were", () => {
    // Kara (A1, from 0) and Bob (A2, from 0) copied; pasted at 10 s, past the end, with filler before them.
    const held = copyClips(scene(), [{ layer: 1, from: 0 }, { layer: 2, from: 0 }], layering);
    expect(held).toEqual([{ layer: 1, lane: "kara", source: "s", srcIn: 10, srcOut: 14, offset: 0 }, { layer: 2, lane: "bob", source: "s", srcIn: 10, srcOut: 14, offset: 0 }]);
    const pasted = done(pasteClips(scene(), held, 10, ctx));
    expect(track(pasted.edit, 1)).toEqual([["kara", 0, 4, 10, 14], ["stef", 4, 8, 50, 54], ["kara", 10, 14, 10, 14]]);
    expect(track(pasted.edit, 2)).toEqual([["bob", 0, 4, 10, 14], ["bob", 10, 14, 10, 14]]);
    expect(pasted.picks).toEqual([{ layer: 1, from: 10 }, { layer: 2, from: 10 }]);
    expect(pasteClips(scene(), [], 0, ctx)).toEqual({ refusal: "Nothing is copied. Select clips and press ⌘C first." });
  });

  it("refuses to put a person on a second track where they already play, rather than take them off the first", () => {
    // A copy of Stephanie's clip onto A3 over her own original on A1.
    expect(moveClips(scene(), [{ layer: 1, from: 4 }], 0, 2, ctx, true))
      .toEqual({ refusal: "stef already plays on A1 there, and a string out holds each person on one track at a time." });
    // Bob's clip on A2 dragged onto A1 is fine: Bob is nowhere else there.
    expect("refusal" in moveClips(scene(), [{ layer: 2, from: 0 }], 0, -1, ctx)).toBe(false);
  });

  it("Delete lifts a clip and leaves filler; ⇧Delete extracts its time from every track and says whose clips that takes", () => {
    const lifted = liftClips(scene(), [{ layer: 1, from: 4 }], layering);
    expect(track(lifted, 1)).toEqual([["kara", 0, 4, 10, 14]]);
    expect(programDuration(lifted)).toBeCloseTo(8, 6);
    const extracted = extractClips(scene(), [{ layer: 1, from: 0 }], ctx, 3);
    expect(extracted.caught).toEqual([2]);
    expect(programDuration(extracted.edit)).toBeCloseTo(4, 6);
    expect(track(extracted.edit, 1)).toEqual([["stef", 0, 4, 50, 54]]);
  });
});
