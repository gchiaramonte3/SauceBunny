// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePictureModel } from "./use-picture-model";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), changed: null as null | (() => void) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name: string, fn: () => void) => { if (name === "panel:video-models-changed") mocks.changed = fn; return () => {}; }) }));
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });
afterEach(cleanup);
it("survives StrictMode, remembers selection, and rejects removed models without downloading", async () => {
  let installed = true;
  mocks.invoke.mockImplementation(async (_command, args) => {
    expect(args.request).toEqual({ operation: "models" });
    return { models: ["qwen3.5-9b-video", "qwen3.5-4b-video"].map(id => ({ id, ready: installed })) };
  });
  const { result, unmount } = renderHook(() => usePictureModel(), { wrapper: StrictMode });
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(result.current.id).toBe("qwen3.5-9b-video");
  act(() => result.current.select("qwen3.5-4b-video"));
  expect(result.current.id).toBe("qwen3.5-4b-video");
  installed = false; await act(async () => mocks.changed?.());
  expect(result.current.ready).toBe(false);
  unmount();
  const reopened = renderHook(() => usePictureModel());
  expect(reopened.result.current.id).toBe("qwen3.5-4b-video");
  await waitFor(() => expect(reopened.result.current.models).not.toBeNull());
  expect(reopened.result.current.ready).toBe(false);
});
