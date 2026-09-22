// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MultitrackTranscript } from "./MultitrackTranscript";
import { multitrackFixture, multitrackTranscript } from "../test/multitrack-fixture";
import { exportMultitrack, transcriptRows } from "../lib/multitrack";
import * as multitrack from "../lib/multitrack";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function fixture() {
  const document = multitrackFixture();
  document.transcripts = [{ ...multitrackTranscript(), status: "review", timing_issues: [{ id: "bad-cue", text: "Words that must not disappear.", reported_timing: "00:00:20,000 --> 00:00:20,000", reason: "Empty time range", chunk_start_frame: 0 }] }];
  return document;
}
it("preserves and searches unplaced text without creating a false seek control", () => {
  const document = fixture(), seek = vi.fn();
  render(<MultitrackTranscript document={document} frame={0} solo={new Set()} onSeek={seek} />);
  expect(screen.getByText("Words that must not disappear.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Words that must not disappear/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /This is the first answer/ }));
  expect(seek).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "must not disappear" } });
  expect(screen.queryByRole("button", { name: /This is the first answer/ })).toBeNull();
  expect(screen.getByText("Words that must not disappear.")).toBeTruthy();
  expect(transcriptRows(document)).toHaveLength(1);
  expect(exportMultitrack(document, "txt")).toContain("Timing needs review  Alex");
  const csv = exportMultitrack(document, "csv").split("\r\n").at(-1)!;
  expect(csv).toContain('"Alex","","","Words that must not disappear."');
});
it("exports an all-untimed result and does not mislabel it as no speech", () => {
  const document = fixture(); document.transcripts[0].cues = [];
  render(<MultitrackTranscript document={document} frame={0} solo={new Set()} onSeek={vi.fn()} />);
  expect(screen.queryByText(/No speech found/)).toBeNull();
  expect((screen.getByRole("button", { name: "Export Alex" }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByText(/Timing review: 1 passage/)).toBeTruthy();
});
it("opens on a person, supports all voices and exposes every person in the overflow picker", () => {
  const document = fixture(); document.transcripts.push({ ...multitrackTranscript("track-2"), cues: [{ ...multitrackTranscript().cues[0], text: "Sam's answer." }] });
  const seek = vi.fn(); render(<MultitrackTranscript document={document} frame={250} solo={new Set()} onSeek={seek} />);
  expect(screen.getByRole("tab", { name: "Alex" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByText("Sam's answer.")).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Choose transcript" }), { target: { value: "track:track-2" } });
  expect(screen.getByRole("tabpanel", { name: "Sam mic" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Sam's answer/ })); expect(seek).toHaveBeenCalledWith(239, "track-2");
  fireEvent.click(screen.getByRole("tab", { name: "All voices" }));
  expect(screen.getAllByRole("button", { name: /answer/ })).toHaveLength(2);
  fireEvent.keyDown(screen.getByRole("tab", { name: "All voices" }), { key: "End" });
  expect(screen.getByRole("tab", { name: "Room" }).getAttribute("aria-selected")).toBe("true");
});
it("reveals the first saved text automatically until a person is explicitly selected", () => {
  const document = multitrackFixture(), props = { frame: 0, solo: new Set<string>(), onSeek: vi.fn() };
  const view = render(<MultitrackTranscript {...props} document={document} />);
  const saved = { ...document, transcripts: [multitrackTranscript("track-2")] };
  view.rerender(<MultitrackTranscript {...props} document={saved} />);
  expect(screen.getByRole("tabpanel", { name: "Sam mic" })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Room" }));
  view.rerender(<MultitrackTranscript {...props} document={{ ...saved, transcripts: [...saved.transcripts, multitrackTranscript()] }} />);
  expect(screen.getByRole("tabpanel", { name: "Room" })).toBeTruthy();
});
it("opens on actual transcript content, skipping blank placeholders without hiding inaudible passages", () => {
  const document = multitrackFixture(), blank = multitrackTranscript(), speech = multitrackTranscript("track-2");
  blank.cues[0].text = "[BLANK_AUDIO]";
  speech.cues[0].text = "[inaudible]";
  document.transcripts = [blank, speech];
  render(<MultitrackTranscript document={document} frame={0} solo={new Set()} onSeek={vi.fn()} />);
  expect(screen.getByRole("tabpanel", { name: "Sam mic" })).toBeTruthy();
  expect(screen.getByText("[inaudible]")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "All voices" }));
  expect(screen.queryByText("[BLANK_AUDIO]")).toBeNull();
  expect(screen.getByText("[inaudible]")).toBeTruthy();
  expect(document.transcripts[0].cues[0].text).toBe("[BLANK_AUDIO]");
});
it("shows an honest failed-run summary with technical details collapsed", () => {
  const { container } = render(<MultitrackTranscript document={multitrackFixture()} frame={0} solo={new Set()} onSeek={vi.fn()} report={{ requested: 3, saved: 0, review: 0, empty: 0, stopped: false, failures: [{ trackId: "track-1", message: "Speech cue is outside its prepared audio range" }] }} />);
  expect(screen.getByText(/0 of 3 tracks saved/)).toBeTruthy();
  expect(screen.getByRole("heading", { name: "No new transcript was saved" })).toBeTruthy();
  expect(container.querySelector(".cp-multitrack-error")).toBeNull();
  const details = screen.getByText("Get Info").closest("details")!;
  expect(details.open).toBe(false);
  expect(within(details).getByText(/Speech cue is outside/)).toBeTruthy();
  expect(within(details).getByText(/Saved sequences/)).toBeTruthy();
});
it("does not reformat fixed transcript clocks on playback ticks; highlighting and new data stay live", () => {
  const document = fixture(), clock = vi.spyOn(multitrack, "sequenceTimecode");
  const props = { document, solo: new Set<string>(), onSeek: vi.fn() };
  const view = render(<MultitrackTranscript {...props} frame={0} />);
  const initial = clock.mock.calls.length;
  expect(initial).toBeGreaterThan(0);
  const cue = screen.getByRole("button", { name: /This is the first answer/ });
  expect(cue.classList.contains("is-current")).toBe(false);
  view.rerender(<MultitrackTranscript {...props} frame={250} />);
  expect(cue.classList.contains("is-current")).toBe(true);
  expect(clock).toHaveBeenCalledTimes(initial);
  view.rerender(<MultitrackTranscript {...props} frame={350} />);
  expect(cue.classList.contains("is-current")).toBe(false);
  expect(clock).toHaveBeenCalledTimes(initial);
  view.rerender(<MultitrackTranscript {...props} document={{ ...document, manifest: { ...document.manifest, start_frame: 0 } }} frame={0} />);
  expect(clock.mock.calls.length).toBeGreaterThan(initial);
});
