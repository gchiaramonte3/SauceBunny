// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShotAudioEvidence } from "./ShotAudioEvidence";
import { ShotAnalysisInfo } from "./ShotAnalysisInfo";
import type { VideoMusicAnalysis } from "../bindings/VideoMusicAnalysis";
import { AUDIOSET_CLASSIFIER, AUDIOSET_PREPROCESSING } from "../lib/scene-analysis/music-summary";

afterEach(cleanup);
const evidence: VideoMusicAnalysis = {
  analysis_id: "test", source: { path: "/clip.mp4", sha256: "test", origin_us: 3e6, duration_us: 40e6 },
  audio_track_index: 0, classifier: AUDIOSET_CLASSIFIER, preprocessing_version: AUDIOSET_PREPROCESSING, os: "Test OS",
  status: "decoded", labels: ["Speech", "Music", "Explosion", "Throbbing"], windows: [
    { start_us: 0, end_us: 13, peak: .1, rms: .1, status: "insufficient-context", scores: [] },
    ...[[.8, .1, 0, 0], [.6, .7, .1, .32], [.1, .9, 0, 0], [.1, .1, .8, 0]].map((scores, index) => ({
      start_us: index ? index * 10e6 : 13, end_us: (index + 1) * 10e6, peak: .5, rms: .2, status: "classified" as const, scores,
    })),
  ],
};

describe("editor-facing audio content", () => {
  it("shows grayscale icon labels with mixed content and SFX, without raw scores or a zero-length fragment", () => {
    const before = structuredClone(evidence);
    render(<ShotAudioEvidence audio={{ status: "ready", evidence }} busy={false} onSeek={vi.fn()} />);
    const rows = within(screen.getByRole("list", { name: "Audio content" })).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(within(rows[0]).getByText("Speech")).toBeTruthy();
    expect(rows[0].querySelectorAll("svg")).toHaveLength(1);
    expect(within(rows[1]).getByText("Speech + Music")).toBeTruthy();
    expect(rows[1].querySelectorAll("svg")).toHaveLength(2);
    expect(within(rows[2]).getByText("Music")).toBeTruthy();
    expect(within(rows[3]).getByText("SFX")).toBeTruthy();
    expect(within(rows[3]).getByText("Explosion")).toBeTruthy();
    expect(screen.queryByText(/score|0\.600|Throbbing|type unclear|short tail/i)).toBeNull();
    expect(evidence).toEqual(before);
  });
  it.each([24000 / 1001, 24, 30000 / 1001, 60000 / 1001])("seeks the displayed source frame at %s fps, not the PCM timestamp", fps => {
    const onSeek = vi.fn();
    render(<ShotAudioEvidence audio={{ status: "ready", evidence }} busy={false} fps={fps} onSeek={onSeek} />);
    fireEvent.click(screen.getByRole("button", { name: /Audio range 2 start/ }));
    expect(onSeek).toHaveBeenLastCalledWith(Math.floor(10 * fps) / fps);
    fireEvent.click(screen.getByRole("button", { name: /Audio range 2 end/ }));
    expect(onSeek).toHaveBeenLastCalledWith(Math.floor(20 * fps) / fps);
    expect(onSeek.mock.calls.every(([seconds]) => Math.abs(seconds * fps - Math.round(seconds * fps)) < 1e-8)).toBe(true);
  });
  it("collapses only the All-tab summary, not the dedicated Audio tab", async () => {
    const { rerender } = render(<ShotAudioEvidence compact audio={{ status: "ready", evidence }} busy={false} />);
    expect(screen.queryByRole("list")).toBeNull();
    fireEvent.click(screen.getByText("Audio · 4 ranges"));
    await waitFor(() => expect(screen.getByRole("list", { name: "Audio content" })).toBeTruthy());
    rerender(<ShotAudioEvidence audio={{ status: "ready", evidence }} busy={false} />);
    expect(screen.getByRole("list", { name: "Audio content" })).toBeTruthy();
    expect(screen.getAllByRole("button").every(button => button.hasAttribute("disabled"))).toBe(true);
  });
  it("keeps scores and classification limits inside the header Info disclosure", async () => {
    render(<ShotAnalysisInfo source="/clip.mp4" fps={24} status="Complete" failure="" audioError="" audio={{ status: "ready", evidence }} />);
    expect(screen.queryByText(/0\.600/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Analysis info" }));
    const info = screen.getByRole("dialog", { name: "Analysis info" });
    expect(within(info).queryByText(/0\.600/)).toBeNull();
    fireEvent.click(within(info).getByText("Audio details"));
    await waitFor(() => expect(within(info).getByText(/Speech \(0.600\)/)).toBeTruthy());
    expect(within(info).getByText(/not necessarily at every frame/)).toBeTruthy();
    expect(within(info).getByText(/1 sub-frame fragment is/)).toBeTruthy();
    fireEvent.keyDown(info, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("distinguishes missing tracks, missing coverage and invalid frame rates", () => {
    const { rerender } = render(<ShotAudioEvidence audio={{ status: "ready", evidence: { ...evidence, status: "no-audio", windows: [] } }} busy={false} />);
    expect(screen.getByText("No audio track")).toBeTruthy();
    rerender(<ShotAudioEvidence audio={{ status: "ready", evidence: { ...evidence, windows: [] } }} busy={false} />);
    expect(screen.getByText("No audio in this range")).toBeTruthy();
    rerender(<ShotAudioEvidence audio={{ status: "ready", evidence }} busy={false} fps={NaN} />);
    expect(screen.getByText("Frame rate unavailable")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it.each(["unavailable", "stopped"] as const)("keeps %s feedback terse without calling it silence", status => {
    render(<ShotAudioEvidence audio={{ status, error: "decoder failed" }} busy={false} />);
    expect(screen.getByRole("status").textContent).toBe(status === "stopped" ? "Stopped" : "Unavailable");
    expect(screen.queryByText(/silence|decoder|score/i)).toBeNull();
  });
});
