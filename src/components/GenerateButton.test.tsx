// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { GenerateButton } from "./GenerateButton";

it("exposes one readable accessible label throughout its visual phases", () => {
  const props = { idleLabel: "Generate 3 tracks", loadingLabel: "Reading audio…", onClick: vi.fn() };
  const { rerender } = render(<GenerateButton {...props} loading={false} />);
  expect(screen.getByRole("button", { name: "Generate 3 tracks" }).getAttribute("aria-busy")).toBe("false");
  rerender(<GenerateButton {...props} loading />);
  expect(screen.getByRole("button", { name: "Reading audio…" }).getAttribute("aria-busy")).toBe("true");
  rerender(<GenerateButton {...props} loading={false} resolution="success" />);
  expect(screen.getByRole("button", { name: "Done" })).not.toBeNull();
  rerender(<GenerateButton {...props} loading={false} resolution="error" />);
  expect(screen.getByRole("button", { name: "Failed" })).not.toBeNull();
});
