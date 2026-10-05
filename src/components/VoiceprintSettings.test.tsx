// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const calls: string[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => { calls.push(cmd); return cmd === "voiceprints_summary" ? { documents: 2, voices: 14 } : null; }),
}));

import { VoiceprintSettings } from "./VoiceprintSettings";

afterEach(cleanup);

it("says how many voiceprints are kept and deletes them all only on a second, deliberate click", async () => {
  render(<VoiceprintSettings />);
  expect(await screen.findByText("14 voices from 2 sequences")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Delete every voiceprint" }));
  expect(calls).not.toContain("delete_voiceprints");
  fireEvent.click(screen.getByRole("button", { name: "Confirm deleting every voiceprint" }));
  await waitFor(() => expect(calls).toContain("delete_voiceprints"));
  expect(await screen.findByText("No voiceprints are kept.")).toBeTruthy();
});
