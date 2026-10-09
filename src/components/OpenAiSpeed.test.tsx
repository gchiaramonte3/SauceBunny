// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { serviceTier, setCloudModel } from "../lib/ai-provider";
import { OpenAiSpeed } from "./OpenAiSpeed";

afterEach(cleanup);
beforeEach(() => { localStorage.clear(); setCloudModel("openai", "gpt-6-astra"); });

it("is a named switch, off until pressed, that says what it costs and is remembered", () => {
  render(<OpenAiSpeed model="gpt-6-astra" />);
  const speed = screen.getByRole("switch", { name: "Ultrafast" });
  expect(speed.getAttribute("aria-checked")).toBe("false");
  expect(speed.getAttribute("aria-describedby") && document.getElementById(speed.getAttribute("aria-describedby")!)?.textContent).toMatch(/six times as much/);
  fireEvent.click(speed);
  expect(speed.getAttribute("aria-checked")).toBe("true");
  expect(serviceTier("openai")).toBe("ultrafast");
  // A second visit to Settings finds it as it was left.
  cleanup();
  render(<OpenAiSpeed model="gpt-6-astra" />);
  fireEvent.click(screen.getByRole("switch", { name: "Ultrafast", checked: true }));
  expect(serviceTier("openai")).toBeNull();
});

it("is sent only with a model OpenAI offers it for, and says so when the model is another", () => {
  // OpenAI refuses a whole request asking Ultrafast of gpt-4o ("Invalid service_tier argument").
  setCloudModel("openai", "gpt-4o");
  render(<OpenAiSpeed model="gpt-4o" />);
  const speed = screen.getByRole("switch", { name: "Ultrafast" });
  fireEvent.click(speed);
  expect(serviceTier("openai")).toBeNull();
  expect(document.getElementById(speed.getAttribute("aria-describedby")!)?.textContent).toMatch(/gpt-4o does not offer it/);
  expect(serviceTier("openai", "gpt-6-astra")).toBe("ultrafast");
  expect(serviceTier("openai", "gpt-6-astra-2026-09-01")).toBe("ultrafast");
  expect(serviceTier("openai", "gpt-6-astra-mini")).toBeNull();
});
