// @vitest-environment jsdom
//
// The transport, tested for the first time.
//
// Its pure pieces already had coverage — nextShuttleRate in lib/shuttle,
// clampSeekFrames and maxSeekSeconds in lib/playhead-clock — but the wiring
// between them lived in the middle of a six-thousand-line component and could
// only be exercised by hand. Most of what is asserted here is that wiring:
// which handlers cancel a running shuttle, which arm the co-review latch,
// which read the playhead at action time, and how a mark that would invert
// the selection is resolved.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTransport, type TransportDeps } from "./use-transport";
import type { PlayerHandle } from "../components/player-handle";
import {
  getLastUserSeekAt,
  getPlayheadFrames,
  markUserSeek,
  setPlayheadFrames,
} from "../lib/playhead-store";

const FPS = 30;
const DURATION = 3000; // 100s

function fakePlayer(over: Partial<PlayerHandle> = {}) {
  return {
    play: vi.fn(), pause: vi.fn(), seekTo: vi.fn(),
    getCurrentTime: vi.fn(() => 0), getDuration: vi.fn(() => DURATION / FPS),
    isReady: vi.fn(() => true), isPlaying: vi.fn(() => false),
    setVolume: vi.fn(), getVolume: vi.fn(() => 1),
    setMuted: vi.fn(), isMuted: vi.fn(() => false),
    setShuttle: vi.fn(),
    ...over,
  } as unknown as PlayerHandle & {
    [K in "play" | "pause" | "seekTo" | "setShuttle"]: ReturnType<typeof vi.fn>;
  };
}

function setup(over: Partial<TransportDeps> = {}, player = fakePlayer()) {
  const marks = { in: null as number | null, out: null as number | null };
  const state = {
    setInFrames: vi.fn((f: number | null) => { marks.in = f; }),
    setOutFrames: vi.fn((f: number | null) => { marks.out = f; }),
    setIsPlaying: vi.fn(),
    pushMarksUndo: vi.fn(),
  };
  const deps: TransportDeps = {
    playerRef: { current: player },
    status: "loaded",
    isPlaying: false,
    setIsPlaying: state.setIsPlaying,
    fps: FPS,
    durationFrames: DURATION,
    inFrames: null,
    outFrames: null,
    setInFrames: state.setInFrames,
    setOutFrames: state.setOutFrames,
    pushMarksUndo: state.pushMarksUndo,
    sourceKind: "file",
    localFilePath: "/tmp/a.mov",
    webCachePath: null,
    webStreamUrl: null,
    ...over,
  };
  const view = renderHook((d: TransportDeps) => useTransport(d), { initialProps: deps });
  return { ...view, player, state, marks, deps };
}

beforeEach(() => setPlayheadFrames(0));
afterEach(() => vi.clearAllMocks());

describe("seeking", () => {
  it("clamps into range and moves the store and the player together", () => {
    const { result, player } = setup();
    act(() => result.current.onSeek(1500));
    expect(getPlayheadFrames()).toBe(1500);
    expect(player.seekTo).toHaveBeenCalledWith(50);
  });

  it("clamps a seek past the end to the LAST frame, not past it", () => {
    // durationFrames is a count, so the last addressable frame is one less.
    const { result } = setup();
    act(() => result.current.onSeek(99999));
    expect(getPlayheadFrames()).toBe(DURATION - 1);
  });

  it("never clamps to zero while the duration is unknown", () => {
    // The original bug: an inline `min(durationFrames - 1, f)` sent every
    // click to frame 0 whenever metadata had not arrived yet.
    const { result } = setup({ durationFrames: 0 });
    act(() => result.current.onSeek(900));
    expect(getPlayheadFrames()).toBe(900);
  });

  // The latch pair, on a FAKE clock.
  //
  // Both of these were tautologies on the real one, and a reviewer proved it
  // by mutation: deleting `markUserSeek(clamped)` from onSeek left 36/36 and
  // the whole 626-test suite green. `markUserSeek` only ever writes
  // Date.now(), which never goes backwards, so `toBeGreaterThanOrEqual(before)`
  // held whether or not the call happened. Its partner's `toBe(before)` was
  // defeated from the other side: the two statements ran inside the same
  // millisecond, so an offending markUserSeek would have written the SAME
  // value and passed too.
  //
  // Freezing Date and stepping it by hand makes both directions falsifiable:
  // the arming case must land on the NEW stamp, the chase case must stay on
  // the old one even though the clock moved between them.
  describe("the co-review seek latch", () => {
    const T0 = 1_700_000_000_000;
    beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0); });
    afterEach(() => vi.useRealTimers());

    it("a user seek arms it", () => {
      markUserSeek(0);
      expect(getLastUserSeekAt()).toBe(T0);
      const { result } = setup();
      vi.setSystemTime(T0 + 5_000);
      act(() => result.current.onSeek(600));
      expect(getLastUserSeekAt()).toBe(T0 + 5_000);
    });

    it.each([
      ["a frame step", (t: ReturnType<typeof setup>) => t.result.current.onStep(1)],
      ["a second jump", (t: ReturnType<typeof setup>) => t.result.current.seekBySeconds(5)],
      ["jumping to the in mark", (t: ReturnType<typeof setup>) => t.result.current.onGotoIn()],
      ["jumping to the out mark", (t: ReturnType<typeof setup>) => t.result.current.onGotoOut()],
    ])("%s arms it too", (_name, fire) => {
      markUserSeek(0);
      const t = setup({ inFrames: 300, outFrames: 900 });
      setPlayheadFrames(600);
      vi.setSystemTime(T0 + 5_000);
      act(() => fire(t));
      expect(getLastUserSeekAt()).toBe(T0 + 5_000);
    });

    it("a chase seek does NOT arm it", () => {
      // A chase correction follows the host. If it armed the latch it would be
      // yielding to itself, and the guest would stop following.
      const { result, player } = setup();
      markUserSeek(0);
      vi.setSystemTime(T0 + 5_000); // the clock moves; the latch must not
      act(() => result.current.onChaseSeek(600));
      expect(getPlayheadFrames()).toBe(600);
      expect(player.seekTo).toHaveBeenCalledWith(20);
      expect(getLastUserSeekAt()).toBe(T0);
    });
  });
});

// Every handler that moves the playhead has to kill a running shuttle first,
// or the shuttle immediately drags the playhead back off wherever it was just
// put. The file header claimed this was the main thing being tested and it was
// not tested at all: every case above starts from shuttleRate 0, where
// exitShuttle() is a no-op, so all six calls could have been deleted with the
// suite still green.
describe("every playhead move cancels a running shuttle", () => {
  const playing = () => fakePlayer({ isPlaying: () => true });

  const MOVES: [string, (t: ReturnType<typeof setup>) => void][] = [
    ["onSeek",        (t) => t.result.current.onSeek(1200)],
    ["onChaseSeek",   (t) => t.result.current.onChaseSeek(1200)],
    ["onStep",        (t) => t.result.current.onStep(1)],
    ["seekBySeconds", (t) => t.result.current.seekBySeconds(5)],
    ["onGotoIn",      (t) => t.result.current.onGotoIn()],
    ["onGotoOut",     (t) => t.result.current.onGotoOut()],
  ];

  it.each(MOVES)("%s", (_name, fire) => {
    const player = playing();
    const t = setup({ inFrames: 300, outFrames: 900 }, player);
    setPlayheadFrames(600);
    act(() => t.result.current.shuttleStep(1));
    expect(t.result.current.shuttleRate).toBe(2); // a shuttle really is running
    player.setShuttle.mockClear();

    act(() => fire(t));

    expect(t.result.current.shuttleRate).toBe(0);
    expect(player.setShuttle).toHaveBeenCalledWith(0);
  });
});

describe("frame steps", () => {
  it("steps forward and back from wherever the playhead IS", () => {
    // Action-time read. A handler built on the first render must not step
    // from the position the playhead held at that moment.
    const { result } = setup();
    setPlayheadFrames(900);
    act(() => result.current.onStep(1));
    expect(getPlayheadFrames()).toBe(901);
    act(() => result.current.onStep(-1));
    expect(getPlayheadFrames()).toBe(900);
  });

  it("clamps at both ends", () => {
    const { result } = setup();
    setPlayheadFrames(0);
    act(() => result.current.onStep(-1));
    expect(getPlayheadFrames()).toBe(0);
    setPlayheadFrames(DURATION - 1);
    act(() => result.current.onStep(1));
    expect(getPlayheadFrames()).toBe(DURATION - 1);
  });

  it("pauses, because a step during playback would be immediately overwritten", () => {
    const { result, player } = setup();
    act(() => result.current.onStep(1));
    expect(player.pause).toHaveBeenCalled();
  });
});

describe("second jumps", () => {
  it("jumps from the player's own clock when it has one", () => {
    const player = fakePlayer({ getCurrentTime: () => 10 });
    const { result } = setup({}, player);
    act(() => result.current.seekBySeconds(5));
    expect(player.seekTo).toHaveBeenCalledWith(15);
  });

  it("falls back to the store when the player is not ready", () => {
    const player = fakePlayer({ isReady: () => false });
    const { result } = setup({}, player);
    setPlayheadFrames(300); // 10s
    act(() => result.current.seekBySeconds(5));
    expect(getPlayheadFrames()).toBe(450);
  });

  it("cannot be dragged backward past zero", () => {
    const player = fakePlayer({ getCurrentTime: () => 2 });
    const { result } = setup({}, player);
    act(() => result.current.seekBySeconds(-30));
    expect(player.seekTo).toHaveBeenCalledWith(0);
  });
});

describe("in and out marks", () => {
  it("marks at the playhead", () => {
    const { result, state } = setup();
    setPlayheadFrames(750);
    act(() => result.current.onMarkIn());
    expect(state.setInFrames).toHaveBeenCalledWith(750);
  });

  it("bumps OUT back a second when IN lands on or past it", () => {
    // Rather than refusing the mark or letting the selection invert.
    const { result, state } = setup({ outFrames: 900 });
    setPlayheadFrames(1200);
    act(() => result.current.onMarkIn());
    expect(state.setInFrames).toHaveBeenCalledWith(900 - FPS);
  });

  it("pushes OUT a second forward when it lands on or before IN", () => {
    const { result, state } = setup({ inFrames: 900 });
    setPlayheadFrames(600);
    act(() => result.current.onMarkOut());
    expect(state.setOutFrames).toHaveBeenCalledWith(900 + FPS);
  });

  it("records an undo entry only when the mark actually moves", () => {
    const { result, state } = setup({ inFrames: 750 });
    setPlayheadFrames(750);
    act(() => result.current.onMarkIn());
    expect(state.pushMarksUndo).not.toHaveBeenCalled();

    setPlayheadFrames(760);
    act(() => result.current.onMarkIn());
    expect(state.pushMarksUndo).toHaveBeenCalledOnce();
  });

  it("clear means clear, and is undoable", () => {
    const { result, state } = setup({ inFrames: 100, outFrames: 200 });
    act(() => result.current.onClearMarks());
    expect(state.setInFrames).toHaveBeenCalledWith(null);
    expect(state.setOutFrames).toHaveBeenCalledWith(null);
    expect(state.pushMarksUndo).toHaveBeenCalledWith("clear in/out", 100, 200, null, null);
  });

  it("clearing nothing pushes no undo entry", () => {
    const { result, state } = setup();
    act(() => result.current.onClearMarks());
    expect(state.pushMarksUndo).not.toHaveBeenCalled();
  });

  it("jumps to a mark, and does nothing when it is unset", () => {
    const { result, player } = setup({ inFrames: 600, outFrames: 1200 });
    act(() => result.current.onGotoIn());
    expect(getPlayheadFrames()).toBe(600);
    act(() => result.current.onGotoOut());
    expect(getPlayheadFrames()).toBe(1200);

    const bare = setup();
    act(() => bare.result.current.onGotoIn());
    act(() => bare.result.current.onGotoOut());
    expect(bare.player.seekTo).not.toHaveBeenCalled();
    expect(player.seekTo).toHaveBeenCalledTimes(2);
  });
});

describe("shuttle", () => {
  /** A player that reports itself as playing — the state the ladder climbs from. */
  const playing = () => fakePlayer({ isPlaying: () => true });

  it("the first press from a STOP starts normal playback, not a 1x shuttle", () => {
    // nextShuttleRate(0, dir) returns ±1, and +1 means real playback: native
    // clock, audio on. A 1x shuttle would be silent, which is not what
    // pressing L on a paused clip should do.
    const player = fakePlayer({ isPlaying: () => false });
    const { result } = setup({}, player);
    act(() => result.current.shuttleStep(1));
    expect(result.current.shuttleRate).toBe(0);
    expect(player.play).toHaveBeenCalled();
  });

  it("the first press BACKWARD from a stop does shuttle, at 1x reverse", () => {
    // No such thing as "normal playback" in reverse, so -1 is a real shuttle.
    const player = fakePlayer({ isPlaying: () => false });
    const { result } = setup({}, player);
    setPlayheadFrames(600);
    act(() => result.current.shuttleStep(-1));
    expect(result.current.shuttleRate).toBe(-1);
    expect(player.setShuttle).toHaveBeenCalledWith(-1);
  });

  it("refuses to shuttle backward from frame zero", () => {
    // The bounds watch fires on the spot rather than after a tick, because
    // the edge may already be behind us the moment the shuttle starts. Without
    // that, the badge would show a reverse rate that nothing is going to move.
    const { result } = setup({}, fakePlayer({ isPlaying: () => false }));
    setPlayheadFrames(0);
    act(() => result.current.shuttleStep(-1));
    expect(result.current.shuttleRate).toBe(0);
  });

  it("climbs the ladder on repeated presses in one direction", () => {
    const { result } = setup({}, playing());
    act(() => result.current.shuttleStep(1));
    expect(result.current.shuttleRate).toBe(2);
    act(() => result.current.shuttleStep(1));
    expect(result.current.shuttleRate).toBe(4);
    act(() => result.current.shuttleStep(1));
    expect(result.current.shuttleRate).toBe(8);
  });

  it("stops at 8x for local playback and 4x for the web stream", () => {
    // Beyond 4x the MSE reverse scan runs out of buffered window and forward
    // playback outruns the proxy's fMP4 remux.
    const local = setup({}, playing());
    for (let i = 0; i < 6; i += 1) act(() => local.result.current.shuttleStep(1));
    expect(local.result.current.shuttleRate).toBe(8);

    const web = setup({
      sourceKind: "youtube", localFilePath: null,
      webStreamUrl: "https://example.com/v.m3u8",
    }, playing());
    for (let i = 0; i < 6; i += 1) act(() => web.result.current.shuttleStep(1));
    expect(web.result.current.shuttleRate).toBe(4);
  });

  it("treats a downloaded web source as local — it is a file on disk", () => {
    const { result } = setup({
      sourceKind: "youtube", localFilePath: null,
      webCachePath: "/var/cache/x.mp4", webStreamUrl: "https://example.com/v.m3u8",
    }, playing());
    for (let i = 0; i < 6; i += 1) act(() => result.current.shuttleStep(1));
    expect(result.current.shuttleRate).toBe(8);
  });

  it("steps back down when pressed the other way", () => {
    const { result } = setup({}, playing());
    act(() => result.current.shuttleStep(1));
    act(() => result.current.shuttleStep(1));
    expect(result.current.shuttleRate).toBe(4);
    act(() => result.current.shuttleStep(-1));
    expect(result.current.shuttleRate).toBe(2);
  });

  it("landing on 1x resumes REAL playback rather than a 1x shuttle", () => {
    // The distinction matters: a 1x shuttle has no audio.
    const player = playing();
    const { result } = setup({}, player);
    act(() => result.current.shuttleStep(1)); // 2x
    player.play.mockClear();
    act(() => result.current.shuttleStep(-1)); // back to 1 → real play
    expect(result.current.shuttleRate).toBe(0);
    expect(player.play).toHaveBeenCalled();
  });

  it("holding the key sustains the rate instead of climbing", () => {
    // Premiere and Resolve both do this. Auto-repeat would otherwise rocket
    // to the cap after a fraction of a second.
    const { result } = setup({}, playing());
    act(() => result.current.shuttleStep(1));
    expect(result.current.shuttleRate).toBe(2);
    act(() => result.current.shuttleStep(1, true));
    act(() => result.current.shuttleStep(1, true));
    expect(result.current.shuttleRate).toBe(2);
  });

  it("K held turns J and L into single-frame nudges", () => {
    const { result } = setup();
    setPlayheadFrames(900);
    result.current.kHeldRef.current = true;
    act(() => result.current.shuttleStep(1));
    expect(getPlayheadFrames()).toBe(901);
    expect(result.current.shuttleRate).toBe(0);
  });

  it("routes the rate to the player", () => {
    const player = playing();
    const { result } = setup({}, player);
    setPlayheadFrames(600);
    act(() => result.current.shuttleStep(-1));
    // From forward 1x, one opposite press lands on 1x reverse - the ladder
    // steps back DOWN toward zero and flips, it does not jump to -2.
    expect(player.setShuttle).toHaveBeenCalledWith(-1);
  });

  it("play/pause while shuttling just stops the shuttle", () => {
    const player = playing();
    const { result } = setup({}, player);
    act(() => result.current.shuttleStep(1));
    player.play.mockClear();
    act(() => result.current.onPlayToggle());
    expect(result.current.shuttleRate).toBe(0);
    expect(player.play).not.toHaveBeenCalled();
  });

  it("clears itself when the media runs off the end", () => {
    // The players self-terminate at the bounds with no callback, so the badge
    // would otherwise stay on screen and the next J/L would start from a
    // stale rate.
    const { result } = setup({}, playing());
    act(() => result.current.shuttleStep(1));
    expect(result.current.shuttleRate).toBe(2);
    act(() => setPlayheadFrames(DURATION - 1));
    expect(result.current.shuttleRate).toBe(0);
  });

  it("clears itself when a reverse shuttle reaches zero", () => {
    const { result } = setup({}, playing());
    setPlayheadFrames(600);
    act(() => result.current.shuttleStep(-1));  // forward 1x → reverse 1x
    act(() => result.current.shuttleStep(-1));  // → reverse 2x
    expect(result.current.shuttleRate).toBe(-2);
    act(() => setPlayheadFrames(0));
    expect(result.current.shuttleRate).toBe(0);
  });
});

describe("play toggle", () => {
  it("plays a ready, paused player", () => {
    const player = fakePlayer({ isPlaying: () => false });
    const { result } = setup({}, player);
    act(() => result.current.onPlayToggle());
    expect(player.play).toHaveBeenCalled();
  });

  it("pauses a playing one", () => {
    const player = fakePlayer();
    const { result } = setup({ isPlaying: true }, player);
    act(() => result.current.onPlayToggle());
    expect(player.pause).toHaveBeenCalled();
  });

  it("does nothing at all before a source is loaded", () => {
    const player = fakePlayer();
    const { result, state } = setup({ status: "empty" }, player);
    act(() => result.current.onPlayToggle());
    expect(player.play).not.toHaveBeenCalled();
    expect(state.setIsPlaying).not.toHaveBeenCalled();
  });

  it("falls back to intent when the player is not ready yet", () => {
    const player = fakePlayer({ isReady: () => false });
    const { result, state } = setup({}, player);
    act(() => result.current.onPlayToggle());
    expect(state.setIsPlaying).toHaveBeenCalled();
  });
});
