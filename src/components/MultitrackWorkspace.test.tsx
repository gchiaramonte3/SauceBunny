// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { multitrackFixture } from "../test/multitrack-fixture";
import { MultitrackWorkspace } from "./MultitrackWorkspace";
const mocks = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), seek: vi.fn().mockResolvedValue(undefined), pause: vi.fn(), toggle: vi.fn(), shuttle: vi.fn() }));
vi.mock("../hooks/use-multitrack-transcription", () => ({ useMultitrackTranscription: () => ({ engine: "parakeet", models: [], ready: true, loading: false, status: "", error: null, resolution: null, ...mocks }) }));
vi.mock("../hooks/use-multitrack-audition", () => ({ useMultitrackAudition: () => ({ ...mocks, frame: 0, rate: 0, solo: new Set(), mute: new Set(), scrubbing: true, volume: .8, muted: false }) }));
vi.mock("../hooks/use-multitrack-detail", () => ({ useMultitrackDetail: () => ({}) }));
vi.mock("./MultitrackCast", () => ({ MultitrackCast: () => <div>Save Mic Owners as Cast</div> }));
vi.mock("./MultitrackTranscript", () => ({ MultitrackTranscript: () => null }));
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);
it("Generate starts the whole sequence without a mic confirmation, from checked tracks only", () => {
  const document = multitrackFixture();
  render(<MultitrackWorkspace document={document} active waveforms={{}} waveformErrors={{}} labelStatus="" onRename={vi.fn()} onTranscript={vi.fn()} />);
  expect(screen.queryByText(/I reviewed the mic labels/)).toBeNull();
  expect(screen.queryByLabelText(/Start \(seconds\)/)).toBeNull();
  const button = screen.getByRole("button", { name: "Generate 3 tracks" }) as HTMLButtonElement;
  expect(button.disabled).toBe(false); fireEvent.click(button);
  expect(mocks.start).toHaveBeenCalledWith(["track-1", "track-2", "track-3"], 0, document.manifest.duration_frames);
  fireEvent.click(screen.getByRole("checkbox", { name: "Transcribe Sam mic" }));
  fireEvent.click(screen.getByRole("button", { name: "Generate 2 tracks" }));
  expect(mocks.start).toHaveBeenLastCalledWith(["track-1", "track-3"], 0, document.manifest.duration_frames);
});
it("JKL belongs to the active timeline, never editable mic names", () => {
  render(<MultitrackWorkspace document={multitrackFixture()} active waveforms={{}} waveformErrors={{}} labelStatus="" onRename={vi.fn()} onTranscript={vi.fn()} />);
  fireEvent.keyDown(window, { key: "l" }); expect(mocks.shuttle).toHaveBeenCalledWith(1);
  fireEvent.keyDown(window, { key: "k" }); expect(mocks.pause).toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "j" }); expect(mocks.seek).toHaveBeenCalledWith(-1, undefined, false);
  fireEvent.keyUp(window, { key: "k" }); mocks.shuttle.mockClear();
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Mic owner for track-1" }), { key: "l" });
  expect(mocks.shuttle).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Track actions for Alex" }));
  fireEvent.keyDown(screen.getByRole("menu", { name: "Actions for Alex" }), { key: "l" });
  expect(mocks.shuttle).not.toHaveBeenCalled();
});
it("rewind and fast-forward buttons use the same shuttle controls as J and L", () => {
  render(<MultitrackWorkspace document={multitrackFixture()} active waveforms={{}} waveformErrors={{}} labelStatus="" onRename={vi.fn()} onTranscript={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Rewind tracks" })); expect(mocks.shuttle).toHaveBeenLastCalledWith(-1);
  fireEvent.click(screen.getByRole("button", { name: "Fast-forward tracks" })); expect(mocks.shuttle).toHaveBeenLastCalledWith(1);
});
it("Escape abandons an edited mic name without committing it on blur", () => {
  const rename = vi.fn();
  render(<MultitrackWorkspace document={multitrackFixture()} active waveforms={{}} waveformErrors={{}} labelStatus="" onRename={rename} onTranscript={vi.fn()} />);
  const input = screen.getByRole("textbox", { name: "Mic owner for track-1" }) as HTMLInputElement;
  input.focus(); fireEvent.change(input, { target: { value: "Cancelled owner" } });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(input.value).toBe("Alex"); expect(rename).not.toHaveBeenCalled();
  input.focus(); fireEvent.change(input, { target: { value: "Saved owner" } }); fireEvent.keyDown(input, { key: "Enter" });
  expect(rename).toHaveBeenCalledWith("track-1", "Saved owner");
});
