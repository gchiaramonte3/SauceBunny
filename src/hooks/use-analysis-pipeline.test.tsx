// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAnalysisPipeline } from "./use-analysis-pipeline";
import type { AnalysisPipelineEvent } from "../lib/scene-analysis/pipeline";
const mocks = vi.hoisted(() => ({ listen: vi.fn(), off: vi.fn(), log: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
beforeEach(() => { vi.resetAllMocks(); mocks.listen.mockResolvedValue(mocks.off); });
afterEach(cleanup);
const packet = (runId: string, sequence: number, status: AnalysisPipelineEvent["status"]): AnalysisPipelineEvent =>
  ({ runId, sequence, status, tag: "info", message: "clip.mp4 · Model processed shot 1 of 113; batch results pending." });
function send(payload: unknown) { act(() => mocks.listen.mock.calls[0][1]({ payload })); }
it("collects docked/detached runs without duplicate, stale, or cross-run terminal state", async () => {
  const { result, unmount } = renderHook(() => useAnalysisPipeline(mocks.log));
  await act(async () => {});
  send(packet("main-run", 1, "active")); send(packet("panel-run", 1, "active"));
  send(packet("main-run", 2, "finished"));
  expect(result.current).toBe("analyzing");
  send(packet("panel-run", 2, "stopping"));
  expect(result.current).toBe("stopping");
  send(packet("panel-run", 3, "finished"));
  expect(result.current).toBeUndefined();
  send(packet("panel-run", 1, "active")); send(packet("panel-run", 4, "active")); send({ message: "bad" });
  expect(result.current).toBeUndefined();
  expect(mocks.log).toHaveBeenCalledTimes(5);
  expect(mocks.log).toHaveBeenCalledWith("info", "video-ai", expect.stringContaining("clip.mp4"));
  unmount(); send(packet("late-run", 1, "active"));
  expect(mocks.log).toHaveBeenCalledTimes(5); expect(mocks.off).toHaveBeenCalledOnce();
});
