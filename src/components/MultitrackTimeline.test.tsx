// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { multitrackFixture, multitrackGroupFixture, multitrackTranscript } from "../test/multitrack-fixture";
import { MultitrackTimeline } from "./MultitrackTimeline";

afterEach(cleanup);

it("shows a status only as each track's saved result arrives and restores it on reopening", () => {
  const document = multitrackFixture();
  const props = { document, waveforms: {}, waveformErrors: {}, selected: new Set<string>(), solo: new Set<string>(), onSelect: vi.fn(), onRename: vi.fn(), onSeek: vi.fn(), frame: 0 };
  const view = render(<MultitrackTimeline {...props} />);
  expect(screen.queryAllByRole("img")).toHaveLength(0);
  expect(view.container.querySelectorAll(".cp-multitrack-saved-status")).toHaveLength(3);
  const committed = { ...document, transcripts: [{ ...multitrackTranscript(), duration_frames: document.manifest.duration_frames }] };
  view.rerender(<MultitrackTimeline {...props} document={committed} />);
  expect(screen.getByRole("img", { name: "Alex: Transcribed. Transcript saved." })).toBeTruthy();
  expect(screen.queryAllByRole("img")).toHaveLength(1);
  // Playback, selection and a new generation attempt have no effect on the
  // persisted result. Only replacing the document's committed data changes it.
  view.rerender(<MultitrackTimeline {...props} document={committed} selected={new Set(["track-2"])} frame={120} />);
  expect(screen.queryAllByRole("img")).toHaveLength(1);
  view.unmount();
  render(<MultitrackTimeline {...props} document={JSON.parse(JSON.stringify(committed))} />);
  expect(screen.getByRole("img", { name: "Alex: Transcribed. Transcript saved." })).toBeTruthy();
});

it("distinguishes saved empty and timing-review results without implying full-range coverage", () => {
  const document = multitrackFixture();
  document.transcripts = [
    { ...multitrackTranscript(), status: "empty", cues: [], duration_frames: document.manifest.duration_frames },
    { ...multitrackTranscript("track-2"), status: "review" },
  ];
  render(<MultitrackTimeline document={document} waveforms={{}} waveformErrors={{}} selected={new Set()} solo={new Set()} onSelect={vi.fn()} onRename={vi.fn()} onSeek={vi.fn()} frame={0} />);
  expect(screen.getByRole("img", { name: "Alex: Transcribed. No speech found; result saved." }).classList.contains("is-saved")).toBe(true);
  const review = screen.getByRole("img", { name: "Sam mic: Selected range transcribed. Transcript saved; timing review needed." });
  expect(review.classList.contains("needs-review")).toBe(true);
  expect(review.title).toBe(review.getAttribute("aria-label"));
});

it("keeps saved status tied to track identity across owner edits, offline media and group expansion", () => {
  const document = multitrackGroupFixture();
  document.transcripts = [multitrackTranscript("track-2")];
  document.manifest.graph!.lanes[1].availability = "offline";
  const props = { document, waveforms: {}, waveformErrors: {}, selected: new Set<string>(), solo: new Set<string>(), onSelect: vi.fn(), onRename: vi.fn(), onSeek: vi.fn(), frame: 0 };
  const view = render(<MultitrackTimeline {...props} />);
  expect(screen.queryAllByRole("img")).toHaveLength(0);
  view.rerender(<MultitrackTimeline {...props} expanded={new Set(["track-1"])} />);
  expect(screen.getByRole("img", { name: /Sam mic: Selected range transcribed/ })).toBeTruthy();
  const renamed = { ...document, labels: [...document.labels, { track_id: "track-2", owner_name: "Renamed mic", cast_member_id: null, color: null }] };
  view.rerender(<MultitrackTimeline {...props} document={renamed} expanded={new Set(["track-1"])} />);
  expect(screen.getByRole("img", { name: /Renamed mic: Selected range transcribed/ })).toBeTruthy();
  view.rerender(<MultitrackTimeline {...props} document={{ ...renamed, transcripts: [] }} expanded={new Set(["track-1"])} />);
  expect(screen.queryAllByRole("img")).toHaveLength(0);
});

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
