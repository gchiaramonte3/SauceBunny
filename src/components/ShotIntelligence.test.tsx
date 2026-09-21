// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ShotIntelligence } from "./ShotIntelligence";
vi.mock("../hooks/use-picture-model", () => ({ usePictureModel: () => ({ id: "qwen3.5-9b-video", ready: true, models: [{ id: "qwen3.5-9b-video", ready: true }], select: vi.fn() }) }));

vi.mock("../hooks/use-shot-intelligence", () => ({ useShotIntelligence: () => ({
  busy: false, stopping: false, draining: false, error: "", nativeError: "", audioError: "",
  phase: "", progress: null, audio: { status: "not-started" }, answers: [],
  start: vi.fn(), stop: vi.fn(),
  evidence: { id: "fixture", detection: { boundaries: [{}] }, shots: [
    { id: "1", start_us: 0, end_us: 1_500_002, transcript: "" },
    { id: "2", start_us: 1_500_002, end_us: 3_000_003, transcript: "" },
  ] },
}) }));
afterEach(() => { cleanup(); localStorage.clear(); });

it("groups an accurately pluralized cut count and action without a separate toolbar", () => {
  const changed = vi.fn(), seek = vi.fn();
  render(<ShotIntelligence videoPath="/fixture.mp4" transcriptPath={null} sourceKey="fixture"
    onBusyChange={vi.fn()} onCutMarkersChanged={changed} onSeek={seek} />);
  const count = screen.getByText("2 shots · 1 cut");
  const action = screen.getByRole("button", { name: "Add cut markers" });
  expect(count.parentElement).toBe(action.parentElement);
  expect(action.closest(".cp-shot-summary")).not.toBeNull();
  expect(screen.queryByText(/detected cuts/)).toBeNull();
  fireEvent.click(action);
  expect(changed).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "00:01.500 to 00:03.000" }));
  expect(seek).toHaveBeenCalledWith(1.500002);
});
