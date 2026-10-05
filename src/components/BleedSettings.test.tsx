// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let refuse = false;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    // This Mac's saved switch: the editor turned Hide bleed on last time.
    if (cmd === "bleed_hidden") return true;
    if (cmd === "set_bleed_hidden" && refuse) throw new Error("The disk is full");
    return null;
  }),
}));

import { BleedSettings } from "./BleedSettings";

afterEach(() => { cleanup(); refuse = false; });

it("reads the saved switch and saves a change to it", async () => {
  render(<BleedSettings />);
  const toggle = screen.getByRole("switch", { name: "Hide bleed" });
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  expect(calls.filter((call) => call.cmd === "set_bleed_hidden").map((call) => call.args)).toEqual([{ hide: false }]);
});

it("keeps the switch where it was when the change cannot be saved, and says why", async () => {
  refuse = true;
  render(<BleedSettings />);
  const toggle = screen.getByRole("switch", { name: "Hide bleed" });
  const before = toggle.getAttribute("aria-checked");
  fireEvent.click(toggle);
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toMatch(/The disk is full/);
  expect(toggle.getAttribute("aria-checked")).toBe(before);
});
