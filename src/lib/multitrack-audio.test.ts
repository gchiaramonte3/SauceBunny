// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MultitrackAudio } from "./multitrack-audio";
import { MultitrackAudioCache } from "./multitrack-audio-cache";
import { trackDbToGain, TRACK_GAIN_MAX } from "./multitrack-gain";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (path: string) => `asset:${path}` }));
const sources: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
let context: FakeContext;
class FakeContext {
  onstatechange: (() => void) | null = null;
  gains: Array<{ gain: { value: number; setValueCurveAtTime: ReturnType<typeof vi.fn> }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  currentTime = 0; state = "running"; destination = {}; resume = vi.fn().mockResolvedValue(undefined); close = vi.fn().mockResolvedValue(undefined);
  constructor() { context = this; }
  createGain() { const gain = { gain: { value: 1, setValueCurveAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() }; this.gains.push(gain); return gain; }
  createBufferSource() { const source = { start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), connect: vi.fn(), buffer: null, onended: null }; sources.push(source); return source; }
  decodeAudioData = vi.fn().mockResolvedValue({ duration: 5 });
}
beforeEach(() => {
  sources.length = 0; vi.clearAllMocks(); vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("requestAnimationFrame", vi.fn().mockReturnValue(1)); vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
  invoke.mockImplementation((command, args) => Promise.resolve(command === "aaf_prepare_audio" ? { path: `/audio/${args.trackId}.wav` } : undefined));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("one-clock PCM audition", () => {
  it("resumes WebKit's interrupted output before starting cached audio", async () => {
    const changed = vi.fn(), player = new MultitrackAudio("doc", 24, 240, ["a"], changed);
    await player.warm(0); context.state = "interrupted";
    context.resume.mockImplementation(async () => { context.state = "running"; });
    await player.seek(0, 1);
    expect(context.resume).toHaveBeenCalledTimes(1);
    expect(sources.length).toBeGreaterThan(0);
    expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ rate: 1, error: null });
    player.close();
  });
  it("does not report playing when the audio output cannot resume", async () => {
    const changed = vi.fn(), player = new MultitrackAudio("doc", 24, 240, ["a"], changed);
    await player.warm(0); context.state = "interrupted";
    await player.seek(0, 1);
    expect(sources).toHaveLength(0);
    expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ rate: 0, busy: false, error: expect.stringMatching(/audio output/i) });
    player.close();
  });
  it("parks playback on output interruption and resumes only on a new Play", async () => {
    const changed = vi.fn(), player = new MultitrackAudio("doc", 24, 240, ["a"], changed);
    await player.seek(24, 1); context.currentTime = 1;
    context.state = "interrupted"; context.onstatechange?.();
    expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ rate: 0, busy: false, error: expect.stringMatching(/interrupted/) });
    expect(sources[0].stop).toHaveBeenCalled();
    const parked = changed.mock.calls.at(-1)![0].frame;
    context.state = "running"; context.onstatechange?.();
    expect(changed.mock.calls.at(-1)![0].rate).toBe(0);
    await player.seek(parked, 1);
    expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ rate: 1, error: null });
    player.close(); expect(context.onstatechange).toBeNull();
  });
  it("rejects an output interruption during cold audio preparation", async () => {
    context = new FakeContext();
    const changed = vi.fn(), player = new MultitrackAudio("doc", 24, 240, ["a"], changed);
    context.decodeAudioData.mockImplementation(async () => { context.state = "interrupted"; return { duration: 5 }; });
    await player.seek(0, 1);
    expect(sources).toHaveLength(0);
    expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ rate: 0, busy: false, error: expect.stringMatching(/interrupted/) });
    player.close();
  });
  it.each([24, 24000 / 1001])("warms boundary look-ahead for 20 microphones at %s fps without sounding them", async (fps) => {
    const ids = Array.from({ length: 20 }, (_, index) => String(index)), boundary = Math.ceil(5 * fps);
    const changed = vi.fn(), player = new MultitrackAudio("doc", fps, boundary * 4, ids, changed);
    await player.warm(boundary - 1);
    expect(sources).toHaveLength(0); expect(context.resume).not.toHaveBeenCalled();
    const reads = invoke.mock.calls.filter(([command]) => command === "aaf_prepare_audio");
    expect(reads).toHaveLength(40);
    expect(new Set(reads.map(([, args]) => args.startFrame))).toEqual(new Set([0, boundary]));
    await player.seek(boundary - 1, 1);
    await vi.waitFor(() => expect(sources).toHaveLength(40));
    expect(sources.slice(0, 20).every(source => source.start.mock.calls[0][0] === .015)).toBe(true);
    const nextTime = sources[20].start.mock.calls[0][0];
    expect(nextTime).toBeCloseTo(.015 + 1 / fps);
    expect(sources.slice(20).every(source => source.start.mock.calls[0][0] === nextTime)).toBe(true);
    context.currentTime = nextTime + .01;
    vi.mocked(requestAnimationFrame).mock.calls.at(-1)![0](100);
    expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ rate: 1, busy: false, error: null }); player.close();
  });
  it.each([24, 24000 / 1001])("holds the clock at missing audio and resumes a late block automatically at %s fps", async (fps) => {
    const boundary = Math.ceil(5 * fps), pending: Array<() => void> = [];
    let delayed = true;
    invoke.mockImplementation((command, args) => command === "aaf_prepare_audio" && args.startFrame === boundary && delayed
      ? new Promise(resolve => pending.push(() => resolve({ path: `/audio/${args.trackId}.wav` })))
      : Promise.resolve(command === "aaf_prepare_audio" ? { path: `/audio/${args.trackId}.wav` } : undefined));
    const changed = vi.fn(), ids = Array.from({ length: 20 }, (_, index) => String(index));
    const player = new MultitrackAudio("doc", fps, boundary * 4, ids, changed);
    await player.seek(boundary - 1, 1);
    context.currentTime = .1;
    vi.mocked(requestAnimationFrame).mock.calls.at(-1)![0](100);
    expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ frame: boundary, rate: 1, busy: true, error: null });
    delayed = false; pending.splice(0).forEach(finish => finish());
    await vi.waitFor(() => expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ frame: boundary, rate: 1, busy: false, error: null }));
    expect(sources.slice(20, 40).every(source => source.start.mock.calls[0][1] === 0)).toBe(true);
    expect(changed.mock.calls.every(([state]) => state.frame <= boundary)).toBe(true); player.close();
  });
  it.each(["pause", "seek", "close"] as const)("does not resume a late audio block after %s", async (action) => {
    let finish!: (value: unknown) => void;
    invoke.mockImplementation((command, args) => command === "aaf_prepare_audio" && args.startFrame === 120
      ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(command === "aaf_prepare_audio" ? { path: "/audio/a.wav" } : undefined));
    const changed = vi.fn(), player = new MultitrackAudio("doc", 24, 480, ["a"], changed);
    await player.seek(119, 1); context.currentTime = .1;
    vi.mocked(requestAnimationFrame).mock.calls.at(-1)![0](100);
    if (action === "pause") player.pause(); else if (action === "close") player.close(); else await player.seek(300, 0, false);
    const voices = sources.length;
    finish({ path: "/late.wav" });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(sources).toHaveLength(voices);
    expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ rate: 0, busy: false, error: null });
    if (action !== "close") player.close();
  });
  it("recovers a late block even before the next animation tick", async () => {
    let finish!: (value: unknown) => void;
    invoke.mockImplementation((command, args) => command === "aaf_prepare_audio" && args.startFrame === 120
      ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(command === "aaf_prepare_audio" ? { path: "/audio/a.wav" } : undefined));
    const changed = vi.fn(), player = new MultitrackAudio("doc", 24, 240, ["a"], changed);
    await player.seek(119, 1); context.currentTime = .1;
    finish({ path: "/next.wav" });
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    expect(sources[1].start.mock.calls[0]).toEqual([.115, 0, 5]);
    expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ frame: 120, rate: 1, busy: false, error: null }); player.close();
  });
  it("a long missing block holds playback rather than falsely reaching EOF", async () => {
    let fail!: (cause: Error) => void;
    invoke.mockImplementation((command, args) => command === "aaf_prepare_audio" && args.startFrame === 120
      ? new Promise((_, reject) => { fail = reject; }) : Promise.resolve(command === "aaf_prepare_audio" ? { path: "/audio/a.wav" } : undefined));
    const changed = vi.fn(), player = new MultitrackAudio("doc", 24, 240, ["a"], changed);
    await player.seek(119, 1); context.currentTime = 60;
    vi.mocked(requestAnimationFrame).mock.calls.at(-1)![0](60000);
    expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ frame: 120, rate: 1, busy: true, error: null });
    fail(new Error("PCM read failed"));
    await vi.waitFor(() => expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ frame: 120, rate: 0, busy: false, error: "PCM read failed" }));
    expect(invoke.mock.calls.filter(([command]) => command === "aaf_prepare_audio")).toHaveLength(2); player.close();
  });
  it("completes a settled seek without waiting for look-ahead, and Play reuses that pending read", async () => {
    let finish!: (value: unknown) => void;
    invoke.mockImplementation((command, args) => command === "aaf_prepare_audio" && args.startFrame === 120
      ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(command === "aaf_prepare_audio" ? { path: "/audio/a.wav" } : undefined));
    const changed = vi.fn(), player = new MultitrackAudio("doc", 24, 240, ["a"], changed);
    await player.seek(119, 0, false);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ frame: 119, rate: 0, busy: false });
    await player.seek(119, 1);
    expect(sources).toHaveLength(1);
    finish({ path: "/next.wav" });
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    expect(invoke.mock.calls.filter(([command]) => command === "aaf_prepare_audio")).toHaveLength(2); player.close();
  });
  it("plays the last frame before stopping at EOF without preparing an empty block", async () => {
    const changed = vi.fn(), player = new MultitrackAudio("doc", 24, 120, ["a"], changed);
    await player.seek(119, 1);
    expect(changed.mock.calls.at(-1)?.[0].rate).toBe(1);
    context.currentTime = .06; vi.mocked(requestAnimationFrame).mock.calls.at(-1)![0](60);
    expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ frame: 119, rate: 0, error: null });
    expect(invoke.mock.calls.filter(([command]) => command === "aaf_prepare_audio")).toHaveLength(1); player.close();
  });
  it("disabled scrubbing moves the pointer without waking audio or preparing files", () => {
    vi.useFakeTimers(); const changed = vi.fn(), player = new MultitrackAudio("doc", 24, 2400, ["a"], changed);
    context.state = "suspended"; player.setScrubbing(false); player.scrub(120); vi.advanceTimersByTime(200);
    expect(context.resume).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled(); expect(sources).toHaveLength(0);
    expect(changed.mock.calls.at(-1)?.[0].frame).toBe(120); player.close();
  });
  it("Stop or disabling scrub rejects a late context-resume callback", async () => {
    for (const action of ["stop", "disable"] as const) {
      const player = new MultitrackAudio("doc", 24, 120, ["a"], vi.fn()); await player.warm(0); context.state = "suspended";
      let finish!: () => void; context.resume.mockImplementation(() => new Promise<void>((resolve) => { finish = () => { context.state = "running"; resolve(); }; }));
      player.scrub(24); if (action === "stop") player.pause(); else player.setScrubbing(false); finish();
      for (let index = 0; index < 5; index++) await Promise.resolve();
      expect(sources).toHaveLength(0); player.close();
    }
  });
  it("adjusts one track's active gain without decoding, seeking or changing the master", async () => {
    const player = new MultitrackAudio("doc", 24, 120, ["a", "b"], vi.fn());
    player.setTrackLevel("a", 0.25); player.setTrackLevel("b", 0.75); player.setLevel(0.8, false);
    await player.seek(24, 1);
    const before = invoke.mock.calls.length, voiceCount = sources.length;
    player.setTrackLevel("a", 0.5);
    expect(context.gains.slice(0, 3).map((node) => node.gain.value)).toEqual([0.8, 0.5, 0.75]);
    expect(context.gains[3].connect).toHaveBeenCalledWith(context.gains[1]);
    expect(context.gains[4].connect).toHaveBeenCalledWith(context.gains[2]);
    expect(invoke).toHaveBeenCalledTimes(before); expect(sources).toHaveLength(voiceCount);
    expect(sources.every((voice) => !voice.stop.mock.calls.length)).toBe(true); player.close();
  });
  it("boosts one live track through +36 dB without restarting voices or bypassing master mute", async () => {
    const player = new MultitrackAudio("doc", 24, 120, ["a", "b"], vi.fn());
    player.setTrackLevel("a", 1); player.setTrackLevel("b", 1);
    await player.seek(24, 1);
    const reads = invoke.mock.calls.length, voices = sources.length;
    for (const db of [10, 12, 36, -12]) {
      player.setTrackLevel("a", trackDbToGain(db));
      expect(context.gains[1].gain.value).toBeCloseTo(10 ** (db / 20));
      expect(context.gains[2].gain.value).toBe(1);
    }
    player.setLevel(1, true); player.setTrackLevel("a", 1e10);
    expect(context.gains[0].gain.value).toBe(0); expect(context.gains[1].gain.value).toBe(TRACK_GAIN_MAX);
    expect(context.gains[1].connect).toHaveBeenCalledWith(context.gains[0]);
    player.setLevel(.5, false); expect(context.gains[1].gain.value).toBe(TRACK_GAIN_MAX);
    player.setTrackLevel("a", 0); expect(context.gains[1].gain.value).toBe(0);
    expect(invoke).toHaveBeenCalledTimes(reads); expect(sources).toHaveLength(voices);
    expect(sources.every(voice => !voice.stop.mock.calls.length)).toBe(true); player.close();
  });
  it("unlocks already-warm audio from a scrub gesture and sounds the latest pointer, not the first", async () => {
    const player = new MultitrackAudio("doc", 24, 120, ["a"], vi.fn());
    await player.warm(0); context.state = "suspended";
    let resume!: () => void;
    context.resume.mockImplementation(() => new Promise<void>((resolve) => { resume = () => { context.state = "running"; resolve(); }; }));
    player.scrub(24); player.scrub(48); resume();
    for (let index = 0; index < 5; index++) await Promise.resolve();
    expect(context.resume).toHaveBeenCalledTimes(1);
    expect(sources).toHaveLength(1); expect(sources[0].start.mock.calls[0][1]).toBeCloseTo(2 - 0.0275);
    player.close();
  });
  it("keeps the latest throttled grain and cancels it on Stop", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const player = new MultitrackAudio("doc", 24, 120, ["a"], vi.fn()); await player.warm(0);
    player.scrub(24); vi.advanceTimersByTime(10); player.scrub(48); player.scrub(60);
    expect(sources).toHaveLength(1); vi.advanceTimersByTime(23);
    expect(sources).toHaveLength(2); expect(sources[1].start.mock.calls[0][1]).toBeCloseTo(2.5 - 0.0275);
    player.scrub(72); player.pause(); vi.advanceTimersByTime(50); expect(sources).toHaveLength(2); player.close();
  });
  it("schedules multiple microphones at exactly the same clock time and stops every voice", async () => {
    const changed = vi.fn(), player = new MultitrackAudio("doc", 24, 2400, ["a", "b"], changed);
    await player.seek(24, 1);
    expect(sources[0].start.mock.calls[0]).toEqual([0.015, 1, 4]);
    expect(sources[1].start.mock.calls[0]).toEqual(sources[0].start.mock.calls[0]);
    context.currentTime = 2.015; player.pause();
    expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ frame: 72, rate: 0 });
    for (const source of sources) expect(source.stop).toHaveBeenCalled();
    player.close();
  });
  it("reuses decoded PCM for in-window seeks and no longer assigns solo when seeking", async () => {
    const player = new MultitrackAudio("doc", 24000 / 1001, 24000, ["a"], vi.fn());
    await player.seek(0); await player.seek(100);
    await player.warm(100);
    expect(invoke.mock.calls.filter(([command]) => command === "aaf_prepare_audio").map(([, args]) => args.startFrame)).toEqual([0, 120]);
    player.close();
  });
  it("rejects late preparation after Stop and source disposal", async () => {
    let finish!: (value: unknown) => void;
    invoke.mockImplementation((command) => command === "aaf_prepare_audio" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve());
    const player = new MultitrackAudio("doc", 24, 2400, ["a"], vi.fn());
    const pending = player.seek(0, 1); player.close(); finish({ path: "/old.wav" }); await pending;
    expect(sources).toHaveLength(0); expect(fetch).not.toHaveBeenCalled();
    expect(invoke.mock.calls.some(([command]) => command === "cancel_job")).toBe(true);
  });
  it("updates a cold drag immediately without launching a native job on every pointer event", () => {
    const changed = vi.fn(), player = new MultitrackAudio("doc", 24, 2400, ["a"], changed);
    for (let frame = 100; frame < 150; frame++) player.scrub(frame);
    expect(changed.mock.calls.at(-1)?.[0].frame).toBe(149); expect(invoke).not.toHaveBeenCalled(); player.close();
  });
  it("reports a failed prepared-file read instead of pretending playback began", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 403 } as Response);
    const changed = vi.fn(), player = new MultitrackAudio("doc", 24, 2400, ["a"], changed);
    await player.seek(0, 1);
    expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ rate: 0, busy: false, error: expect.stringContaining("403") }); expect(sources).toHaveLength(0); player.close();
  });
  it("deduplicates pending range/track requests across concurrent callers", async () => {
    const ctx = new FakeContext() as unknown as AudioContext;
    const cache = new MultitrackAudioCache("doc", 24, 2400, ctx);
    await Promise.all([cache.get(["a", "b"], 0), cache.get(["a", "b"], 100)]);
    expect(invoke.mock.calls.filter(([command]) => command === "aaf_prepare_audio")).toHaveLength(2); cache.cancel();
  });
  it("changes a parked audition mix without sounding a grain or starting playback", async () => {
    const changed = vi.fn(), player = new MultitrackAudio("doc", 24, 2400, ["a", "b"], changed);
    await player.seek(24, 0, false);
    player.setTracks(["a"]); await Promise.resolve();
    expect(sources).toHaveLength(0);
    expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ frame: 24, rate: 0 }); player.close();
  });
  it("keeps rapid J/L intent while preparation is pending and resets it on K", async () => {
    const finish: Array<(value: unknown) => void> = [];
    invoke.mockImplementation((command) => command === "aaf_prepare_audio" ? new Promise((resolve) => finish.push(resolve)) : Promise.resolve());
    const changed = vi.fn(), player = new MultitrackAudio("doc", 24, 2400, ["a"], changed);
    const first = player.shuttle(1), second = player.shuttle(1);
    finish.forEach((resolve) => resolve({ path: "/audio/a.wav" }));
    await Promise.all([first, second]);
    expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ rate: 2 });
    context.currentTime = 1; player.pause(); await player.shuttle(-1);
    expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ rate: -1 }); player.close();
  });
});
it("warms all microphones silently and reuses completed audio across Pause", async () => {
  const ids = Array.from({ length: 20 }, (_, index) => String(index));
  const player = new MultitrackAudio("doc", 24, 120, ids, vi.fn());
  await player.warm(0); expect(sources).toHaveLength(0);
  expect(context.resume).not.toHaveBeenCalled();
  const before = invoke.mock.calls.filter(([command]) => command === "aaf_prepare_audio").length;
  for (let index = 0; index < 20; index++) { await player.seek(24, 1); player.pause(); }
  expect(before).toBe(20);
  expect(invoke.mock.calls.filter(([command]) => command === "aaf_prepare_audio")).toHaveLength(before);
  player.close();
});
it("Play reuses an unfinished silent preparation instead of restarting its jobs", async () => {
  let finish!: (value: unknown) => void;
  invoke.mockImplementation((command) => command === "aaf_prepare_audio" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve());
  const player = new MultitrackAudio("doc", 24, 120, ["a"], vi.fn());
  const warm = player.warm(0), play = player.seek(24, 1);
  finish({ path: "/audio/a.wav" }); await Promise.all([warm, play]);
  expect(invoke.mock.calls.filter(([command]) => command === "aaf_prepare_audio")).toHaveLength(1);
  expect(sources).toHaveLength(1); player.close();
});
it("evicts obsolete queued windows before launching their native readers", async () => {
  const pending: Array<() => void> = [];
  invoke.mockImplementation((command) => command === "aaf_prepare_audio" ? new Promise((resolve) => pending.push(() => resolve({ path: "/audio/a.wav" }))) : Promise.resolve());
  const cache = new MultitrackAudioCache("doc",24,2400,new FakeContext() as unknown as AudioContext);
  const first = cache.get(["a","b","c","d"],0).catch(() => null);
  const second = cache.get(["a","b"],120).catch(() => null);
  const last = cache.get(["a","b"],240);
  pending.splice(0).forEach(resolve => resolve());
  for (let index=0;index<20;index++) { await Promise.resolve(); pending.splice(0).forEach(resolve=>resolve()); }
  await Promise.all([first,second,last]);
  const old=invoke.mock.calls.filter(([command,args])=>command==="aaf_prepare_audio"&&args.startFrame===0);
  expect(old).toHaveLength(2); // c/d never escape the obsolete queue.
  expect(invoke.mock.calls.filter(([command])=>command==="cancel_job")).toHaveLength(2);
  const calls=invoke.mock.calls.filter(([command])=>command==="aaf_prepare_audio").length;
  cache.cancel(); await cache.get(["a","b"],240);
  expect(invoke.mock.calls.filter(([command])=>command==="aaf_prepare_audio")).toHaveLength(calls);
  cache.clear();
});
