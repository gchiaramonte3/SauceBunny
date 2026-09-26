// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AnalysisEditDocument } from "../bindings/AnalysisEditDocument";
import { emptyCorrection } from "../lib/scene-analysis/corrections";
import { useAnalysisCorrections } from "./use-analysis-corrections";
const api = vi.hoisted(() => ({ invoke: vi.fn(), receive: null as ((event: { payload: AnalysisEditDocument }) => void) | null }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn((_name, callback) => { api.receive = callback; return Promise.resolve(vi.fn()); }) }));
const doc: AnalysisEditDocument = { schema_version: 1, revision: 1, source: { path: "/clip.mp4", sha256: "a".repeat(64), origin_us: 0, duration_us: 10e6 }, fps: 24, model: "model", corrections: { "0:2000000": { ...emptyCorrection(), revision: 1, picture: "User" } },
  rows: [{ id: 1, start_us: 0, end_us: 2e6, picture: "Original", dialogue: "", summary: "" }] };
beforeEach(() => { api.invoke.mockReset(); api.receive = null; }); afterEach(cleanup);
it("restores native saved corrections, including a baseline for reopening without inference", async () => {
  api.invoke.mockResolvedValue(doc);
  const hook = renderHook(() => useAnalysisCorrections("/clip.mp4", null));
  await waitFor(() => expect(hook.result.current.doc).toEqual(doc));
  expect(hook.result.current.loading).toBe(false);
  expect(api.invoke).toHaveBeenCalledWith("load_analysis_corrections", { path: "/clip.mp4" });
});
it("does not apply filename-matching corrections to changed source contents", async () => {
  api.invoke.mockResolvedValue(doc);
  const hook = renderHook(() => useAnalysisCorrections("/clip.mp4", { ...doc, source: { ...doc.source, sha256: "b".repeat(64) } }));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  expect(hook.result.current.doc).toBeNull();
});
it("hides old results immediately and does not let delayed responses leak across sources", async () => {
  let finish!: (value: AnalysisEditDocument) => void;
  api.invoke.mockImplementation((_cmd, args) => args.path === "/clip.mp4" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(null));
  const hook = renderHook(({ path }) => useAnalysisCorrections(path, null), { initialProps: { path: "/clip.mp4" } });
  hook.rerender({ path: "/next.mp4" });
  await act(async () => finish(doc));
  expect(hook.result.current.doc).toBeNull();
});
it("keeps committed responses and events revision-ordered", async () => {
  api.invoke.mockResolvedValue(doc);
  const hook = renderHook(() => useAnalysisCorrections("/clip.mp4", doc));
  await waitFor(() => expect(hook.result.current.doc?.revision).toBe(1));
  act(() => api.receive?.({ payload: { ...doc, revision: 3 } }));
  act(() => api.receive?.({ payload: { ...doc, revision: 2 } }));
  expect(hook.result.current.doc?.revision).toBe(3);
});
it("does not drop a dispatched native save when navigating away", async () => {
  let finish!: (value: AnalysisEditDocument) => void;
  api.invoke.mockImplementation((cmd) => cmd === "load_analysis_corrections" ? Promise.resolve(doc) : new Promise(resolve => { finish = resolve; }));
  const hook = renderHook(({ path }) => useAnalysisCorrections(path, path === "/clip.mp4" ? doc : null), { initialProps: { path: "/clip.mp4" } });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  const pending = hook.result.current.save(doc, "0:2000000", emptyCorrection());
  api.invoke.mockResolvedValue(null); hook.rerender({ path: "/next.mp4" });
  await act(async () => { finish({ ...doc, revision: 2 }); await pending; });
  expect(hook.result.current.doc).toBeNull();
});
it("reloads the disk revision after a rejected save even when a window missed the event", async () => {
  api.invoke.mockResolvedValue(doc);
  const hook = renderHook(() => useAnalysisCorrections("/clip.mp4", doc));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  api.invoke.mockImplementation(cmd => cmd === "save_analysis_correction" ? Promise.reject(new Error("Stale row")) : Promise.resolve({ ...doc, revision: 4 }));
  await act(async () => { await expect(hook.result.current.save(doc, "0:2000000", emptyCorrection())).rejects.toThrow("Stale row"); });
  expect(hook.result.current.doc?.revision).toBe(4);
});
it("rehashes on a same-path source reload and immediately hides the prior file's edits", async () => {
  api.invoke.mockResolvedValue(doc);
  const hook = renderHook(({ generation }) => useAnalysisCorrections("/clip.mp4", null, generation), { initialProps: { generation: "first" } });
  await waitFor(() => expect(hook.result.current.doc).toEqual(doc));
  api.invoke.mockResolvedValue(null);
  hook.rerender({ generation: "replaced" });
  expect(hook.result.current.doc).toBeNull();
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  expect(hook.result.current.doc).toBeNull(); expect(api.invoke).toHaveBeenCalledTimes(2);
});
