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
