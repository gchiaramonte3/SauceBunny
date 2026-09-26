// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ModelDownloadProgress } from "./ModelDownloadProgress";
afterEach(cleanup);
it("exposes actual byte progress and bounds impossible values", () => {
  const { rerender } = render(<ModelDownloadProgress name="Qwen" done={250} total={1000} />);
  const bar = screen.getByRole("progressbar", { name: "Downloading Qwen" });
  expect(bar.getAttribute("aria-valuenow")).toBe("25");
  expect(bar.firstElementChild?.getAttribute("style")).toContain("25%");
  rerender(<ModelDownloadProgress name="Qwen" done={1500} total={1000} />);
  expect(bar.getAttribute("aria-valuenow")).toBe("100");
  rerender(<ModelDownloadProgress name="Qwen" done={-100} total={1000} />);
  expect(bar.getAttribute("aria-valuenow")).toBe("0");
});
it("does not invent percent or bytes for unknown progress", () => {
  render(<ModelDownloadProgress name="Parakeet" />);
  const bar = screen.getByRole("progressbar");
  expect(bar.hasAttribute("aria-valuenow")).toBe(false);
  expect(bar.classList.contains("is-indeterminate")).toBe(true);
  expect(screen.getByText("Downloading…")).toBeTruthy();
});
it("shares the same treatment for percentage-only events", () => {
  render(<ModelDownloadProgress name="Local AI" percent={21.4} />);
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("21");
  expect(screen.getByText("21%")).toBeTruthy();
});
