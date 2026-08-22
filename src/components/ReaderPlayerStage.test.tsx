// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { ReaderPlayerStage, type ReaderSource } from "./ReaderPlayerStage";
import type { PlayerHandle } from "./player-handle";

// The two engines decode real media; the panel under test only needs them to
// mount and report a duration through onReady.
vi.mock("./MediaBunnyPlayer", () => ({
  MediaBunnyPlayer: (p: { onReady?: (d: number) => void }) => {
    p.onReady?.(100);
    return <div data-testid="engine" />;
  },
}));
vi.mock("./LocalMediaPlayer", () => ({
  LocalMediaPlayer: (p: { onReady?: (d: number) => void }) => {
    p.onReady?.(100);
    return <div data-testid="engine" />;
  },
}));

afterEach(cleanup);

const source: ReaderSource = {
  origPath: "/media/a.mov", path: "/media/a.mov", hasVideo: true,
  fps: 24, title: "A", useWebCodecs: true, prepared: false,
};

function mount(extra: Record<string, unknown> = {}) {
  const seekTo = vi.fn();
  const ref = createRef<PlayerHandle>();
  (ref as { current: PlayerHandle | null }).current = {
    play: vi.fn(), pause: vi.fn(), seekTo, isPlaying: () => false,
    getCurrentTime: () => 0, getDuration: () => 100, setVolume: vi.fn(),
  } as unknown as PlayerHandle;
  render(
    <ReaderPlayerStage
      source={source} preparing={false} note={null} playerRef={ref}
      floating={false} active onToggleFloat={() => {}} onCollapse={() => {}}
      onPlayStateChange={() => {}} onError={() => {}} initialVolume={1}
      {...extra}
    />,
  );
  return seekTo;
}

describe("the reader's compact player shows the timeline's data", () => {
  it("draws a pin per marker and says what they are", () => {
    mount({
      markIn: 10, markOut: 60,
      chapters: [{ time: 25, title: "Act two" }],
      comments: [{ time: 40, resolved: false }],
    });
    expect(screen.getByLabelText(/Jump to Act two/)).toBeTruthy();
    expect(screen.getByLabelText(/Jump to In/)).toBeTruthy();
    expect(screen.getByLabelText(/Jump to Out/)).toBeTruthy();
    expect(screen.getByText("in/out · 1 chapter · 1 comment")).toBeTruthy();
  });

  it("jumps to a marker's exact time, not to where the pixel was", () => {
    // The bar's own click handler converts a pixel to a fraction. A pin has an
    // exact time, so it must stop that handler or the jump lands near the
    // marker instead of on it.
    const seekTo = mount({ chapters: [{ time: 25, title: "Act two" }] });
    fireEvent.click(screen.getByLabelText(/Jump to Act two/));
    expect(seekTo).toHaveBeenCalledWith(25);
    expect(seekTo).toHaveBeenCalledTimes(1);
  });

  it("draws nothing extra when the source has no markers", () => {
    mount();
    expect(screen.queryByLabelText(/Jump to/)).toBeNull();
    expect(document.querySelector(".cp-reader-marker-note")).toBeNull();
  });

  it("keeps the position bar usable while markers are shown", () => {
    // The pins sit on top of the seek bar; the bar itself must still be a
    // focusable slider with its own keys.
    mount({ chapters: [{ time: 25, title: "Act two" }] });
    const bar = screen.getByRole("slider", { name: "Playback position" });
    expect(bar.getAttribute("tabindex")).toBe("0");
  });
});
