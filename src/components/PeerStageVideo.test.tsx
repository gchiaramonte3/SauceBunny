// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PeerStageVideo } from "./PeerStageVideo";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const fixture = () => {
  const track = { readyState: "live", muted: false, enabled: true, stop: vi.fn() };
  return { track, stream: { getVideoTracks: () => [track] } as unknown as MediaStream };
};

it("shows the presenter's own shared stream silently before play without muting outgoing audio", () => {
  const { stream, track } = fixture();
  const beforePlay: boolean[] = [];
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    beforePlay.push(this.muted); return Promise.resolve();
  });
  const view = render(<PeerStageVideo stream={stream} who="You" isSelf />);
  const video = screen.getByLabelText("Your shared screen") as HTMLVideoElement;
  expect(video.srcObject).toBe(stream);
  expect(beforePlay).toEqual([true]);
  expect(video.muted).toBe(true);
  expect(screen.queryByRole("button", { name: /program/i })).toBeNull();
  expect(screen.queryByRole("slider")).toBeNull();
  expect(track.enabled).toBe(true);
  view.unmount();
  expect(video.srcObject).toBeNull();
  expect(track.stop).not.toHaveBeenCalled();
});

it("keeps remote audio controls but immediately silences a replacement self stream", () => {
  const first = fixture(), second = fixture();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const view = render(<PeerStageVideo stream={first.stream} who="Editor" />);
  fireEvent.click(screen.getByRole("button", { name: "Mute program" }));
  fireEvent.click(screen.getByRole("button", { name: "Unmute program" }));
  expect((screen.getByLabelText("Editor's shared screen") as HTMLVideoElement).muted).toBe(false);
  view.rerender(<PeerStageVideo stream={second.stream} who="You" isSelf />);
  expect((screen.getByLabelText("Your shared screen") as HTMLVideoElement).muted).toBe(true);
  expect(screen.queryByRole("button", { name: "Mute program" })).toBeNull();
});
