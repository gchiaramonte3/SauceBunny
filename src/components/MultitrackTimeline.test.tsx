// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { multitrackFixture, multitrackGroupFixture, multitrackTranscript } from "../test/multitrack-fixture";
import { MultitrackTimeline } from "./MultitrackTimeline";

afterEach(cleanup);

/** The status glyphs beside the mic owners: buttons that explain themselves (MultitrackTrackStatus). */
const statuses = () => screen.queryAllByRole("button", { name: /: (Transcript saved|Timing needs review|No speech found)/ });
const untimed = (text: string) => ({ id: `issue-${text}`, text, reported_timing: "00:00:03,000 --> 00:00:03,000", chunk_start_frame: 0, reason: "The engine returned an empty or reversed time range." });

it("shows a status only as each track's saved result arrives and restores it on reopening", () => {
  const document = multitrackFixture();
  const props = { document, waveforms: {}, waveformErrors: {}, selected: new Set<string>(), solo: new Set<string>(), onSelect: vi.fn(), onRename: vi.fn(), onSeek: vi.fn(), frame: 0 };
  const view = render(<MultitrackTimeline {...props} />);
  expect(statuses()).toHaveLength(0);
  expect(view.container.querySelectorAll(".cp-multitrack-saved-status")).toHaveLength(3);
  const committed = { ...document, transcripts: [{ ...multitrackTranscript(), duration_frames: document.manifest.duration_frames }] };
  view.rerender(<MultitrackTimeline {...props} document={committed} />);
  expect(screen.getByRole("button", { name: "Alex: Transcript saved." })).toBeTruthy();
  expect(statuses()).toHaveLength(1);
  // Playback, selection and a new generation attempt have no effect on the
  // persisted result. Only replacing the document's committed data changes it.
  view.rerender(<MultitrackTimeline {...props} document={committed} selected={new Set(["track-2"])} frame={120} />);
  expect(statuses()).toHaveLength(1);
  view.unmount();
  render(<MultitrackTimeline {...props} document={JSON.parse(JSON.stringify(committed))} />);
  expect(screen.getByRole("button", { name: "Alex: Transcript saved." })).toBeTruthy();
});

it("distinguishes saved, empty and timing-review results without implying full-range coverage", () => {
  const document = multitrackFixture();
  document.transcripts = [
    { ...multitrackTranscript(), status: "empty", cues: [], duration_frames: document.manifest.duration_frames },
    { ...multitrackTranscript("track-2"), status: "review", timing_issues: [untimed("Words the engine gave no time.")] },
  ];
  render(<MultitrackTimeline document={document} waveforms={{}} waveformErrors={{}} selected={new Set()} solo={new Set()} onSelect={vi.fn()} onRename={vi.fn()} onSeek={vi.fn()} frame={0} />);
  // No speech is not success: its own neutral glyph.
  expect(screen.getByRole("button", { name: "Alex: No speech found." }).classList.contains("is-empty")).toBe(true);
  const review = screen.getByRole("button", { name: "Sam mic: Timing needs review. Selected range transcribed." });
  expect(review.classList.contains("needs-review")).toBe(true);
  expect(review.title).toBe(review.getAttribute("aria-label"));
});

it("explains the \"!\" on a click, and its actions open that track's passages and Transcript info", () => {
  const document = multitrackFixture();
  document.transcripts = [{ ...multitrackTranscript("track-2"), status: "review", timing_issues: [untimed("First."), untimed("Second.")] }];
  const onReviewTiming = vi.fn(), onTranscriptInfo = vi.fn();
  render(<MultitrackTimeline document={document} waveforms={{}} waveformErrors={{}} selected={new Set()} solo={new Set()} onSelect={vi.fn()} onRename={vi.fn()} onSeek={vi.fn()} frame={0}
    onReviewTiming={onReviewTiming} onTranscriptInfo={onTranscriptInfo} />);
  const glyph = screen.getByRole("button", { name: /Sam mic: Timing needs review/ });
  expect(glyph.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(glyph);
  const popover = screen.getByRole("dialog", { name: /Sam mic: Timing needs review/ });
  expect(popover.textContent).toContain("2 passages were saved without a place on the timeline");
  expect(popover.textContent).toContain("nothing is lost");
  fireEvent.click(screen.getByRole("button", { name: "Review 2 passages" }));
  expect(onReviewTiming).toHaveBeenCalledWith("track-2");
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(glyph);
  fireEvent.click(screen.getByRole("button", { name: "Transcript info" }));
  expect(onTranscriptInfo).toHaveBeenCalledTimes(1);
  fireEvent.click(glyph);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("shows no \"!\" when the only passages kept off the timeline are placeholders with no words", () => {
  const document = multitrackFixture();
  document.transcripts = [{ ...multitrackTranscript(), status: "review", duration_frames: document.manifest.duration_frames, timing_issues: [untimed("[BLANK_AUDIO]")] }];
  render(<MultitrackTimeline document={document} waveforms={{}} waveformErrors={{}} selected={new Set()} solo={new Set()} onSelect={vi.fn()} onRename={vi.fn()} onSeek={vi.fn()} frame={0} />);
  expect(screen.getByRole("button", { name: "Alex: Transcript saved." }).classList.contains("is-saved")).toBe(true);
});

it("keeps saved status tied to track identity across owner edits, offline media and group expansion", () => {
  const document = multitrackGroupFixture();
  document.transcripts = [multitrackTranscript("track-2")];
  document.manifest.graph!.lanes[1].availability = "offline";
  const props = { document, waveforms: {}, waveformErrors: {}, selected: new Set<string>(), solo: new Set<string>(), onSelect: vi.fn(), onRename: vi.fn(), onSeek: vi.fn(), frame: 0 };
  const view = render(<MultitrackTimeline {...props} />);
  expect(statuses()).toHaveLength(0);
  view.rerender(<MultitrackTimeline {...props} expanded={new Set(["track-1"])} />);
  expect(screen.getByRole("button", { name: /Sam mic: Transcript saved. Selected range transcribed/ })).toBeTruthy();
  const renamed = { ...document, labels: [...document.labels, { track_id: "track-2", owner_name: "Renamed mic", cast_member_id: null, color: null }] };
  view.rerender(<MultitrackTimeline {...props} document={renamed} expanded={new Set(["track-1"])} />);
  expect(screen.getByRole("button", { name: /Renamed mic: Transcript saved. Selected range transcribed/ })).toBeTruthy();
  view.rerender(<MultitrackTimeline {...props} document={{ ...renamed, transcripts: [] }} expanded={new Set(["track-1"])} />);
  expect(statuses()).toHaveLength(0);
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
  // The slider is the same zoom, one stop per doubling.
  const zoom = screen.getByRole("slider", { name: "Zoom" });
  expect(zoom.getAttribute("aria-valuetext")).toBe("1×");
  fireEvent.change(zoom, { target: { value: "3" } });
  expect(zoom.getAttribute("aria-valuetext")).toBe("8×");
  expect((screen.getByRole("button", { name: "Zoom out" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Fit" }));
  expect(zoom.getAttribute("aria-valuetext")).toBe("1×");
  view.rerender(<MultitrackTimeline {...props} document={{ ...document, transcripts: [] }} frame={0} />);
  expect(screen.queryByText("This is the first answer.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Text overlay Alex mic" }));
  expect(screen.queryByText("No transcript in this view")).toBeNull();
});
it("a failed waveform offers a retry for that track and shows the error on hover", () => {
  const document = multitrackFixture(), retry = vi.fn();
  render(<MultitrackTimeline document={document} waveforms={{}} waveformErrors={{ "track-1": "Decoder failed" }} selected={new Set()} solo={new Set()} onSelect={vi.fn()} onRename={vi.fn()} onSeek={vi.fn()} frame={0} onRetryWaveform={retry} />);
  const button = screen.getByRole("button", { name: `Retry waveform for ${document.manifest.tracks[0].name}` });
  expect(button.parentElement?.getAttribute("title")).toBe("Decoder failed");
  fireEvent.click(button);
  expect(retry).toHaveBeenCalledWith("track-1");
});

it("says when separate range runs left part of a track untranscribed, and saves a trimmed owner name", () => {
  const document = multitrackFixture();
  document.transcripts = [{ ...multitrackTranscript(), start_frame: 0, duration_frames: 2400, gaps: [[240, 1200]] }];
  const onRename = vi.fn();
  render(<MultitrackTimeline document={document} waveforms={{}} waveformErrors={{}} selected={new Set()} solo={new Set()} onSelect={vi.fn()} onRename={onRename} onSeek={vi.fn()} frame={0} />);
  expect(screen.getByRole("button", { name: /Alex: Transcript saved. Selected ranges transcribed, 1 gap left out/ })).toBeTruthy();
  const owner = screen.getByRole("textbox", { name: "Mic owner for track-2" });
  fireEvent.change(owner, { target: { value: "  Sam  " } }); fireEvent.blur(owner);
  expect(onRename).toHaveBeenCalledWith("track-2", "Sam");
});
it("draws In and Out on the ruler as Clip does: a lone stem and wing each, or a winged range", () => {
  const document = multitrackFixture(); // 24000 frames at 1x
  const props = { document, waveforms: {}, waveformErrors: {}, selected: new Set<string>(), solo: new Set<string>(), onSelect: vi.fn(), onRename: vi.fn(), onSeek: vi.fn(), frame: 0 };
  const view = render(<MultitrackTimeline {...props} marks={{ in: 6000, out: null }} />);
  const ruler = view.container.querySelector(".cp-multitrack-ruler")!;
  const lone = ruler.querySelector(".cp-mark.in") as HTMLElement;
  expect(lone.style.left).toBe("25%");
  expect(ruler.querySelector(".cp-mark-range")).toBeNull();
  // Out includes its frame, so its stem stands after it.
  view.rerender(<MultitrackTimeline {...props} marks={{ in: null, out: 11999 }} />);
  expect((ruler.querySelector(".cp-mark.out") as HTMLElement).style.left).toBe("50%");
  view.rerender(<MultitrackTimeline {...props} marks={{ in: 6000, out: 11999 }} />);
  const range = ruler.querySelector(".cp-mark-range") as HTMLElement;
  expect([range.style.left, range.style.width]).toEqual(["25%", "25%"]);
  expect(ruler.querySelectorAll(".cp-mark")).toHaveLength(0);
  view.rerender(<MultitrackTimeline {...props} />);
  expect(ruler.querySelectorAll(".cp-mark, .cp-mark-range")).toHaveLength(0);
});
