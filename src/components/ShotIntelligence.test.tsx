// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ShotIntelligence } from "./ShotIntelligence";

const data = vi.hoisted(() => ({ start: 0, end: 0, cuts: false, busy: false, model: "qwen3.5-9b-video", failure: "", audioError: "", models: [] as { id: string; ready: boolean }[] | null }));
vi.mock("../hooks/use-picture-model", () => ({ usePictureModel: () => ({ id: data.model, ready: data.models !== null, models: data.models, select: vi.fn() }) }));
vi.mock("../hooks/use-shot-intelligence", () => ({ useShotIntelligence: () => ({
  evidence: { id: "fixture", shots: data.cuts ? [
    { id: 1, start_us: 0, end_us: 1_500_002, transcript: "" },
    { id: 2, start_us: 1_500_002, end_us: 3_000_003, transcript: "" },
  ] : [{ id: 1, start_us: data.start, end_us: data.end, transcript: "Supplied words." }], detection: { boundaries: data.cuts ? [{}] : [] } },
  answers: [], audio: { status: "not-started" }, error: data.failure, audioError: data.audioError, nativeError: "", busy: data.busy, complete: false, modelUsed: "qwen3.5-9b-video", start: vi.fn(),
}) }));
beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }));
afterEach(() => { cleanup(); localStorage.clear(); data.cuts = false; data.busy = false; data.model = "qwen3.5-9b-video"; data.failure = ""; data.audioError = ""; data.models = []; vi.unstubAllGlobals(); });

it("keeps a running model displayed until the run ends even if Settings changes the default", () => {
  data.busy = true;
  const props = { videoPath: "/clip.mp4", transcriptPath: null, onBusyChange: vi.fn() };
  const { rerender } = render(<ShotIntelligence {...props} />);
  data.model = "qwen3.5-4b-video";
  rerender(<ShotIntelligence {...props} />);
  const select = screen.getByRole("combobox", { name: "Picture model" }) as HTMLSelectElement;
  expect(select.value).toBe("qwen3.5-9b-video"); expect(select.disabled).toBe(true);
  data.busy = false; rerender(<ShotIntelligence {...props} />);
  expect(select.value).toBe("qwen3.5-4b-video"); expect(select.disabled).toBe(false);
});

it("does not call unchecked installations missing while model verification is pending", () => {
  data.models = null;
  const props = { videoPath: "/clip.mp4", transcriptPath: null, onBusyChange: vi.fn() };
  const { rerender } = render(<ShotIntelligence {...props} />);
  expect(screen.getByRole("option", { name: "Qwen3.5 4B" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "Qwen3.5 9B" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Analyze video" }).hasAttribute("disabled")).toBe(true);
  data.models = [];
  rerender(<ShotIntelligence {...props} />);
  expect(screen.getByRole("option", { name: "Qwen3.5 4B (not installed)" })).toBeTruthy();
});

it("keeps the cut action beside Audio, outside the tablist, with a compact count above results", () => {
  data.cuts = true;
  const changed = vi.fn(), seek = vi.fn();
  render(<ShotIntelligence videoPath="/fixture.mp4" transcriptPath={null} sourceKey="fixture"
    onBusyChange={vi.fn()} onCutMarkersChanged={changed} onSeek={seek} />);
  const count = screen.getByText("2 shots · 1 cut");
  const action = screen.getByRole("button", { name: "Add cut markers" });
  expect(count.closest(".cp-shot-summary")).not.toBeNull();
  expect(action.closest(".cp-shot-toolbar")).toBe(screen.getByRole("tab", { name: "Audio" }).closest(".cp-shot-toolbar"));
  expect(action.closest('[role="tablist"]')).toBeNull();
  expect(screen.queryByText(/detected cuts/)).toBeNull();
  fireEvent.click(action);
  expect(changed).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Shot 2 start at 00:00:01:15" }));
  expect(seek).toHaveBeenCalledWith(1.500002);
});

describe("shot frame timecodes", () => {
  it.each([24000 / 1001, 30000 / 1001, 60000 / 1001])("uses %s fps for start/end and duration without changing the seek PTS", fps => {
    const base = Math.round(fps);
    data.start = Math.round((3600 * base + 1) / fps * 1e6);
    data.end = Math.round((3600 * base + 1 + base) / fps * 1e6);
    const seek = vi.fn();
    render(<ShotIntelligence fps={fps} videoPath="/clip.mp4" transcriptPath={null} onSeek={seek} onBusyChange={vi.fn()} />);
    const start = screen.getByRole("button", { name: "Shot 1 start at 01:00:00:01" });
    const end = screen.getByRole("button", { name: "Shot 1 end at 01:00:01:01" });
    expect(screen.getByTitle(`${base} frames`).textContent).toBe("00:00:01:00");
    expect(start.classList.contains("cp-tc")).toBe(true);
    fireEvent.click(start);
    expect(seek).toHaveBeenLastCalledWith(data.start / 1e6);
    fireEvent.click(end);
    expect(seek).toHaveBeenLastCalledWith(data.end / 1e6);
    expect(screen.getByTitle(`${base} frames`).querySelector("button")).toBeNull();
    expect(screen.queryByText(/non-drop-frame/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Analysis info" }));
    expect(screen.getByText(/non-drop-frame/)).toBeTruthy();
  });
});

it("disables both timecode controls when no seek action is available", () => {
  render(<ShotIntelligence videoPath="/clip.mp4" transcriptPath={null} onBusyChange={vi.fn()} />);
  expect(screen.getByRole("button", { name: /^Shot 1 start at/ }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: /^Shot 1 end at/ }).hasAttribute("disabled")).toBe(true);
});

it("keeps diagnostics out of the results while exposing a retry and an accessible info disclosure", () => {
  data.failure = "Analysis stopped to give playback or transcription priority.";
  data.audioError = "Audio decoder details";
  const props = { videoPath: "/clip.mp4", transcriptPath: null, onBusyChange: vi.fn() };
  const { rerender } = render(<ShotIntelligence {...props} />);
  expect(screen.getByText("Not generated")).toBeTruthy();
  expect(screen.queryByText(data.failure)).toBeNull();
  expect(screen.queryByText(/Picture results|Source audio has not been analyzed|Analysis could not finish/)).toBeNull();
  expect(screen.getByRole("button", { name: "Retry analysis" })).toBeTruthy();
  const trigger = screen.getByRole("button", { name: "Analysis info" });
  expect(trigger.title).toContain("attention needed");
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "Analysis info" })).toBeTruthy();
  expect(screen.getByText("Incomplete")).toBeTruthy();
  expect(screen.getByText(data.failure).closest("details")?.open).toBe(false);
  expect(screen.getByText(data.audioError)).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("button", { name: "Close analysis info" }), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  rerender(<ShotIntelligence {...props} videoPath="/next.mp4" />);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("uses native tab navigation without including the cut action in the tab group", () => {
  render(<ShotIntelligence videoPath="/clip.mp4" transcriptPath={null} onBusyChange={vi.fn()} />);
  fireEvent.keyDown(screen.getByRole("tab", { name: "All" }), { key: "End" });
  expect(screen.getByRole("tab", { name: "Audio" }).getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Audio" }));
  expect(screen.getByRole("status").textContent).toBe("Not analyzed");
});
