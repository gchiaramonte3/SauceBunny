// @vitest-environment jsdom
//
// The first test in this repo that actually renders a component.
//
// Everything else is pure logic (SRT parsing, timecode math, proxy request
// parsing) or the Playwright shell smoke, which boots the whole app with the
// IPC layer mocked and asserts that the chrome appears without a pageerror.
// Neither can answer "does this control behave the way its props say it
// does", and the gap showed: the timeline playhead is the app's primary
// scrub control and had no coverage at any level. Its keyboard map is an NLE
// convention that a careless edit would silently break, and its ARIA is a
// contract with a screen reader that nothing was checking at all.
//
// jsdom is opt-in per file via the pragma above, so the ~550 node-environment
// tests keep running in about a second.

import { describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { Timeline } from "./Timeline";
import { setPlayheadFrames } from "../lib/playhead-store";
import { rangeToPost } from "../lib/review-range";

// Decoding is not what this file is about. Both of these reach for WebCodecs
// and a real media file; stub them so the component mounts in jsdom.
vi.mock("../lib/mediabunny-helpers", () => ({ extractFilmstrip: vi.fn(async () => []) }));
vi.mock("../lib/waveform", () => ({
  extractWaveformPeaks: vi.fn(async () => null),
  lruSet: vi.fn(),
}));

afterEach(() => {
  cleanup();
  setPlayheadFrames(0);
});

const FPS = 30;
const DURATION = 3000; // frames — 100s at 30fps

function mount(over: Partial<Parameters<typeof Timeline>[0]> = {}) {
  const onSeek = vi.fn();
  render(
    <Timeline
      status="loaded"
      durationFrames={DURATION}
      inFrames={null}
      outFrames={null}
      fps={FPS}
      onSeek={onSeek}
      {...over}
    />,
  );
  return { onSeek, playhead: screen.getByRole("slider", { name: "Playhead" }) };
}

describe("Timeline review markers — live vs carried", () => {
  /** One point note and one RANGE note, each in both flavours. */
  const MARKERS = [
    { id: "live-dot", time: 10, timeEnd: null, resolved: false, color: "#75B0FF", initials: "GC" },
    { id: "live-rng", time: 20, timeEnd: 25, resolved: false, color: "#75B0FF", initials: "GC" },
    { id: "car-dot", time: 30, timeEnd: null, resolved: false, color: "#EB9A04", initials: "NP", carried: true },
    { id: "car-rng", time: 40, timeEnd: 45, resolved: false, color: "#EB9A04", initials: "NP", carried: true },
  ];
  const dots = () => [...document.querySelectorAll(".cp-track-comment")] as HTMLElement[];
  const bands = () => [...document.querySelectorAll(".cp-track-comment-range")] as HTMLElement[];

  it("marks a carried DOT as carried and leaves a live one alone", () => {
    mount({ commentMarkers: MARKERS });
    expect(dots()).toHaveLength(4);
    expect(dots()[0].className).not.toContain("carried");
    expect(dots()[2].className).toContain("carried");
  });

  it("marks a carried RANGE BAND as carried too", () => {
    // The bug this catches: only the dot took the flag, so a carried note that
    // had a range drew a hollow dot sitting on a full-strength solid band —
    // the same band a note on THIS cut draws. The two states were meant to be
    // told apart at a glance and the wider of the two shapes said "live".
    mount({ commentMarkers: MARKERS });
    const b = bands();
    expect(b).toHaveLength(2);
    expect(b[0].className).not.toContain("carried"); // live-rng
    expect(b[1].className).toContain("carried");     // car-rng
  });

  it("says in the tooltip that a carried note came from an earlier cut", () => {
    mount({ commentMarkers: MARKERS });
    const b = bands();
    expect(b[1].getAttribute("title")).toMatch(/earlier cut/i);
    expect(dots()[2].getAttribute("title")).toMatch(/earlier cut/i);
    expect(dots()[0].getAttribute("title")).not.toMatch(/earlier cut/i);
  });
});

describe("Timeline range draft — the preview must not promise a range the post won't make", () => {
  const band = () => document.querySelector(".cp-track-range-draft");
  const live = { anchor: 10, color: "#75B0FF", live: true } as const;

  it("draws a band once the playhead is a real span from the anchor", () => {
    setPlayheadFrames(10 * FPS + FPS); // 1s past the mark
    mount({ reviewRangeDraft: live });
    expect(band()).toBeTruthy();
  });

  it("draws NOTHING while the playhead is within the minimum span", () => {
    // The mismatch this closes. rangeToPost degrades a sub-threshold span to a
    // POINT comment, but the band has a minimum rendered width, so the user
    // was shown a visible range and then got a dot.
    setPlayheadFrames(10 * FPS + 1); // one frame past the mark, well under 0.05s
    mount({ reviewRangeDraft: live });
    expect(band()).toBeNull();
  });

  it("draws nothing when the playhead sits exactly on the anchor", () => {
    setPlayheadFrames(10 * FPS);
    mount({ reviewRangeDraft: live });
    expect(band()).toBeNull();
  });

  it("still draws when scrubbing BEHIND the anchor, clamped, once it is a real span", () => {
    setPlayheadFrames(10 * FPS - FPS);
    mount({ reviewRangeDraft: live });
    expect(band()).toBeTruthy();
  });

  it("always draws a LOCKED draft — both marks are set, the playhead is irrelevant", () => {
    setPlayheadFrames(0);
    mount({ reviewRangeDraft: { start: 10, end: 30, color: "#75B0FF", live: false } });
    expect(band()).toBeTruthy();
  });

  it("agrees with rangeToPost at every playhead around the anchor", () => {
    // The contract, stated directly: a band is on screen if and only if the
    // comment that posts right now would carry a timeEnd.
    for (const offsetFrames of [-45, -2, -1, 0, 1, 2, 45]) {
      cleanup();
      const frames = 10 * FPS + offsetFrames;
      setPlayheadFrames(frames);
      mount({ reviewRangeDraft: live });
      const posts = rangeToPost({ in: 10, out: null }, frames / FPS).timeEnd != null
        || rangeToPost({ in: null, out: 10 }, frames / FPS).timeEnd != null;
      expect(!!band(), `offset ${offsetFrames}f`).toBe(posts);
    }
  });
});

describe("Timeline playhead — keyboard", () => {
  // One case per binding. An editor's hands know these; a regression in any
  // one of them is the kind that gets reported as "the arrow keys feel wrong"
  // three weeks later.
  const cases: [string, KeyboardEventInit, number, number][] = [
    ["ArrowRight steps one frame",        { key: "ArrowRight" },                 900, 901],
    ["ArrowLeft steps back one frame",    { key: "ArrowLeft" },                  900, 899],
    ["shift+ArrowRight jumps one second", { key: "ArrowRight", shiftKey: true }, 900, 930],
    ["shift+ArrowLeft jumps back one second", { key: "ArrowLeft", shiftKey: true }, 900, 870],
    ["PageUp jumps ten seconds",          { key: "PageUp" },                     900, 1200],
    ["PageDown jumps back ten seconds",   { key: "PageDown" },                   900, 600],
    ["Home goes to the start",            { key: "Home" },                       900, 0],
    ["End goes to the last frame",        { key: "End" },                        900, DURATION],
  ];

  it.each(cases)("%s", (_name, init, from, want) => {
    setPlayheadFrames(from);
    const { onSeek, playhead } = mount();
    fireEvent.keyDown(playhead, init);
    expect(onSeek).toHaveBeenCalledWith(want);
  });

  it("clamps at both ends instead of seeking out of bounds", () => {
    setPlayheadFrames(0);
    const a = mount();
    fireEvent.keyDown(a.playhead, { key: "ArrowLeft" });
    expect(a.onSeek).toHaveBeenCalledWith(0);
    cleanup();

    setPlayheadFrames(DURATION);
    const b = mount();
    fireEvent.keyDown(b.playhead, { key: "ArrowRight" });
    expect(b.onSeek).toHaveBeenCalledWith(DURATION);
  });

  it("swallows the arrow keys so one press is not two seeks", () => {
    // App binds bare arrows globally as well. If the cursor lets the event
    // bubble, a focused playhead steps twice per keypress - the original bug.
    setPlayheadFrames(900);
    const bubbled = vi.fn();
    document.addEventListener("keydown", bubbled);
    const { playhead } = mount();
    const notPrevented = fireEvent.keyDown(playhead, { key: "ArrowRight", bubbles: true });
    document.removeEventListener("keydown", bubbled);
    expect(bubbled).not.toHaveBeenCalled();   // stopPropagation
    expect(notPrevented).toBe(false);         // preventDefault
  });

  it("passes unrelated keys through untouched", () => {
    setPlayheadFrames(900);
    const { onSeek, playhead } = mount();
    const notPrevented = fireEvent.keyDown(playhead, { key: "k", bubbles: true });
    expect(onSeek).not.toHaveBeenCalled();
    // Space and K are play/pause at the app level; claiming them here would
    // break playback whenever the playhead happened to hold focus.
    expect(notPrevented).toBe(true);
  });

  it("ignores keys when there is no duration to seek within", () => {
    const { onSeek, playhead } = mount({ durationFrames: 0 });
    fireEvent.keyDown(playhead, { key: "End" });
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("scales the step to the source rate, not to 30", () => {
    setPlayheadFrames(0);
    const { onSeek, playhead } = mount({ fps: 23.976, durationFrames: 2400 });
    fireEvent.keyDown(playhead, { key: "ArrowRight", shiftKey: true });
    // round(23.976) = 24: a "second" is 24 frames on this source.
    expect(onSeek).toHaveBeenCalledWith(24);
  });
});

describe("Timeline playhead — the screen-reader contract", () => {
  it("announces a timecode, not a frame count", () => {
    setPlayheadFrames(1875); // 62.5s at 30fps
    // No `expect(playhead.role).toBe("slider")` — mount() fetched the element
    // BY that role, so re-asserting it cannot fail. What is worth pinning is
    // everything a screen reader reads off it once found.
    const { playhead } = mount();
    expect(playhead.getAttribute("aria-valuetext")).toBe("00:01:02");
    expect(playhead.getAttribute("aria-valuenow")).toBe("1875");
    expect(playhead.getAttribute("aria-valuemin")).toBe("0");
    expect(playhead.getAttribute("aria-valuemax")).toBe(String(DURATION));
  });

  it("is reachable by keyboard when the timeline is live", () => {
    const { playhead } = mount();
    expect(playhead.getAttribute("tabindex")).toBe("0");
  });

  it.each(["empty", "fetching", "error"] as const)(
    "is absent entirely while the track is dimmed (%s)",
    (status) => {
      // Not "present but disabled". The parent drops the whole cursor, which
      // is the better behaviour: no dead stop in the tab order, nothing to
      // focus that refuses every key.
      //
      // This test is the reason PlayheadCursor no longer takes a `disabled`
      // prop. It had one, gating the keymap and setting tabIndex={-1} and
      // aria-disabled, and every line of it was unreachable because the only
      // call site sits inside `{!dim && …}`. The first component test written
      // against this component found it.
      render(
        <Timeline
          status={status}
          durationFrames={DURATION}
          inFrames={null}
          outFrames={null}
          fps={FPS}
          onSeek={vi.fn()}
        />,
      );
      expect(screen.queryByRole("slider")).toBeNull();
    },
  );
});

describe("Timeline playhead — position", () => {
  it("follows the store without a prop", () => {
    setPlayheadFrames(750); // 25% of 3000
    const { playhead } = mount();
    expect(playhead.style.left).toBe("25%");
  });

  it("moves on a store tick with no re-render from the parent", () => {
    // The whole reason the playhead lives outside React. If this breaks, the
    // cursor freezes during playback until something else re-renders.
    const { playhead } = mount();
    expect(playhead.style.left).toBe("0%");
    act(() => setPlayheadFrames(1500));
    expect(playhead.style.left).toBe("50%");
  });

  it("does not divide by zero on an unloaded source", () => {
    setPlayheadFrames(100);
    const { playhead } = mount({ durationFrames: 0 });
    expect(playhead.style.left).toBe("0%");
  });
});
