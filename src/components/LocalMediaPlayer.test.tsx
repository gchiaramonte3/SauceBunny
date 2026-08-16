// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { LocalMediaPlayer } from "./LocalMediaPlayer";
import type { PlayerHandle } from "./player-handle";

vi.mock("../lib/asset-url", () => ({ assetUrl: (p: string) => `asset://${p}` }));

/**
 * The decoder warm-up, which no hand test can reach in under twenty minutes.
 *
 * "Rest the app, come back, scrub, and it holds a long time on the frame it
 * was parked on." WebKit tears the decode pipeline down while a paused <video>
 * sits idle, and the rebuild is billed to whichever gesture comes first - the
 * user's scrub. The fix pays it on return instead, with a zero-distance seek
 * (currentTime = currentTime), which rebuilds the pipeline without moving off
 * the parked frame the way .load() would.
 *
 * Every branch here is a guard that, if it went wrong, would either do nothing
 * at all or stutter playback - both invisible until someone complains. The real
 * thing still needs a human and a long wait (docs/HAND-TEST.md); this pins the
 * conditions.
 */

/** jsdom has no decode pipeline, so readyState is stubbed per test. */
function stubReadyState(value: number) {
  Object.defineProperty(window.HTMLMediaElement.prototype, "readyState", {
    configurable: true,
    get: () => value,
  });
}

function renderPlayer(onDiag: (tag: string, msg: string) => void) {
  const ref = createRef<PlayerHandle>();
  const utils = render(
    <LocalMediaPlayer
      ref={ref}
      path="/tmp/a.mp4"
      hasVideo
      initialVolume={1}
      onDiag={onDiag}
    />,
  );
  const el = utils.container.querySelector("video") as HTMLVideoElement;
  return { el, utils };
}

/** Park the element: fire `pause`, then let the idle clock run past 10s. */
function parkFor(el: HTMLMediaElement, seconds: number) {
  act(() => { el.dispatchEvent(new Event("pause")); });
  vi.setSystemTime(new Date(Date.now() + seconds * 1000));
}

describe("warming the decoder after an idle", () => {
  let diag: Array<[string, string]>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    diag = [];
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Reflect.deleteProperty(window.HTMLMediaElement.prototype, "readyState");
  });

  const warmedAt = (d: Array<[string, string]>) => d.filter(([, m]) => m.startsWith("warmed the decoder"));

  it("re-seeks to the SAME position when a cold element comes back into view", () => {
    stubReadyState(0); // HAVE_NOTHING: the pipeline is gone
    const { el } = renderPlayer((t, m) => diag.push([t, m]));
    el.currentTime = 42;
    parkFor(el, 60);

    act(() => { document.dispatchEvent(new Event("visibilitychange")); });

    expect(warmedAt(diag)).toHaveLength(1);
    // The whole point: the parked frame survives the warm-up.
    expect(el.currentTime).toBe(42);
  });

  it("also warms on window focus, for a return from another app", () => {
    stubReadyState(0);
    const { el } = renderPlayer((t, m) => diag.push([t, m]));
    el.currentTime = 7;
    parkFor(el, 60);

    act(() => { window.dispatchEvent(new Event("focus")); });

    expect(warmedAt(diag)).toHaveLength(1);
    expect(el.currentTime).toBe(7);
  });

  it("does nothing when the decoder is still warm", () => {
    // readyState 4 = HAVE_ENOUGH_DATA. Seeking here is a pointless round trip.
    stubReadyState(4);
    const { el } = renderPlayer((t, m) => diag.push([t, m]));
    parkFor(el, 600);

    act(() => { window.dispatchEvent(new Event("focus")); });

    expect(warmedAt(diag)).toEqual([]);
  });

  it("does nothing after a short absence", () => {
    // Alt-tabbing away for two seconds is not an idle, and warming on every
    // such flick would seek constantly while someone works across two windows.
    stubReadyState(0);
    const { el } = renderPlayer((t, m) => diag.push([t, m]));
    parkFor(el, 2);

    act(() => { window.dispatchEvent(new Event("focus")); });

    expect(warmedAt(diag)).toEqual([]);
  });

  it("does nothing while the video is playing", () => {
    // A seek mid-playback stutters the thing the warm-up exists to protect.
    stubReadyState(0);
    const { el } = renderPlayer((t, m) => diag.push([t, m]));
    act(() => { el.dispatchEvent(new Event("pause")); });
    vi.setSystemTime(new Date(Date.now() + 60_000));
    Object.defineProperty(el, "paused", { configurable: true, get: () => false });

    act(() => { window.dispatchEvent(new Event("focus")); });

    expect(warmedAt(diag)).toEqual([]);
  });

  it("ignores a visibilitychange that HID the window", () => {
    // The event fires in both directions; only the reveal is a return.
    stubReadyState(0);
    const { el } = renderPlayer((t, m) => diag.push([t, m]));
    parkFor(el, 60);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });

    act(() => { document.dispatchEvent(new Event("visibilitychange")); });

    expect(warmedAt(diag)).toEqual([]);
    Reflect.deleteProperty(document, "hidden");
  });

  it("removes both listeners on unmount", () => {
    // Both live on window/document, which outlive the component, so a missed
    // removal keeps a dead player's closure alive for the whole session.
    //
    // Asserting "no diag fires after unmount" does NOT test this - React nulls
    // mediaRef on unmount, so the handler returns early whether or not it was
    // removed. That version passed with the cleanup deleted. Counting the
    // add/remove pairs is what actually distinguishes the two.
    stubReadyState(0);
    const winAdd = vi.spyOn(window, "addEventListener");
    const winRemove = vi.spyOn(window, "removeEventListener");
    const docAdd = vi.spyOn(document, "addEventListener");
    const docRemove = vi.spyOn(document, "removeEventListener");

    const { utils } = renderPlayer((t, m) => diag.push([t, m]));
    const count = (spy: typeof winAdd, ev: string) =>
      spy.mock.calls.filter(([name]) => name === ev).length;

    expect(count(winAdd, "focus")).toBeGreaterThan(0);
    expect(count(docAdd, "visibilitychange")).toBeGreaterThan(0);

    utils.unmount();

    expect(count(winRemove, "focus")).toBe(count(winAdd, "focus"));
    expect(count(docRemove, "visibilitychange")).toBe(count(docAdd, "visibilitychange"));

    for (const s of [winAdd, winRemove, docAdd, docRemove]) s.mockRestore();
  });
});
