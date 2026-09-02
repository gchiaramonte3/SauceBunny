import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { liveStrokeAlpha, LIVE_FADE_OUT_MS } from "./draw-paint";

/**
 * Live telestration draws for the room and then forgets.
 *
 * The whole feature is a promise about what does NOT happen: a mark shown on
 * the picture never becomes a note, never reaches the review doc, and never
 * survives the session. That promise is one prop deep - the capture overlay is
 * the SAME component the composer uses to draft a note, told not to accumulate
 * - so it is exactly the kind of thing a later edit removes by accident while
 * every test still passes.
 *
 * docs/COLLAB-DRAWING.md records the owner decision this pins (2026-08-25):
 * "The live drawing surface is EPHEMERAL. Only a posted comment persists."
 */

const SRC = join(__dirname, "..");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

describe("live-draw-contract", () => {
  const layer = read("components/LiveDrawLayer.tsx");
  const app = read("App.tsx");
  const hook = read("hooks/use-co-review.ts");

  it("finds the files it is policing, so the rules below cannot pass vacuously", () => {
    expect(layer.length, "LiveDrawLayer did not load").toBeGreaterThan(500);
    expect(app).toMatch(/<LiveDrawLayer/);
    expect(hook).toMatch(/const postDrawOp = useCallback/);
  });

  it("the live layer has no way to persist anything", () => {
    // It is a canvas over the picture. If it grows a writer, the promise the
    // feature is built on stops being structural and becomes a convention.
    for (const forbidden of ["saveJson", "postSessionOp", "review-store", "writeReview", "onChange"]) {
      expect(layer, `LiveDrawLayer reaches for ${forbidden}`).not.toMatch(new RegExp(forbidden));
    }
  });

  it("the live capture surface never accumulates a draft", () => {
    // `annotation={null}` + `onStroke` IS the ephemerality: with a non-null
    // annotation the overlay would build a draft, and the composer's Post
    // button would happily turn it into a comment.
    const site = /<AnnotationOverlay\s+annotation=\{null\}\s+drawing\s+onChange=\{\(\) => \{\}\}\s+onStroke=/;
    expect(app, "the live overlay no longer opts out of drafting").toMatch(site);
  });

  it("expiry is local, so one peer's fade never erases another's copy", () => {
    // pruneLiveDraw must not relay: each machine fades on its own clock, and a
    // relayed expiry would let the shortest fade in the room govern everyone.
    const body = hook.slice(hook.indexOf("const pruneLiveDraw"));
    const end = body.indexOf("}, []);");
    expect(end, "pruneLiveDraw changed shape").toBeGreaterThan(0);
    expect(body.slice(0, end), "pruneLiveDraw relays; expiry must stay local").not.toMatch(/sendSessionMsg/);
  });

  it("a clear does relay, because the surface is shared", () => {
    const body = hook.slice(hook.indexOf("const clearLiveDraw"));
    expect(body.slice(0, body.indexOf("}, [sendSessionMsg]);")))
      .toMatch(/sendSessionMsg/);
  });

  describe("the fade itself", () => {
    it("holds, then ramps to nothing", () => {
      expect(liveStrokeAlpha(0, 5000)).toBe(1);
      expect(liveStrokeAlpha(4999, 5000)).toBe(1);
      const mid = liveStrokeAlpha(5000 + LIVE_FADE_OUT_MS / 2, 5000);
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(1);
      expect(liveStrokeAlpha(5000 + LIVE_FADE_OUT_MS, 5000)).toBe(0);
      // Never negative: a negative alpha would paint nothing but would also
      // never trip the caller's `<= 0` expiry the same way.
      expect(liveStrokeAlpha(999999, 5000)).toBe(0);
    });

    it("hold-until-cleared never fades", () => {
      expect(liveStrokeAlpha(0, 0)).toBe(1);
      expect(liveStrokeAlpha(60 * 60 * 1000, 0)).toBe(1);
    });
  });
});
