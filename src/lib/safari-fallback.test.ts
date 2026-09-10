import { expect, it } from "vitest";
import { browserLabel } from "./safari-fallback";

it("labels the selected browser without claiming cookie access", () => {
  expect(browserLabel("none")).toBe("your default browser");
  expect(browserLabel("safari")).toBe("Safari");
  expect(browserLabel("chrome")).toBe("Chrome");
});
