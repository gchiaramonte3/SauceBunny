// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ calls: [] as { cmd: string; args: Record<string, unknown> }[], installed: new Set(["parakeet-tdt-0.6b-v3"]), changed: null as null | (() => void) }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    state.calls.push({ cmd, args });
    if (cmd === "parakeet_model_downloaded") return state.installed.has(String(args.model));
    return null;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: () => void) => { if (event === "panel:parakeet-models-changed") state.changed = handler; return () => { state.changed = null; }; }),
}));

import { useParakeetModels } from "./use-parakeet-models";

beforeEach(() => { state.calls.length = 0; state.installed = new Set(["parakeet-tdt-0.6b-v3"]); state.changed = null; });

it("reads each model's readiness by id", async () => {
  const { result } = renderHook(() => useParakeetModels());
  await act(async () => { await result.current.check(); });
  expect(result.current.ready).toEqual({ "parakeet-ultra": false, "parakeet-tdt-0.6b-v3": true });
  expect(state.calls.filter((call) => call.cmd === "parakeet_model_downloaded").map((call) => call.args.model)).toEqual(["parakeet-ultra", "parakeet-tdt-0.6b-v3"]);
});

it("never downloads, and checks again when Settings installs or deletes a model", async () => {
  const { result } = renderHook(() => useParakeetModels());
  expect(Object.keys(result.current).sort()).toEqual(["check", "ready"]);
  await waitFor(() => expect(state.changed).not.toBeNull());
  state.installed.add("parakeet-ultra");
  await act(async () => { state.changed?.(); });
  await waitFor(() => expect(result.current.ready["parakeet-ultra"]).toBe(true));
  expect(state.calls.some((call) => call.cmd === "download_parakeet_model")).toBe(false);
});
