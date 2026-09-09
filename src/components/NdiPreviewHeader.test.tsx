// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { NdiPreviewHeader } from "./NdiPreviewHeader";
afterEach(cleanup);
it("keeps publication passive and timecode explicitly unavailable", () => {
  const h=render(<NdiPreviewHeader sharing="private"/>);
  expect(screen.getByText("Not shared").tagName).toBe("SPAN");
  expect(screen.getByRole("status",{name:"Timeline timecode unavailable"}).textContent).toBe("--:--:--:--");
  expect(h.container.querySelector("button,video")).toBeNull();
  h.rerender(<NdiPreviewHeader sharing="shared"/>);expect(screen.getByText("Shared with room")).toBeTruthy();
  h.rerender(<NdiPreviewHeader sharing="stopped"/>);expect(screen.getByText("Sharing stopped")).toBeTruthy();
});
