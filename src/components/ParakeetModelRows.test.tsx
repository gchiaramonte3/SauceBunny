// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[], installed: new Set<string>(), emitted: [] as string[],
  finish: null as null | (() => void),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    state.calls.push({ cmd, args });
    if (cmd === "parakeet_model_downloaded") return state.installed.has(String(args.model));
    if (cmd === "download_parakeet_model") return new Promise<void>((resolve) => { state.finish = () => { state.installed.add(String(args.model)); resolve(); }; });
    if (cmd === "delete_parakeet_model") { state.installed.delete(String(args.model)); return null; }
    return null;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async (event: string) => { state.emitted.push(event); }) }));

import { ParakeetModelRows } from "./ParakeetModelRows";

function Rows({ engineInUse = false, onUseAsDefault = vi.fn(), onInUseDeleted = vi.fn() }: { engineInUse?: boolean; onUseAsDefault?: () => void; onInUseDeleted?: () => void }) {
  const [armed, setArmed] = useState<string | null>(null);
  return <ParakeetModelRows engineInUse={engineInUse} onUseAsDefault={onUseAsDefault} onInUseDeleted={onInUseDeleted} armed={armed} onArm={setArmed} />;
}
const row = (name: string) => screen.getByText(name).closest(".cp-model-row") as HTMLElement;

afterEach(cleanup);
beforeEach(() => { state.calls.length = 0; state.installed = new Set(["parakeet-tdt-0.6b-v3"]); state.emitted.length = 0; state.finish = null; });

it("lists every Parakeet model, Ultra first and recommended, and offers v3 as Clip's engine", async () => {
  const onUseAsDefault = vi.fn();
  render(<Rows onUseAsDefault={onUseAsDefault} />);
  await waitFor(() => expect(row("Parakeet TDT 0.6B v3").textContent).toContain("Installed"));
  expect([...document.querySelectorAll(".cp-model-row .name")].map((name) => name.textContent)).toEqual(["Parakeet Ultra", "Parakeet TDT 0.6B v3"]);
  expect(row("Parakeet Ultra").textContent).toContain("Recommended");
  expect(row("Parakeet Ultra").textContent).toContain("≈0.6 GB");
  // Only v3 runs Clip and dictation, so only it can be the default engine.
  expect(screen.getAllByRole("button", { name: "Use as default" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Use as default" }));
  expect(onUseAsDefault).toHaveBeenCalled();
});

it("downloads Ultra here, holding the job so Cancel reaches it, and tells AAF Audio when it lands", async () => {
  render(<Rows />);
  const download = await screen.findByRole("button", { name: "Download" });
  act(() => { fireEvent.click(download); });
  const started = state.calls.find((call) => call.cmd === "download_parakeet_model")!;
  expect(started.args.model).toBe("parakeet-ultra");
  expect(screen.getByText(/runs once/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(state.calls.find((call) => call.cmd === "cancel_job")?.args.jobId).toBe(started.args.jobId);
  await act(async () => { state.finish?.(); });
  await waitFor(() => expect(row("Parakeet Ultra").textContent).toContain("Installed"));
  expect(state.emitted).toEqual(["panel:parakeet-models-changed"]);
});

it("deletes only on the armed second click, and falls back to Whisper when the model in use goes", async () => {
  const onInUseDeleted = vi.fn();
  render(<Rows engineInUse onInUseDeleted={onInUseDeleted} />);
  const remove = await screen.findByRole("button", { name: "Delete Parakeet TDT 0.6B v3" });
  expect(row("Parakeet TDT 0.6B v3").textContent).toContain("In use");
  fireEvent.click(remove);
  expect(state.calls.some((call) => call.cmd === "delete_parakeet_model")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Confirm deleting Parakeet TDT 0.6B v3" }));
  await waitFor(() => expect(onInUseDeleted).toHaveBeenCalled());
  expect(state.calls.find((call) => call.cmd === "delete_parakeet_model")?.args.model).toBe("parakeet-tdt-0.6b-v3");
  await waitFor(() => expect(state.emitted).toEqual(["panel:parakeet-models-changed"]));
});
