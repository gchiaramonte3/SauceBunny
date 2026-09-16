// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShotAudioEvidence } from "./ShotAudioEvidence";
import type { AudioEvidence } from "../lib/scene-analysis/evidence";

afterEach(cleanup);
const evidence: AudioEvidence = { analysis_id: "test", source: { path: "/clip.mp4", sha256: "test", origin_us: 3e6, duration_us: 10e6 },
  audio_track_index: 0, classifier: "apple-soundanalysis-version1", preprocessing_version: "pcm48k-mono-3s-nonoverlap-v1", os: "Test OS",
  status: "decoded", windows: [
    { start_us: 1e6, end_us: 4e6, peak: .5, rms: .2, status: "classified",
      classifications: [{ identifier: "speech", score: .2 }, { identifier: "music", score: .8 }, { identifier: "musical_instrument", score: .4 }] },
    { start_us: 4e6, end_us: 7e6, peak: 0, rms: 0, status: "digital-silence", classifications: [] },
    { start_us: 8e6, end_us: 9e6, peak: .5, rms: .2, status: "insufficient-context", classifications: [] },
  ] };

describe("actual-audio evidence disclosure", () => {
  it("shows a tentative music type with source-range support and keeps raw diagnostics collapsed", async () => {
    const music = { ...evidence, classifier: "ast-audioset@f826b80d28226b62986cc218e5cec390b1096902",
      preprocessing_version: "pyav-swr16k-mono-10s-kaldi-ast-v1", labels: ["Music", "Electronic music", "Electronic dance music", "Jazz"],
      windows: [
        { start_us: 0, end_us: 10e6, scores: [.9, .3, .29, 0] },
        { start_us: 12e6, end_us: 22e6, scores: [.9, 0, 0, 0] },
        { start_us: 22e6, end_us: 23.5e6, scores: [.9, 0, 0, .9] },
      ].map(window => ({ ...window, rms: .2, peak: .4, status: "classified" as const })) };
    const onSeek = vi.fn();
    render(<ShotAudioEvidence audio={{ status: "ready", evidence: music }} error="" busy={false} onSeek={onSeek} />);
    expect(screen.getByText("Possible music type: Electronic music.")).toBeTruthy();
    expect(screen.queryByText(/score 0.900/)).toBeNull();
    fireEvent.click(screen.getByText("Audio evidence · 3 windows"));
    await waitFor(() => expect(screen.getByText("Possible type: Electronic music.")).toBeTruthy());
    expect(screen.getByText("Music suggested. Type unclear.")).toBeTruthy();
    expect(screen.getByText("Short window. Music type unclear.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "00:12.000 to 00:22.000" }));
    expect(onSeek).toHaveBeenCalledWith(12);
    expect(screen.getByText(/not song boundaries/)).toBeTruthy();
    expect(screen.queryByText(/100%|confidence|No music detected/i)).toBeNull();
  });
  it("renders compact AudioSet evidence without mutating scores or claiming a genre verdict", async () => {
    const music = { ...evidence, labels: ["Electronic music", "Speech", "Music"],
      windows: [{ start_us: 0, end_us: 2e6, rms: .2, peak: .5, status: "classified" as const, scores: [.3, .5, .8] }] };
    render(<ShotAudioEvidence audio={{ status: "ready", evidence: music }} error="" busy={false} />);
    expect(screen.getByText(/AudioSet suggestions need review/)).toBeTruthy();
    fireEvent.click(screen.getByText("Audio evidence · 1 window"));
    await waitFor(() => expect(screen.getByText(/Music \(score 0.800\).*Speech.*Electronic music/)).toBeTruthy());
    expect(screen.getByText(/Short windows have limited context/)).toBeTruthy();
    expect(music.windows[0].scores).toEqual([.3, .5, .8]);
  });
  it("keeps raw suggestions collapsed, labels uncertainty and seeks the actual relative window without changing its range", async () => {
    const onSeek = vi.fn();
    render(<ShotAudioEvidence audio={{ status: "ready", evidence }} error="" busy={false} onSeek={onSeek} />);
    expect(screen.getByText(/Music type is not yet verified/)).toBeTruthy();
    expect(screen.queryByText(/music \(score/)).toBeNull();
    fireEvent.click(screen.getByText("Audio evidence · 3 windows"));
    await waitFor(() => expect(screen.getByText(/music \(score 0.800\).*musical instrument.*speech/)).toBeTruthy());
    expect(screen.getByText(/not confirmed sounds or music genres/)).toBeTruthy();
    expect(screen.getByText(/can span several shots/)).toBeTruthy();
    expect(screen.getByText("Digital silence")).toBeTruthy();
    expect(screen.getByText("Short tail. Not classified.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "00:08.000 to 00:09.000" }));
    expect(onSeek).toHaveBeenCalledWith(8);
    // Ranking presentation must not reorder the immutable machine scores.
    expect(evidence.windows[0].classifications[0].identifier).toBe("speech");
  });
  it("distinguishes no audio track from a decoded track outside the video range", () => {
    const { rerender } = render(<ShotAudioEvidence audio={{ status: "ready", evidence: { ...evidence, status: "no-audio", windows: [] } }} error="" busy={false} />);
    expect(screen.getByText("This video has no audio track.")).toBeTruthy();
    expect(screen.queryByText(/Digital silence/)).toBeNull();
    rerender(<ShotAudioEvidence audio={{ status: "ready", evidence: { ...evidence, windows: [] } }} error="" busy={false} />);
    expect(screen.getByText("No decoded audio overlaps this video range.")).toBeTruthy();
  });
  it.each(["unavailable", "stopped"] as const)("keeps %s feedback quiet and technical details optional", status => {
    render(<ShotAudioEvidence audio={{ status, error: "" }} error="Native decoder changed source timing" busy={false} />);
    expect(screen.getByRole("status").textContent).toContain("Shot descriptions are retained");
    expect(screen.queryByRole("alert")).toBeNull();
    const details = screen.getByText("Audio details").closest("details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("Native decoder changed source timing");
  });
  it("never offers a seek without the owner's transport callback", async () => {
    render(<ShotAudioEvidence audio={{ status: "ready", evidence }} error="" busy={false} />);
    fireEvent.click(screen.getByText("Audio evidence · 3 windows"));
    await waitFor(() => expect(screen.getAllByRole("button")).toHaveLength(3));
    expect(screen.getAllByRole("button").every(button => button.hasAttribute("disabled"))).toBe(true);
  });
});
