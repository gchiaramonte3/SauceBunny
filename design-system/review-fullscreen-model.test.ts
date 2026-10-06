import { describe, expect, it } from "vitest";
import { IDLE_MS, controlsShown, fitPicture, frameTimecode } from "./review-fullscreen-model";
import { rfPeople } from "./review-fullscreen-fixture";

describe("the picture is the page", () => {
  it("fills the width of a tall area and the height of a wide one, at its own shape", () => {
    expect(fitPicture({ width: 1680, height: 1020 }, 16 / 9)).toEqual({ width: 1680, height: 945 });
    expect(fitPicture({ width: 1680, height: 900 }, 16 / 9)).toEqual({ width: 1600, height: 900 });
    expect(fitPicture({ width: 1100, height: 700 }, 16 / 10)).toEqual({ width: 1100, height: 688 });
  });

  it("is nothing in an area with no room", () => {
    expect(fitPicture({ width: 0, height: 700 }, 16 / 9)).toEqual({ width: 0, height: 0 });
    expect(fitPicture({ width: 700, height: 700 }, 0)).toEqual({ width: 0, height: 0 });
  });
});

describe("the controls step aside while nobody is using them", () => {
  const idle = { sinceMoveMs: IDLE_MS, focusInside: false, menuOpen: false, pinned: false };
  it("hide once the pointer has rested", () => {
    expect(controlsShown({ ...idle, sinceMoveMs: IDLE_MS - 1 })).toBe(true);
    expect(controlsShown(idle)).toBe(false);
  });

  it("stay while the keyboard is in them, a menu is open, or they are pinned", () => {
    expect(controlsShown({ ...idle, focusInside: true })).toBe(true);
    expect(controlsShown({ ...idle, menuOpen: true })).toBe(true);
    expect(controlsShown({ ...idle, pinned: true })).toBe(true);
  });
});

describe("the fixture room", () => {
  it("has one presenter, and the same people in every layout", () => {
    const people = rfPeople(8, { longNames: false, handRaised: true, camerasOff: false });
    expect(people.filter((p) => p.presenting)).toHaveLength(1);
    expect(people.filter((p) => p.self)).toHaveLength(1);
    expect(people.filter((p) => p.handRaised).map((p) => p.name)).toEqual(["Sam"]);
  });

  it("counts a file's frames as hour-one timecode", () => {
    expect(frameTimecode(0)).toBe("01:00:00:00");
    expect(frameTimecode(24 * 61 + 5)).toBe("01:01:01:05");
  });
});
