import { describe, expect, it } from "vitest";
import { aspectOf, classifyAspect, rememberAspect } from "./art-aspect";

describe("art aspect classification (12a)", () => {
  it("classifies the common shapes", () => {
    expect(classifyAspect(1920, 1080)).toBe("landscape");
    expect(classifyAspect(1080, 1920)).toBe("portrait");
    expect(classifyAspect(1080, 1080)).toBe("square");
  });

  it("keeps a near-square band so 1:1-ish art does not flap", () => {
    expect(classifyAspect(1000, 950)).toBe("square");   // 1.05
    expect(classifyAspect(950, 1000)).toBe("square");   // 0.95
    expect(classifyAspect(1120, 1000)).toBe("landscape"); // 1.12
    expect(classifyAspect(880, 1000)).toBe("portrait");   // 0.88
  });

  it("degenerate dimensions fall back to landscape", () => {
    expect(classifyAspect(0, 100)).toBe("landscape");
    expect(classifyAspect(100, 0)).toBe("landscape");
  });

  it("remember/lookup round-trips by url", () => {
    rememberAspect("https://x/th.jpg", 720, 1280);
    expect(aspectOf("https://x/th.jpg")).toBe("portrait");
    expect(aspectOf("https://x/other.jpg")).toBeNull();
    expect(aspectOf(null)).toBeNull();
  });
});
