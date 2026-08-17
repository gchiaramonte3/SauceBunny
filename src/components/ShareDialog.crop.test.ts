import { describe, expect, it } from "vitest";
import { MIN_CROP_PX, cropShareable, cropStatus } from "./ShareDialog";

/**
 * The share dialog's caption and its Share button agree about the drag.
 *
 * They did not. The button wanted both dimensions over the floor; the caption
 * checked only the width. So a wide, short strip - the shape you get dragging
 * across a title bar or a toolbar, which is a thing people share - printed
 * "420×9 on Built-in Display", drew the rectangle on the thumbnail, and left
 * Share dead. Nothing on screen said the selection was the problem.
 *
 * That is the expensive kind of dead control. A greyed button with no
 * explanation makes you look for the reason; a greyed button next to a caption
 * confirming your selection makes you look ANYWHERE ELSE for the reason.
 *
 * Both now derive from `cropShareable`, so the disagreement is not something
 * you can reintroduce by editing one of them. What is left to check is that the
 * floor applies to both dimensions and that the caption names the block.
 */

const on = (w: number, h: number) => ({ x: 0, y: 0, w, h });

describe("the crop floor applies to both dimensions", () => {
  it("accepts an ordinary region", () => {
    // The canary: every rejection below is meaningless if nothing passes.
    expect(cropShareable(on(400, 300))).toBe(true);
    expect(cropStatus(on(400, 300), "Built-in Display")).toBe("400×300 on Built-in Display");
  });

  it("rejects a wide, short strip - the case that was reported as valid", () => {
    expect(cropShareable(on(420, 9))).toBe(false);
    expect(cropStatus(on(420, 9), "Built-in Display")).toBe("420×9 is too small to share.");
  });

  it("rejects a tall, narrow strip too", () => {
    // The mirror image. A width-only check would have passed the strip above
    // and failed this one, which is how the asymmetry hid for so long.
    expect(cropShareable(on(9, 420))).toBe(false);
    expect(cropStatus(on(9, 420), "Built-in Display")).toBe("9×420 is too small to share.");
  });

  it("is exclusive at the floor in both directions", () => {
    expect(cropShareable(on(MIN_CROP_PX, 400)), "the floor itself passed").toBe(false);
    expect(cropShareable(on(400, MIN_CROP_PX)), "the floor itself passed").toBe(false);
    expect(cropShareable(on(MIN_CROP_PX + 1, MIN_CROP_PX + 1))).toBe(true);
  });
});

describe("the caption during a drag", () => {
  it("asks for a drag before there is one", () => {
    expect(cropStatus(null, "Built-in Display")).toBe("Drag the area to share.");
  });

  it("still asks for a drag on a bare click", () => {
    // pointerdown sets a 0x0 crop before any movement. Calling that "0×0 is
    // too small" would scold someone who has not done anything yet.
    expect(cropStatus(on(0, 0), "Built-in Display")).toBe("Drag the area to share.");
  });

  it("switches to the block only once one dimension is real", () => {
    // Growing a drag: while both are under the floor it reads as not-started;
    // once the user has clearly committed to a shape, it names the problem.
    expect(cropStatus(on(4, 4), "Built-in Display")).toBe("Drag the area to share.");
    expect(cropStatus(on(200, 4), "Built-in Display")).toBe("200×4 is too small to share.");
  });

  it("rounds rather than printing the raw scaled float", () => {
    // Coordinates are scaled from the rendered thumbnail to display points, so
    // they arrive fractional. "419.6×300.2" in a caption reads as a bug.
    expect(cropStatus(on(419.6, 300.2), "Studio Display")).toBe("420×300 on Studio Display");
  });
});
