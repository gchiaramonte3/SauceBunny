// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { serviceTier } from "../lib/ai-provider";
import { OpenAiSpeed } from "./OpenAiSpeed";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

it("is a named switch, off until pressed, that says what it costs and is remembered", () => {
  render(<OpenAiSpeed />);
  const speed = screen.getByRole("switch", { name: "Ultrafast" });
  expect(speed.getAttribute("aria-checked")).toBe("false");
  expect(speed.getAttribute("aria-describedby") && document.getElementById(speed.getAttribute("aria-describedby")!)?.textContent).toMatch(/six times as much/);
  fireEvent.click(speed);
  expect(speed.getAttribute("aria-checked")).toBe("true");
  expect(serviceTier("openai")).toBe("ultrafast");
  // A second visit to Settings finds it as it was left.
  cleanup();
  render(<OpenAiSpeed />);
  fireEvent.click(screen.getByRole("switch", { name: "Ultrafast", checked: true }));
  expect(serviceTier("openai")).toBeNull();
});
