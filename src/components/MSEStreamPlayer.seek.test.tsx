// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { MSEStreamPlayer } from "./MSEStreamPlayer";
import type { PlayerHandle } from "./player-handle";

/**
 * The seek log, reproduced.
 *
 * A report of "a major regression in seeking and scrubbing for web clips"
 * arrived with a Pipeline log that reads as four seeks landing hundreds of
 * seconds from where they were asked. Reading the code said otherwise, but
 * reading is not proof, and the whole point of the report was that something
 * had changed. So this drives the REAL component's seek handle with the two
 * gestures a user makes and asserts what comes out.
 *
 * The pipeline is never built here (jsdom has no MediaSource), which is not a
 * limitation: every seek in the reported log was OUT OF BUFFER, and with no
 * SourceBuffer that is exactly the branch taken. This is the reported path.
 */

/**
 * The preview decoder, under test control.
 *
 * `h.frameDelay` is how long a frame takes to decode, which is the whole
 * subject of the second half of this file: over a network, on a long source,
 * it is seconds - and the overlay used to be revealed immediately regardless.
 * `h.noVideoTrack` makes the decoder fail to open, which is the case that
 * fails FOREVER and used to do so in silence.
 */
const h = vi.hoisted(() => ({ frameDelay: 0, noVideoTrack: false }));

vi.mock("mediabunny", () => ({
  ALL_FORMATS: [],
  Input: class {
    getPrimaryVideoTrack() {
      return Promise.resolve(h.noVideoTrack ? null : { canDecode: () => Promise.resolve(true) });
    }
    dispose() { return Promise.resolve(); }
  },
  UrlSource: class {},
  CanvasSink: class {
    getCanvas(_t: number) {
      const canvas = { width: 320, height: 180 };
      return new Promise((resolve) => setTimeout(() => resolve({ canvas }), h.frameDelay));
    }
  },
  EncodedPacketSink: class { getKeyPacket() { return Promise.resolve(null); } },
}));

// jsdom implements no media playback, so every `v.pause()` in the seek path
// prints "Not implemented" to the virtual console. Same category as the
// ResizeObserver stub in test-setup: filling in an API jsdom does not have,
// not faking behaviour under test. Nothing here asserts on pause.
if (!HTMLMediaElement.prototype.pause.toString().includes("noop")) {
  HTMLMediaElement.prototype.pause = function noop() { /* jsdom has no playback */ };
  HTMLMediaElement.prototype.play = function noop() { return Promise.resolve(); };
}

type Line = { tag: string; msg: string };

function mountPlayer(diag: Line[], opts: { preview?: boolean } = {}) {
  const ref = createRef<PlayerHandle>();
  render(
    <MSEStreamPlayer
      ref={ref}
      path="http://127.0.0.1:1/t/tok/v1/abc"
      hasVideo
      initialVolume={1}
      knownDuration={5756}
      disableScrubPreview={!opts.preview}
      onDiag={(tag, msg) => diag.push({ tag, msg })}
    />,
  );
  return ref;
}

/** The overlay, and whether it is actually being shown over the video. */
const overlay = () => document.querySelector(".cp-scrub-preview");
const overlayShown = () => !!overlay()?.classList.contains("show");

/** The rebuild debounce (280ms) plus a little air. */
const SETTLE = 400;

let diag: Line[];
beforeEach(() => { diag = []; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); cleanup(); });

const rebuilds = () => diag.filter((l) => l.msg.includes("rebuilding from")).map((l) => l.msg);
const reqs = () => diag.filter((l) => l.msg.startsWith("seek req")).map((l) => l.msg);

describe("a click", () => {
  it("logs one request and rebuilds exactly where it was asked", () => {
    // The FIRST line of the reported log, which was always correct:
    //   seek req 1298.8 → target 1298.8
    //   seek out-of-buffer → rebuilding from 1298.8s
    const ref = mountPlayer(diag);
    ref.current!.seekTo(1298.8);
    vi.advanceTimersByTime(SETTLE);

    expect(reqs()).toHaveLength(1);
    expect(reqs()[0]).toContain("seek req 1298.8 → target 1298.8");
    expect(rebuilds()).toHaveLength(1);
    expect(rebuilds()[0]).toContain("rebuilding from 1298.8s");
    // The line that was missing, and the reason the report could not be read.
    expect(rebuilds()[0]).toContain("click, landed as asked");
  });
});

describe("a drag", () => {
  it("reproduces the reported log shape, and now says which gesture it is", () => {
    // The pair that looked like a twenty-minute miss:
    //   seek req 2666.0 → target 2666.0
    //   seek out-of-buffer → rebuilding from 3855.5s
    //
    // A drag emits one seek per animation frame. `seek req` is logged once
    // per GESTURE (every log line is App state; logging each one re-rendered
    // the app per vsync), and the rebuild is debounced, so it reports where
    // the gesture SETTLED. Both numbers were always right.
    const ref = mountPlayer(diag);
    const path = [2666.0, 2900.4, 3210.9, 3540.2, 3855.5];
    for (const t of path) {
      ref.current!.seekTo(t);
      vi.advanceTimersByTime(16); // one frame, well inside the 280ms debounce
    }
    vi.advanceTimersByTime(SETTLE);

    // ONE request line for the whole drag — this is the reported shape.
    expect(reqs(), "a drag must not log per frame; that was the render bug").toHaveLength(1);
    expect(reqs()[0]).toContain("seek req 2666.0 → target 2666.0");

    // ONE rebuild, at the release point, and it now names the gesture.
    expect(rebuilds()).toHaveLength(1);
    expect(rebuilds()[0]).toContain("rebuilding from 3855.5s");
    expect(rebuilds()[0]).toContain("began 2666.0s");
    expect(rebuilds()[0]).toContain("released 3855.5s");
    expect(rebuilds()[0], "a drag must never read as a click").not.toContain("click");
  });

  it("counts the seeks the gesture actually emitted", () => {
    const ref = mountPlayer(diag);
    for (const t of [100, 200, 300, 400]) {
      ref.current!.seekTo(t);
      vi.advanceTimersByTime(16);
    }
    vi.advanceTimersByTime(SETTLE);
    expect(rebuilds()[0]).toContain("4 seeks");
  });

  it("reports a drag to the very start as a drag, not a jump to zero", () => {
    // The worst-looking line in the report: `req 4928.8` then `rebuilding
    // from 0.0`. Somebody dragged to the beginning.
    const ref = mountPlayer(diag);
    ref.current!.seekTo(4928.8);
    vi.advanceTimersByTime(16);
    ref.current!.seekTo(0);
    vi.advanceTimersByTime(SETTLE);
    expect(rebuilds()[0]).toContain("began 4928.8s");
    expect(rebuilds()[0]).toContain("released 0.0s");
  });
});

describe("what the player actually did with the reported gestures", () => {
  it("rebuilds at the released position every time, never somewhere else", () => {
    // The claim under test: no seek in that log landed anywhere it was not
    // told to. Replaying all four gestures, each rebuild equals its release.
    const gestures: Array<[from: number, to: number]> = [
      [1298.8, 1298.8], [2536.2, 2570.4], [2666.0, 3855.5], [4805.8, 5202.3], [4928.8, 0],
    ];
    for (const [from, to] of gestures) {
      diag = [];
      const ref = mountPlayer(diag);
      ref.current!.seekTo(from);
      vi.advanceTimersByTime(16);
      if (to !== from) { ref.current!.seekTo(to); vi.advanceTimersByTime(16); }
      vi.advanceTimersByTime(SETTLE);
      expect(rebuilds()[0], `gesture ${from}→${to}`).toContain(`rebuilding from ${to.toFixed(1)}s`);
      cleanup();
    }
  });

  it("clamps a seek past the end to the known duration, not backwards", () => {
    // The old failure this path had ("19:40 landing at 15:12") was a SHORT
    // probe duration clamping a valid forward seek. knownDuration wins.
    const ref = mountPlayer(diag);
    ref.current!.seekTo(9999);
    vi.advanceTimersByTime(SETTLE);
    expect(reqs()[0]).toContain("target 5756.0");
    expect(rebuilds()[0]).toContain("rebuilding from 5756.0s");
  });
});

/**
 * The scrub overlay must never be the thing you are looking at when it is
 * empty.
 *
 * `.cp-scrub-preview` carries `background: var(--bg-0)` (near black) and sits
 * at z-index 2 over the <video>. The player used to reveal it the instant a
 * seek began — before the decoder existed, let alone a frame. So the moment
 * you touched the scrubber the picture was replaced by an opaque black
 * rectangle, and it stayed black until a frame decoded: seconds on a long
 * source over the network, and permanently when the preview decoder cannot
 * open at all, which it does silently.
 *
 * Reported as "the frames are black for long periods of time until finally it
 * comes available to see, which is the worst user experience I've ever seen".
 * It was the overlay showing its own background.
 */
describe("the scrub preview overlay", () => {
  beforeEach(() => { h.frameDelay = 0; h.noVideoTrack = false; });

  it("is NOT shown before it has a frame to show", async () => {
    // The whole bug, in one assertion. A slow decode must leave the video
    // visible, not cover it with black.
    h.frameDelay = 5_000;
    const ref = mountPlayer(diag, { preview: true });
    ref.current!.seekTo(1298.8);
    await vi.advanceTimersByTimeAsync(500);
    expect(overlayShown(), "an empty overlay was painted over the video").toBe(false);
  });

  it("is shown once a frame has actually landed", async () => {
    h.frameDelay = 20;
    const ref = mountPlayer(diag, { preview: true });
    ref.current!.seekTo(1298.8);
    await vi.advanceTimersByTimeAsync(500);
    expect(overlayShown(), "a decoded frame never reached the overlay").toBe(true);
  });

  it("stays hidden forever when the decoder cannot open, and says why", async () => {
    // The permanent case. Silence here is what made it unreportable: a
    // preview that never opens and one that is merely slow look identical.
    h.noVideoTrack = true;
    const ref = mountPlayer(diag, { preview: true });
    ref.current!.seekTo(1298.8);
    await vi.advanceTimersByTimeAsync(2000);
    expect(overlayShown()).toBe(false);
    const said = diag.find((l) => l.msg.includes("scrub preview unavailable"));
    expect(said, "a preview that cannot open must say so, not fail silently").toBeTruthy();
    expect(said!.msg).toContain("no video track");
  });

  it("reports how long the first frame took, so slow and broken are told apart", async () => {
    h.frameDelay = 30;
    const ref = mountPlayer(diag, { preview: true });
    ref.current!.seekTo(1298.8);
    await vi.advanceTimersByTimeAsync(500);
    expect(diag.some((l) => l.msg.startsWith("scrub preview ready"))).toBe(true);
  });

  it("keeps showing the last frame across a later seek, rather than blanking", async () => {
    // Once it holds a real frame, a slightly stale frame beats black while the
    // next one decodes. This is what an NLE does.
    h.frameDelay = 20;
    const ref = mountPlayer(diag, { preview: true });
    ref.current!.seekTo(100);
    await vi.advanceTimersByTimeAsync(500);
    expect(overlayShown()).toBe(true);
    h.frameDelay = 5_000;            // the next frame is a long way off
    ref.current!.seekTo(4000);
    await vi.advanceTimersByTimeAsync(100);
    expect(overlayShown(), "the overlay blanked instead of holding the last frame").toBe(true);
  });
});
