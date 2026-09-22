// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePictureModel, usePictureModelPreference } from "./use-picture-model";
import { PICTURE_MODEL_KEY } from "../lib/picture-model";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), changed: null as null | (() => void), preference: null as null | (() => void) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}), listen: vi.fn(async (name: string, fn: () => void) => {
  if (name === "panel:video-models-changed") mocks.changed = fn;
  if (name === "panel:picture-model-changed") mocks.preference = fn;
  return () => {};
}) }));
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("shares the saved default with mounted Settings and Clip without invoking model work", async () => {
  const settings = renderHook(() => usePictureModelPreference());
  const clip = renderHook(() => usePictureModelPreference());
  await act(async () => {});
  act(() => settings.result.current.select("qwen3.5-4b-video"));
  expect(clip.result.current.id).toBe("qwen3.5-4b-video");
  expect(localStorage.getItem(PICTURE_MODEL_KEY)).toBe("qwen3.5-4b-video");
  act(() => clip.result.current.select("qwen3.5-9b-video"));
  expect(settings.result.current.id).toBe("qwen3.5-9b-video");
  expect(mocks.invoke).not.toHaveBeenCalled();
});
it("reconciles storage, native-window and focus signals from the latest saved value", async () => {
  const { result } = renderHook(() => usePictureModelPreference());
  await act(async () => {});
  act(() => {
    localStorage.setItem(PICTURE_MODEL_KEY, "qwen3.5-4b-video");
    window.dispatchEvent(new StorageEvent("storage", { key: PICTURE_MODEL_KEY }));
  });
  expect(result.current.id).toBe("qwen3.5-4b-video");
  act(() => { localStorage.setItem(PICTURE_MODEL_KEY, "qwen3.5-9b-video"); mocks.preference?.(); });
  expect(result.current.id).toBe("qwen3.5-9b-video");
  act(() => { localStorage.setItem(PICTURE_MODEL_KEY, "ast-audioset"); window.dispatchEvent(new Event("focus")); });
  expect(result.current.id).toBe("qwen3.5-9b-video");
});
it("does not claim a new default when saving fails", async () => {
  const { result } = renderHook(() => usePictureModelPreference());
  await act(async () => {});
  vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("Full"); });
  act(() => result.current.select("qwen3.5-4b-video"));
  expect(result.current.id).toBe("qwen3.5-9b-video");
  expect(result.current.error).toContain("Could not save");
});
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

it("keeps verified installations usable during a focus refresh, but invalidates a model-change event", async () => {
  const models = ["qwen3.5-9b-video", "qwen3.5-4b-video"].map(id => ({ id, ready: true }));
  mocks.invoke.mockResolvedValueOnce({ models });
  const { result } = renderHook(() => usePictureModel());
  await waitFor(() => expect(result.current.ready).toBe(true));
  let finishRefresh!: (value: unknown) => void;
  mocks.invoke.mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; }));
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
  expect(result.current.ready).toBe(true);
  expect(result.current.models).toEqual(models);
  mocks.invoke.mockResolvedValueOnce({ models: models.map(model => ({ ...model, ready: false })) });
  act(() => { mocks.changed?.(); });
  expect(result.current.ready).toBe(false);
  await act(async () => { finishRefresh({ models }); });
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(result.current.models?.every(model => !model.ready)).toBe(true));
  expect(result.current.ready).toBe(false);
});

it("does not keep stale readiness after a focus verification fails", async () => {
  mocks.invoke.mockResolvedValueOnce({ models: [{ id: "qwen3.5-9b-video", ready: true }] });
  const { result } = renderHook(() => usePictureModel());
  await waitFor(() => expect(result.current.ready).toBe(true));
  mocks.invoke.mockRejectedValueOnce(new Error("Model verification failed"));
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await waitFor(() => expect(result.current.ready).toBe(false));
  expect(result.current.error).toContain("Model verification failed");
});
