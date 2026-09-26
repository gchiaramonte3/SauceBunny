// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { multitrackFixture } from "../test/multitrack-fixture";
import { TRACK_GAIN_MAX } from "../lib/multitrack-gain";
import { MultitrackTimeline } from "./MultitrackTimeline";
import { TimelineWaveform } from "./TimelineWaveform";

const contexts = new Map<HTMLCanvasElement, { clearRect: ReturnType<typeof vi.fn>; fillRect: ReturnType<typeof vi.fn> }>();
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "clientWidth", "get").mockReturnValue(4);
  vi.spyOn(HTMLCanvasElement.prototype, "clientHeight", "get").mockReturnValue(100);
  vi.stubGlobal("devicePixelRatio", 1);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    const context = contexts.get(this) ?? { clearRect: vi.fn(), fillRect: vi.fn() };
    contexts.set(this, context);
    return context as unknown as CanvasRenderingContext2D;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); contexts.clear(); });

function fixture() {
  const document = multitrackFixture();
  const peaks = [[-0.25, 0.25], [-0.125, 0.125]];
  return { document, waveforms: { "track-1": peaks, "track-2": [[-0.25, 0.25]] }, waveformErrors: {},
    selected: new Set<string>(), solo: new Set<string>(), onSelect: vi.fn(), onRename: vi.fn(), onSeek: vi.fn(), frame: 0 };
}

it("redraws only the adjusted track from cached peaks, including attenuation, silence and reset", () => {
  const props = fixture(), slice = vi.spyOn(props.waveforms["track-1"], "slice");
  const view = render(<MultitrackTimeline {...props} />);
  const canvases = [...contexts.keys()], first = contexts.get(canvases[0])!, second = contexts.get(canvases[1])!;
  expect(first.fillRect.mock.calls[0]).toEqual([0, 38, 1, 24]);
  const otherDraws = second.clearRect.mock.calls.length;
  for (const [gain, height] of [[2, 48], [0.5, 12], [1, 24]]) {
    first.fillRect.mockClear();
    view.rerender(<MultitrackTimeline {...props} levels={{ "track-1": gain }} />);
    expect(first.fillRect.mock.calls[0][3]).toBe(height);
    expect(second.clearRect).toHaveBeenCalledTimes(otherDraws);
    expect(view.container.querySelector("canvas")).toBe(canvases[0]);
  }
  first.fillRect.mockClear();
  view.rerender(<MultitrackTimeline {...props} levels={{ "track-1": 0 }} />);
  expect(first.fillRect.mock.calls).toEqual([[0, 49.5, 4, 1]]);
  expect(slice).toHaveBeenCalledTimes(1);
  expect(props.waveforms["track-1"]).toEqual([[-0.25, 0.25], [-0.125, 0.125]]);
  const draws = first.clearRect.mock.calls.length;
  view.rerender(<MultitrackTimeline {...props} levels={{ "track-1": 0 }} frame={24} />);
  expect(first.clearRect).toHaveBeenCalledTimes(draws);
});

it("applies gain to zoom-detail replacements and bounds +36 dB peaks within the lane", () => {
  const props = fixture(), gain = { "track-1": TRACK_GAIN_MAX };
  const detail = { start: 0, span: props.document.manifest.duration_frames, peaks: { "track-1": [[-0.001, 0.002]] } };
  const view = render(<MultitrackTimeline {...props} levels={gain} detail={detail} />);
  const first = contexts.values().next().value!;
  expect(first.fillRect.mock.calls[0][3]).toBeCloseTo(0.003 * TRACK_GAIN_MAX * 48, 4);
  first.fillRect.mockClear();
  view.rerender(<MultitrackTimeline {...props} levels={gain} />);
  expect(first.fillRect.mock.calls.slice(0, 4)).toEqual(Array.from({ length: 4 }, (_, x) => [x, 2, 1, 96]));
});

it("retains Clip's existing unity-gain geometry and peak-preserving reduction", () => {
  const peaks = { mins: Float32Array.of(-0.25, -0.5, -0.125, 0), maxs: Float32Array.of(0.125, 0.25, 0.5, 0) };
  vi.spyOn(HTMLCanvasElement.prototype, "clientWidth", "get").mockReturnValue(2);
  render(<TimelineWaveform peaks={peaks} widthPx={2} />);
  const first = contexts.values().next().value!;
  expect(first.fillRect.mock.calls).toEqual([[0, 39, 1, 33], [1, 28, 1, 27.5], [0, 49.5, 2, 1]]);
});

it.each([1, 2])("keeps the same CSS amplitude on a %s× display", (dpr) => {
  vi.stubGlobal("devicePixelRatio", dpr);
  render(<MultitrackTimeline {...fixture()} levels={{ "track-1": 2 }} />);
  const first = contexts.values().next().value!;
  expect(first.fillRect.mock.calls[0]).toEqual([0, 26 * dpr, 1, 48 * dpr]);
});
