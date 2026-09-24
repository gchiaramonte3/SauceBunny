// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MultitrackExport } from "./MultitrackExport";
import { multitrackFixture, multitrackGroupFixture, multitrackTranscript } from "../test/multitrack-fixture";
const download = vi.hoisted(() => vi.fn());
const downloadPeople = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({ phase: "idle" }));
vi.mock("../hooks/use-multitrack-export", () => ({ useMultitrackExport: () => ({ phase: state.phase, status: "", error: null, download, downloadPeople, clearResolution: vi.fn() }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); state.phase = "idle"; });
it("reuses the bulk action for independent group microphone files", () => {
  const document = multitrackGroupFixture(); document.transcripts = [multitrackTranscript("track-2")];
  render(<MultitrackExport document={document} selectedTracks={new Set(["track-2"])} />);
  const button = screen.getByRole("button", { name: "Avid files by microphone" });
  expect(button.textContent).toBe("Avid by mic"); expect(button.title).toContain("parent sequence track");
  fireEvent.click(button); expect(downloadPeople).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "Avid files by person" })).toBeNull();
});
it.each(["txt", "csv", "avid", "srt", "pdf"])("Entire transcript honors %s even when viewing one person", (format) => {
  const document = multitrackFixture(); document.transcripts = [multitrackTranscript(), multitrackTranscript("track-2")];
  render(<MultitrackExport document={document} person={{ id: "sam", name: "Sam", trackIds: ["track-2"], color: null }} />);
  fireEvent.change(screen.getByRole("combobox", { name: "Transcript export format" }), { target: { value: format } });
  fireEvent.click(screen.getByRole("button", { name: "Entire transcript" }));
  expect(download).toHaveBeenLastCalledWith(format);
  fireEvent.click(screen.getByRole("button", { name: "Export Sam" }));
  expect(download).toHaveBeenLastCalledWith(format, ["track-2"], "Sam");
});
it.each(["txt", "csv", "avid", "srt", "pdf", "print"])("exports only checked tracks as %s, independently of the displayed person", format => {
  const document = multitrackFixture(); document.transcripts = [multitrackTranscript(), multitrackTranscript("track-2"), multitrackTranscript("track-3")];
  const props = { document, person: { id: "sam", name: "Sam", trackIds: ["track-2"], color: null }, selectedTracks: new Set(["track-3", "track-1", "removed-track"]) };
  const view = render(<MultitrackExport {...props} />);
  fireEvent.change(screen.getByRole("combobox", { name: "Transcript export format" }), { target: { value: format } });
  fireEvent.click(screen.getByRole("button", { name: "Export selected (2)" }));
  expect(download).toHaveBeenLastCalledWith(format, ["track-1", "track-3"], "Selected tracks");
  view.rerender(<MultitrackExport {...props} selectedTracks={new Set(["track-2"])} />);
  fireEvent.click(screen.getByRole("button", { name: "Export selected (1)" }));
  expect(download).toHaveBeenLastCalledWith(format, ["track-2"], "Selected tracks");
  state.phase = "loading";
  view.rerender(<MultitrackExport {...props} />);
  expect((screen.getByRole("button", { name: "Export selected (2)" }) as HTMLButtonElement).disabled).toBe(true);
});
it("does not fall back to all voices for empty, ungenerated, or blank-only selections", () => {
  const document = multitrackFixture(); document.transcripts = [multitrackTranscript(), { ...multitrackTranscript("track-2"), cues: [], status: "empty" }];
  const view = render(<MultitrackExport document={document} selectedTracks={new Set()} />);
  expect((screen.getByRole("button", { name: "Export selected (0)" }) as HTMLButtonElement).disabled).toBe(true);
  for (const id of ["track-2", "track-3"]) {
    view.rerender(<MultitrackExport document={document} selectedTracks={new Set([id])} />);
    const button = screen.getByRole("button", { name: "Export selected (1)" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); fireEvent.click(button);
  }
  expect(download).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "Entire transcript" }) as HTMLButtonElement).disabled).toBe(false);
});
it("keeps selected untimed text for text/PDF/print but disables timed-only formats", () => {
  const document = multitrackFixture();
  document.transcripts = [multitrackTranscript(), { ...multitrackTranscript("track-2"), cues: [], timing_issues: [{ id: "review", text: "[inaudible]", reason: "Invalid timing", reported_timing: "invalid", chunk_start_frame: 0 }] }];
  render(<MultitrackExport document={document} selectedTracks={new Set(["track-2"])} />);
  for (const format of ["txt", "csv", "pdf", "print", "avid", "srt"]) {
    fireEvent.change(screen.getByRole("combobox", { name: "Transcript export format" }), { target: { value: format } });
    expect((screen.getByRole("button", { name: "Export selected (1)" }) as HTMLButtonElement).disabled).toBe(format === "avid" || format === "srt");
  }
});
it.each(["txt", "csv", "avid", "srt", "pdf", "print"])("disables %s for placeholder-only results, but retains inaudible text", (format) => {
  const document = multitrackFixture(), track = multitrackTranscript();
  track.cues[0].text = "[BLANK_AUDIO]";
  track.timing_issues = [{ id: "blank", text: ".", reason: "Invalid timing", reported_timing: "invalid", chunk_start_frame: 0 }];
  document.transcripts = [track];
  const view = render(<MultitrackExport document={document} />);
  fireEvent.change(screen.getByRole("combobox", { name: "Transcript export format" }), { target: { value: format } });
  for (const name of ["Export transcript", "Entire transcript", "Avid files by person"]) {
    expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
  }
  view.rerender(<MultitrackExport document={{ ...document, transcripts: [{ ...track, cues: [{ ...track.cues[0], text: "[inaudible]" }] }] }} />);
  expect((screen.getByRole("button", { name: "Export transcript" }) as HTMLButtonElement).disabled).toBe(false);
});
