// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ViewerShareController, type ViewerShareDeps } from "./viewer-share";

function streamWith(video: number, audio: number): MediaStream {
  return {
    getVideoTracks: () => Array.from({ length: video }, (_, i) => ({ id: `v${i}`, kind: "video" })),
    getAudioTracks: () => Array.from({ length: audio }, (_, i) => ({ id: `a${i}`, kind: "audio" })),
  } as unknown as MediaStream;
}

function el(video: number, audio: number): HTMLVideoElement {
  const v = document.createElement("video");
  Object.defineProperty(v, "readyState", { value: 4, configurable: true });
  (v as HTMLVideoElement & { captureStream: () => MediaStream }).captureStream =
    () => streamWith(video, audio);
  return v;
}

function harness(element: HTMLVideoElement | null) {
  const calls = {
    video: [] as (MediaStreamTrack | null)[],
    audio: [] as (MediaStreamTrack | null)[],
    announced: [] as boolean[],
    states: [] as string[],
    logs: [] as string[],
  };
  const deps: ViewerShareDeps = {
    getElement: () => element,
    setOverride: (t) => calls.video.push(t),
    setAudioOverride: (t) => calls.audio.push(t),
    announce: (on) => calls.announced.push(on),
    onChange: (s) => calls.states.push(s),
    log: (_t, m) => calls.logs.push(m),
  };
  return { calls, ctl: new ViewerShareController(deps) };
}

describe("showing a peer what you are watching", () => {
  it("pushes the captured picture and sound onto the mesh", () => {
    const { ctl, calls } = harness(el(1, 1));
    expect(ctl.start()).toBe(true);
    expect(calls.video[0]).toMatchObject({ kind: "video" });
    expect(calls.audio[0]).toMatchObject({ kind: "audio" });
    expect(calls.announced).toEqual([true]);
    expect(ctl.getState()).toBe("live");
  });

  it("announces itself, because an unannounced live view is the whole hazard", () => {
    // It is a real-time encode. CLAUDE.md excludes that as a playback surface
    // precisely so nobody judges a grade from transport compression, which
    // means the room has to be told this is what it is looking at.
    const { ctl, calls } = harness(el(1, 1));
    ctl.start();
    expect(calls.announced).toEqual([true]);
    ctl.stop();
    expect(calls.announced).toEqual([true, false]);
  });

  it("does not silence the microphone when the engine has no audio", () => {
    // The canvas path carries no sound. Pushing a null audio override would
    // take the presenter's MIC down with it, so the room would go quiet the
    // moment somebody shared a mediabunny-decoded source.
    const { ctl, calls } = harness(el(1, 0));
    expect(ctl.start()).toBe(true);
    expect(calls.video).toHaveLength(1);
    expect(calls.audio, "an audio override was pushed for a silent capture").toEqual([]);
  });

  it("reports failure instead of claiming a share that is not running", () => {
    const { ctl, calls } = harness(null);
    expect(ctl.start()).toBe(false);
    expect(ctl.getState()).toBe("off");
    expect(calls.announced, "the room was told about a share that never started").toEqual([]);
    expect(calls.logs).toHaveLength(1);
  });

  it("hands the senders back on stop", () => {
    const { ctl, calls } = harness(el(1, 1));
    ctl.start();
    ctl.stop();
    expect(calls.video.at(-1)).toBe(null);
    expect(calls.audio.at(-1)).toBe(null);
    expect(ctl.getState()).toBe("off");
  });

  it("is idempotent at both ends", () => {
    const { ctl, calls } = harness(el(1, 1));
    ctl.start(); ctl.start();
    ctl.stop(); ctl.stop();
    expect(calls.announced).toEqual([true, false]);
  });

  it("re-captures when the source changes underneath it", () => {
    const { ctl, calls } = harness(el(1, 1));
    ctl.start();
    ctl.resync();
    expect(calls.video).toHaveLength(2);
    // Still one announcement: the room is already being told.
    expect(calls.announced).toEqual([true]);
  });

  it("stops rather than freezing on the last frame when the new source cannot be shared", () => {
    // Carrying on would look like a working share of a stalled video, which
    // is worse than an honest stop: nobody would know to ask for the file.
    const calls = { video: [] as (MediaStreamTrack | null)[], announced: [] as boolean[] };
    let element: HTMLVideoElement | null = el(1, 1);
    const ctl = new ViewerShareController({
      getElement: () => element,
      setOverride: (t) => calls.video.push(t),
      setAudioOverride: () => {},
      announce: (on) => calls.announced.push(on),
      onChange: () => {},
      log: () => {},
    });
    ctl.start();
    element = null;
    ctl.resync();
    expect(ctl.getState()).toBe("off");
    expect(calls.video.at(-1)).toBe(null);
    expect(calls.announced).toEqual([true, false]);
  });

  it("resync does nothing when nothing is live", () => {
    const { ctl, calls } = harness(el(1, 1));
    ctl.resync();
    expect(calls.video).toEqual([]);
  });
});
