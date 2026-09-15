// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { multitrackFixture, multitrackTranscript } from "../test/multitrack-fixture";
import { MultitrackTimeline } from "./MultitrackTimeline";

afterEach(cleanup);
it("keeps settled clip geometry cached during playhead ticks and refreshes on zoom", () => {
  const document = multitrackFixture();
  let reads = 0;
  for (const track of document.manifest.tracks) {
    const clip = track.clips[0];
    Object.defineProperty(clip, "start_frame", { get: () => { reads++; return 0; } });
  }
  const props = { document, waveforms: {}, waveformErrors: {}, selected: new Set<string>(), solo: new Set<string>(), onSelect: vi.fn(), onRename: vi.fn(), onSeek: vi.fn() };
  const view = render(<MultitrackTimeline {...props} frame={0} />);
  const settledReads = reads;
  expect(settledReads).toBeGreaterThan(0);
  for (let frame = 1; frame <= 24; frame++) view.rerender(<MultitrackTimeline {...props} frame={frame} />);
  expect(reads).toBe(settledReads);
  expect(screen.getByRole("slider", { name: "Seek Alex mic" }).getAttribute("aria-valuenow")).toBe("24");
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(reads).toBeGreaterThan(settledReads);
});

it("preserves overlay visibility, clipping, toggles and document replacements", () => {
  const document = multitrackFixture();
  document.transcripts = [multitrackTranscript()];
  const props = { document, waveforms: {}, waveformErrors: {}, selected: new Set<string>(), solo: new Set<string>(), onSelect: vi.fn(), onRename: vi.fn(), onSeek: vi.fn() };
  const view = render(<MultitrackTimeline {...props} frame={0} />);
  fireEvent.click(screen.getByRole("button", { name: "Text overlay Alex mic" }));
  expect(screen.getByText("1 passage")).toBeTruthy();
  view.rerender(<MultitrackTimeline {...props} frame={12000} />);
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(screen.queryByText("This is the first answer.")).toBeNull();
  expect(screen.getByText("No transcript in this view")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Fit" }));
  expect(screen.getByText("1 passage")).toBeTruthy();
  view.rerender(<MultitrackTimeline {...props} document={{ ...document, transcripts: [] }} frame={0} />);
  expect(screen.queryByText("This is the first answer.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Text overlay Alex mic" }));
  expect(screen.queryByText("No transcript in this view")).toBeNull();
});
