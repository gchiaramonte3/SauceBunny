// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { multitrackFixture } from "../test/multitrack-fixture";
import { useMultitrackDetail } from "./use-multitrack-detail";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => { vi.useFakeTimers(); invoke.mockReset(); invoke.mockResolvedValue({ peaks: [[-0.5, 0.5]] }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("debounces detail, caps native concurrency at two, and cancels a superseded view", async () => {
  const pending: Array<(value: unknown) => void> = [];
  invoke.mockImplementation((command) => command === "aaf_waveform" ? new Promise((resolve) => pending.push(resolve)) : Promise.resolve());
  const document = multitrackFixture();
  const { result, rerender } = renderHook(({ start, enabled }) => useMultitrackDetail(document, start, 240, enabled), { initialProps: { start: 0, enabled: true } });
  await act(async () => { vi.advanceTimersByTime(79); }); expect(invoke).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(1); });
  const jobs = invoke.mock.calls.filter(([command]) => command === "aaf_waveform");
  expect(jobs).toHaveLength(2);
  expect(jobs[0][1]).toMatchObject({ startFrame: 0, durationFrames: 240 });
  rerender({ start: 480, enabled: false });
  expect(invoke.mock.calls.filter(([command]) => command === "cancel_job").map(([, args]) => args.jobId)).toEqual(jobs.map(([, args]) => args.jobId));
  await act(async () => { pending.forEach((resolve) => resolve({ peaks: [[-1, 1]] })); vi.advanceTimersByTime(300); });
  expect(result.current).toEqual({});
  expect(invoke.mock.calls.filter(([command]) => command === "aaf_waveform")).toHaveLength(2);
});

it("does no work while dragging, serves long views from peaks, and reuses prior zooms", async () => {
  const document = multitrackFixture();
  const { rerender } = renderHook(({ span, enabled }) => useMultitrackDetail(document, 0, span, enabled), { initialProps: { span: 240, enabled: false } });
  await act(async () => { vi.advanceTimersByTime(300); });
  expect(invoke).not.toHaveBeenCalled();
  rerender({ span: 24000, enabled: true });
  await act(async () => { vi.advanceTimersByTime(300); });
  expect(invoke.mock.calls.filter(([command]) => command === "aaf_waveform")).toHaveLength(3);
  rerender({ span: 240, enabled: true });
  await act(async () => { vi.advanceTimersByTime(300); });
  expect(invoke.mock.calls.filter(([command]) => command === "aaf_waveform")).toHaveLength(6);
  rerender({ span: 24000, enabled: true });
  await act(async () => { vi.advanceTimersByTime(300); });
  expect(invoke.mock.calls.filter(([command]) => command === "aaf_waveform")).toHaveLength(6);
});
