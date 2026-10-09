// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { EditDocument } from "../bindings/EditDocument";
import { EditAudio, JOIN_FADE_SECONDS, planBlocks, programToSource, trackPieces } from "./edit-audio";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (path: string) => `asset:${path}` }));

type Curve = { curve: Float32Array; when: number; duration: number };
type FakeGain = { gain: { value: number; curves: Curve[]; setValueCurveAtTime: (curve: Float32Array, when: number, duration: number) => void }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
type FakeSource = { buffer: { duration: number; track: string } | null; gain: FakeGain | null; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; connect: (gain: FakeGain) => void; onended: null };
const sources: FakeSource[] = [];
let context: FakeContext;
class FakeContext {
  onstatechange: (() => void) | null = null;
  currentTime = 0; state = "running"; destination = {};
  resume = vi.fn().mockResolvedValue(undefined); close = vi.fn().mockResolvedValue(undefined);
  gains: FakeGain[] = [];
  constructor() { context = this; }
  createGain(): FakeGain {
    const curves: Curve[] = [];
    const gain: FakeGain = { gain: { value: 1, curves, setValueCurveAtTime: (curve, when, duration) => { curves.push({ curve, when, duration }); } }, connect: vi.fn(), disconnect: vi.fn() };
    this.gains.push(gain); return gain;
  }
  createDynamicsCompressor() {
    const param = () => ({ value: 0 });
    return { threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), connect: vi.fn(), disconnect: vi.fn() };
  }
    createBufferSource() {
    const source: FakeSource = { buffer: null, gain: null, start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), onended: null,
      connect: (gain) => { source.gain = gain; } };
    sources.push(source); return source;
  }
  // Each decoded window remembers which AAF track it came from.
  decodeAudioData = vi.fn(async (data: ArrayBuffer & { track?: string }) => ({ duration: 5, track: data.track ?? "?" }));
}

const FPS = 24;
// S1 [0,48) · gap 24 · S2 [250,310) · S1 [100,160), which crosses S1's window at 120.
// T1 has a mic in both sources, T2 only in S1.
const edit = (mutes: EditDocument["mutes"] = []): EditDocument => ({
  schema_version: 1, title: "Edit", edit_rate: { numerator: 24, denominator: 1 }, start_timecode_frames: 0,
  sources: [{ id: "S1", name: "One", document_id: "d1" }, { id: "S2", name: "Two", document_id: "d2" }],
  tracks: [
    { id: "T1", name: "Ann", kind: "sound", source_tracks: { S1: "a1", S2: "a2" } },
    { id: "T2", name: "Bob", kind: "sound", source_tracks: { S1: "b1" } },
  ],
  segments: [
    { kind: "source", id: "g1", source: "S1", in_frame: 0, out_frame: 48 },
    { kind: "gap", id: "g2", frames: 24 },
    { kind: "source", id: "g3", source: "S2", in_frame: 250, out_frame: 310 },
    { kind: "source", id: "g4", source: "S1", in_frame: 100, out_frame: 160 },
  ],
  mutes, markers: [],
});

const voices = (track: string) => sources.filter((source) => source.buffer?.track === track);
const startOf = (source: FakeSource) => source.start.mock.calls[0] as [number, number, number];
const prepared = () => invoke.mock.calls.filter(([command]) => command === "aaf_prepare_audio").map(([, args]) => args);
const tick = () => vi.mocked(requestAnimationFrame).mock.calls.at(-1)![0](0);

beforeEach(() => {
  sources.length = 0; vi.clearAllMocks(); vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("requestAnimationFrame", vi.fn().mockReturnValue(1)); vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const data = Object.assign(new ArrayBuffer(8), { track: url.split("/").at(-1)?.replace(".wav", "") });
    return { ok: true, arrayBuffer: async () => data };
  }));
  invoke.mockImplementation((command, args) => Promise.resolve(command === "aaf_prepare_audio" ? { path: `/audio/${args.trackId}.wav` } : undefined));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("edit list mapping", () => {
  it("maps program frames through segments and gaps to source frames", () => {
    const document = edit();
    expect(programToSource(document, 10)).toEqual({ segment: 0, source: "S1", frame: 10 });
    expect(programToSource(document, 50)).toEqual({ segment: 1, source: null, frame: 2 });
    expect(programToSource(document, 72)).toEqual({ segment: 2, source: "S2", frame: 250 });
    expect(programToSource(document, 140)).toEqual({ segment: 3, source: "S1", frame: 108 });
    expect(programToSource(document, 191)).toEqual({ segment: 3, source: "S1", frame: 159 });
    expect(programToSource(document, 192)).toBeNull();
    const blocks = planBlocks(document, 120);
    expect(blocks.map((block) => [block.program, block.end, block.source, block.at, block.window, block.joinIn, block.joinOut])).toEqual([
      [0, 48, "S1", 0, 0, false, true],
      [48, 72, null, 0, 0, true, true],
      [72, 132, "S2", 250, 240, true, true],
      // A window edge inside a segment is contiguous audio, not a join.
      [132, 152, "S1", 100, 0, true, false],
      [152, 192, "S1", 120, 120, false, false],
    ]);
  });
  it("cuts a track's mutes out of its pieces and fades their edges", () => {
    const document = edit([{ source: "S1", track: "T1", in_frame: 12, out_frame: 24 }]), [first] = planBlocks(document, 120);
    expect(trackPieces(document, first, "T1")).toEqual([
      { from: 0, to: 12, fadeIn: null, fadeOut: "mute" },
      { from: 24, to: 48, fadeIn: "mute", fadeOut: "join" },
    ]);
    expect(trackPieces(document, first, "T2")).toEqual([{ from: 0, to: 48, fadeIn: null, fadeOut: "join" }]);
  });
});

describe("a long silence", () => {
  it("plays on a new output after a minute without sound, at the levels it had", async () => {
    // 2026-10-08: after a long idle String Outs played nothing. The Mac's output was a remote-desktop
    // session's virtual device, which goes and comes back; the old output stayed "running" on nothing.
    let now = 1_000_000; const clock = vi.spyOn(performance, "now").mockImplementation(() => now); onTestFinished(() => clock.mockRestore());
    const notify = vi.fn(), player = new EditAudio(FPS, notify);
    player.setDocument(edit(), ["T1", "T2"]); player.setLevel(0.5, false); player.setTrackLevel("T1", 2);
    await player.seek(0, 1); player.pause();
    const first = context;
    now += 39 * 60_000; sources.length = 0;
    await player.seek(0, 1);
    expect(context).not.toBe(first);
    expect(first.close).toHaveBeenCalled();
    // The master rebuilt at the volume asked for, T1's level carried over, and both mics play on it.
    expect(context.gains[0].gain.value).toBe(0.5);
    expect(context.gains.some((gain) => gain.gain.value === 2)).toBe(true);
    expect(voices("a1").length).toBeGreaterThan(0);
    expect(voices("b1").length).toBeGreaterThan(0);
    expect(notify.mock.lastCall![0]).toMatchObject({ rate: 1, error: null });
    // Playing again straight away keeps the same output.
    const second = context; player.pause(); await player.seek(0, 1);
    expect(context).toBe(second);
    player.close();
  });

  it("makes the output again and carries on when its clock stops while playing", async () => {
    let now = 1_000_000; const clock = vi.spyOn(performance, "now").mockImplementation(() => now); onTestFinished(() => clock.mockRestore());
    const notify = vi.fn(), player = new EditAudio(FPS, notify);
    player.setDocument(edit(), ["T1"]);
    await player.seek(10, 1);
    const first = context;
    tick();
    // Two seconds on the page's clock, watched every second, none on the audio clock: it has stopped.
    now += 1_000; tick();
    expect(context).toBe(first);
    now += 1_000; tick();
    await vi.waitFor(() => expect(context).not.toBe(first));
    await vi.waitFor(() => expect(notify.mock.lastCall![0]).toMatchObject({ rate: 1, error: null }));
    player.close();
  });
});

describe("shuttle", () => {
  it("J and L step Avid's ladder both ways, a shuttle moves the playhead at its speed, and L at 1x is playback", async () => {
    const notify = vi.fn(), player = new EditAudio(FPS, notify);
    const last = () => notify.mock.lastCall![0] as { frame: number; rate: number };
    player.setDocument(edit(), ["T1", "T2"]);
    await player.seek(100, 0);
    await player.shuttle(-1);
    expect(last().rate).toBe(-1);
    // A second of the clock at -1x: a second's worth of frames back.
    context.currentTime += 1; tick();
    expect(last().frame).toBe(100 - FPS);
    await player.shuttle(-1);
    expect(last().rate).toBe(-2);
    await player.shuttle(1);
    expect(last().rate).toBe(-1);
    // From -1x, L flips to 1x forward: ordinary playback.
    await player.shuttle(1);
    expect(last().rate).toBe(1);
    await player.shuttle(1);
    expect(last().rate).toBe(2);
    // Running into the start stops it there.
    player.pause(); await player.seek(5, 0); await player.shuttle(-1);
    context.currentTime += 1; tick();
    expect(last()).toMatchObject({ frame: 0, rate: 0 });
  });
});

describe("joins", () => {
  // S1 [0,48) then S1 [48,96): one take, split because T2 was overwritten in the second half.
  const split = (): EditDocument => {
    const document = edit();
    document.segments = [
      { kind: "source", id: "a", source: "S1", in_frame: 0, out_frame: 48 },
      { kind: "source", id: "b", source: "S1", in_frame: 48, out_frame: 96, overrides: { T2: { source: "S1", in_frame: 300 } } },
    ];
    return document;
  };

  it("fades a track only where its own material changes: one that carries on across another track's cut plays straight through", async () => {
    const document = split(), [first, second] = planBlocks(document, 120);
    expect([first.joinOut, second.joinIn]).toEqual([true, true]);
    // Ann (T1) runs on from frame 48 to 48: no fade either side of the boundary.
    expect(trackPieces(document, first, "T1")).toEqual([{ from: 0, to: 48, fadeIn: null, fadeOut: null }]);
    expect(trackPieces(document, second, "T1")).toEqual([{ from: 48, to: 96, fadeIn: null, fadeOut: null }]);
    // Bob (T2) jumps to frame 300 there: a cut, faded.
    expect(trackPieces(document, first, "T2")).toEqual([{ from: 0, to: 48, fadeIn: null, fadeOut: "join" }]);
    expect(trackPieces(document, second, "T2", second.program, second.overrides![0])).toEqual([{ from: 300, to: 348, fadeIn: "join", fadeOut: null }]);
  });

  it("plays every track at unity, as Media Composer does, however many people are heard", () => {
    const player = new EditAudio(FPS, vi.fn());
    const mixLevel = () => (player as unknown as { mix: FakeGain }).mix.gain.value;
    player.setDocument(edit(), ["T1"]);
    expect(mixLevel()).toBe(1);
    player.setDocument(edit(), ["T1", "T2"]);
    expect(mixLevel()).toBe(1);
  });
});

describe("tracks edited alone", () => {
  const overwritten = (overrides: Extract<EditDocument["segments"][number], { kind: "source" }>["overrides"], mutes: EditDocument["mutes"] = []) => {
    const document = edit(mutes);
    document.segments[0] = { kind: "source", id: "g1", source: "S1", in_frame: 0, out_frame: 48, overrides };
    return document;
  };

  it("cuts a block wherever any of its ranges leaves a window, and an override's pieces take its own source's mutes", () => {
    const document = overwritten({ T1: { source: "S2", in_frame: 230 } }, [{ source: "S2", track: "T1", in_frame: 245, out_frame: 250 }]);
    const [first, second] = planBlocks(document, 120);
    // S2 from 230 crosses its window at 240, ten frames in; S1 does not.
    expect([first, second].map((block) => [block.program, block.end, block.at, block.window, block.overrides])).toEqual([
      [0, 10, 0, 0, [{ source: "S2", at: 230, window: 120, lanes: ["T1"] }]],
      [10, 48, 10, 0, [{ source: "S2", at: 240, window: 240, lanes: ["T1"] }]],
    ]);
    expect(trackPieces(document, second, "T1", second.program, second.overrides![0])).toEqual([
      { from: 240, to: 245, fadeIn: null, fadeOut: "mute" }, { from: 250, to: 278, fadeIn: "mute", fadeOut: "join" }]);
  });

  it("an Overwrite on one track plays its new material there, and the other track keeps the clip", async () => {
    const player = new EditAudio(FPS, vi.fn());
    player.setDocument(overwritten({ T1: { source: "S2", in_frame: 250 } }), ["T1", "T2"]);
    await player.seek(0, 1);
    await vi.waitFor(() => expect(voices("b1")).toHaveLength(1));
    const [ann] = voices("a2");
    expect(startOf(ann)[0]).toBeCloseTo(.015, 6);
    // Frame 250 of S2, ten frames into the window that starts at 240.
    expect(startOf(ann)[1]).toBeCloseTo(10 / FPS, 6);
    expect(startOf(voices("b1")[0])[0]).toBeCloseTo(.015, 6);
    // Ann's own mic is not heard under her Overwrite.
    expect(voices("a1")).toHaveLength(0);
    player.close();
  });

  it("a track lifted alone is silent there and nowhere else", async () => {
    const player = new EditAudio(FPS, vi.fn());
    player.setDocument(overwritten({ T2: { source: null, in_frame: 0 } }), ["T1", "T2"]);
    await player.seek(0, 1);
    await vi.waitFor(() => expect(voices("a2")).toHaveLength(1));
    expect(voices("a1")).toHaveLength(1);
    expect(voices("b1")).toHaveLength(0);
    player.close();
  });
});

describe("solo and mute are record tracks", () => {
  it("a quiet record track silences whoever is on it, where they are on it", async () => {
    // The first clip swaps them: Ann on A2 and Bob on A1. Muting A1 silences Bob there, not Ann.
    const document = edit();
    document.segments[0] = { kind: "source", id: "g1", source: "S1", in_frame: 0, out_frame: 48, layers: { T1: 2, T2: 1 } };
    const player = new EditAudio(FPS, vi.fn());
    player.setDocument(document, ["T1", "T2"], {}, [1]);
    await player.seek(0, 1);
    await vi.waitFor(() => expect(voices("a1")).toHaveLength(1));
    expect(voices("b1")).toHaveLength(0);
    // In the third clip, which names no tracks, Ann is on her own A1: quiet there.
    expect(voices("a2")).toHaveLength(0);
    player.close();
  });
});

describe("edit list playback", () => {
  it("plays each source's mics on one clock, silent through gaps and where a track has no mic", async () => {
    const changed = vi.fn(), player = new EditAudio(FPS, changed);
    player.setDocument(edit(), ["T1", "T2"]);
    await player.seek(0, 1);
    await vi.waitFor(() => expect(voices("a2")).toHaveLength(1));
    const [a1] = voices("a1"), [b1] = voices("b1"), [a2] = voices("a2");
    expect(startOf(a1)[0]).toBeCloseTo(.015, 6); expect(startOf(a1)[1]).toBe(0);
    expect(startOf(b1)[0]).toBeCloseTo(.015, 6);
    // S2 comes after 48 frames of S1 and a 24-frame gap; its window starts at 240.
    expect(startOf(a2)[0]).toBeCloseTo(.015 + 72 / FPS - JOIN_FADE_SECONDS / 2, 6);
    expect(startOf(a2)[1]).toBeCloseTo(10 / FPS - JOIN_FADE_SECONDS / 2, 6);
    // Bob has no mic in S2: nothing read, nothing sounding.
    expect(prepared().filter((args) => args.documentId === "d2").map((args) => args.trackId)).toEqual(["a2"]);
    expect(prepared().find((args) => args.documentId === "d2")).toMatchObject({ startFrame: 240 });
    expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ rate: 1, busy: false, error: null });
    player.close();
  });
  it("splits a muted track's voice around the mute", async () => {
    const player = new EditAudio(FPS, vi.fn());
    player.setDocument(edit([{ source: "S1", track: "T1", in_frame: 12, out_frame: 24 }]), ["T1", "T2"]);
    await player.seek(0, 1);
    const [before, after] = voices("a1");
    expect(voices("a1")).toHaveLength(2); expect(voices("b1")).toHaveLength(1);
    expect(startOf(before)).toEqual([.015, 0, 12 / FPS]);
    expect(startOf(after)[0]).toBeCloseTo(.015 + 1, 6); expect(startOf(after)[1]).toBeCloseTo(1, 6);
    expect(before.gain!.gain.curves.at(-1)).toMatchObject({ when: .015 + .5 - JOIN_FADE_SECONDS, duration: JOIN_FADE_SECONDS });
    expect(after.gain!.gain.curves[0]).toMatchObject({ when: startOf(after)[0], duration: JOIN_FADE_SECONDS });
    player.close();
  });
  it("plays the crossfade View ▸ Audio asks for, never under the 10 ms that stops a click", async () => {
    const player = new EditAudio(FPS, vi.fn());
    player.setJoinFade(4 / FPS);
    player.setDocument(edit(), ["T1"]);
    await player.seek(0, 1);
    context.currentTime = 2; tick();
    await vi.waitFor(() => expect(voices("a1")).toHaveLength(3));
    const out = voices("a2")[0].gain!.gain.curves.at(-1)!, cut = .015 + 132 / FPS;
    expect(out.duration).toBeCloseTo(4 / FPS, 6);
    expect(out.when + out.duration).toBeCloseTo(cut + 2 / FPS, 6);
    // "Off" keeps the de-click.
    const quiet = new EditAudio(FPS, vi.fn());
    quiet.setJoinFade(0);
    expect((quiet as unknown as { joinFade: number }).joinFade).toBe(JOIN_FADE_SECONDS);
  });
  it("crossfades every join with equal-power ramps centred on the cut", async () => {
    const player = new EditAudio(FPS, vi.fn());
    player.setDocument(edit(), ["T1"]);
    await player.seek(0, 1);
    context.currentTime = 2; tick();
    await vi.waitFor(() => expect(voices("a1")).toHaveLength(3));
    const [, a2] = [voices("a1")[0], voices("a2")[0]], incoming = voices("a1")[1];
    const cut = .015 + 132 / FPS, half = JOIN_FADE_SECONDS / 2;
    // Outgoing S2 runs on into its handle and fades out across the cut ...
    const out = a2.gain!.gain.curves.at(-1)!;
    expect(out.when + out.duration).toBeCloseTo(cut + half, 6); expect(out.duration).toBe(JOIN_FADE_SECONDS);
    expect(out.curve[0]).toBeCloseTo(1, 6); expect(out.curve.at(-1)).toBeCloseTo(0, 6);
    // ... while S1 starts half a fade early and rises across it.
    const into = incoming.gain!.gain.curves[0];
    expect(startOf(incoming)[0]).toBeCloseTo(cut - half, 6); expect(startOf(incoming)[1]).toBeCloseTo(100 / FPS - half, 6);
    expect(into.when).toBeCloseTo(cut - half, 6); expect(into.duration).toBe(JOIN_FADE_SECONDS);
    expect(into.curve[0]).toBeCloseTo(0, 6); expect(into.curve.at(-1)).toBeCloseTo(1, 6);
    // Equal power: the two gains' squares sum to one through the fade.
    const middle = into.curve.length >> 1;
    expect(into.curve[middle] ** 2 + out.curve[middle] ** 2).toBeCloseTo(1, 2);
    // The window edge at source frame 120 is contiguous audio: no fade there.
    const next = voices("a1")[2];
    expect(startOf(next)[0]).toBeCloseTo(.015 + 152 / FPS, 6); expect(startOf(next)[1]).toBe(0);
    expect(next.gain!.gain.curves).toHaveLength(0);
    player.close();
  });
  it("starts a mid-segment seek at the matching source offset without a join fade", async () => {
    const changed = vi.fn(), player = new EditAudio(FPS, changed);
    player.setDocument(edit(), ["T1", "T2"]);
    await player.seek(140, 1);
    const [a1] = voices("a1"), [b1] = voices("b1");
    expect(startOf(a1)).toEqual([.015, 108 / FPS, 12 / FPS]);
    expect(startOf(b1)).toEqual([.015, 108 / FPS, 12 / FPS]);
    expect(a1.gain!.gain.curves).toHaveLength(0);
    expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ frame: 140, rate: 1 });
    player.close();
  });
  it("is silent in a source where the audible track has no mic", async () => {
    const player = new EditAudio(FPS, vi.fn());
    player.setDocument(edit(), ["T2"]);
    await player.seek(80, 1);
    // Bob only sounds again once the edit is back in S1, at program frame 132.
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((voice) => voice.buffer?.track === "b1" && startOf(voice)[0] >= .015 + 52 / FPS - JOIN_FADE_SECONDS)).toBe(true);
    expect(prepared().filter((args) => args.documentId === "d2")).toHaveLength(0);
    player.close();
  });
  it("holds the playhead and reports busy rather than running past what is prepared", async () => {
    const pending: Array<() => void> = [];
    invoke.mockImplementation((command, args) => command === "aaf_prepare_audio" && args.documentId === "d2"
      ? new Promise((resolve) => pending.push(() => resolve({ path: `/audio/${args.trackId}.wav` })))
      : Promise.resolve(command === "aaf_prepare_audio" ? { path: `/audio/${args.trackId}.wav` } : undefined));
    const changed = vi.fn(), player = new EditAudio(FPS, changed);
    player.setDocument(edit(), ["T1"]);
    void player.seek(0, 1);
    await vi.waitFor(() => expect(voices("a1")).toHaveLength(1));
    context.currentTime = 4; tick();
    expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ frame: 72, rate: 1, busy: true });
    expect(changed.mock.calls.every(([state]) => state.frame <= 72)).toBe(true);
    pending.splice(0).forEach((finish) => finish());
    await vi.waitFor(() => expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ frame: 72, rate: 1, busy: false }));
    // The clock restarts at the join; the incoming side still gets its half-fade pre-roll.
    expect(startOf(voices("a2")[0])[0]).toBeCloseTo(4.015 - JOIN_FADE_SECONDS / 2, 6);
    player.close();
  });
  // Only close (another document) stops a native read: a paused one finishes
  // into the cache, where Play finds it, instead of being rendered again.
  it.each(["pause", "close"] as const)("%s sounds nothing late, and only close cancels the native reads it started", async (action) => {
    const pending: Array<() => void> = [];
    invoke.mockImplementation((command, args) => command === "aaf_prepare_audio"
      ? new Promise((resolve) => pending.push(() => resolve({ path: `/audio/${args.trackId}.wav` }))) : Promise.resolve(undefined));
    const changed = vi.fn(), player = new EditAudio(FPS, changed);
    player.setDocument(edit(), ["T1", "T2"]);
    void player.seek(0, 1);
    await vi.waitFor(() => expect(prepared()).toHaveLength(2));
    const jobs = prepared().map((args) => args.jobId);
    if (action === "pause") player.pause(); else player.close();
    const cancelled = invoke.mock.calls.filter(([command]) => command === "cancel_job").map(([, args]) => args.jobId);
    if (action === "close") expect(cancelled).toEqual(expect.arrayContaining(jobs)); else expect(cancelled).toEqual([]);
    pending.splice(0).forEach((finish) => finish());
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(sources).toHaveLength(0);
    if (action === "pause") { expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ rate: 0, busy: false }); player.close(); }
  });
  it("re-plans a new edit without dropping the clock", async () => {
    const changed = vi.fn(), player = new EditAudio(FPS, changed);
    player.setDocument(edit(), ["T1", "T2"]);
    await player.seek(0, 1);
    context.currentTime = .515; tick();
    const before = sources.length;
    player.setDocument(edit([{ source: "S1", track: "T2", in_frame: 0, out_frame: 48 }]), ["T1", "T2"]);
    await vi.waitFor(() => expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ frame: 12, rate: 1, busy: false }));
    // Playing carried on from frame 12 with Bob now silenced there.
    expect(changed.mock.calls.every(([state]) => state.rate === 1)).toBe(true);
    await vi.waitFor(() => expect(sources.length - before).toBe(2));
    const replanned = sources.slice(before);
    expect(replanned.map((voice) => voice.buffer?.track)).toEqual(["a1", "a2"]);
    expect(startOf(replanned[0])[1]).toBeCloseTo(.5, 6);
    player.close();
  });
  it("keeps fetching the next window when no animation frame ever fires, as in a hidden window", async () => {
    // Timers only: by default fake timers also fire requestAnimationFrame, which a hidden window never does.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const player = new EditAudio(FPS, vi.fn());
    player.setDocument(edit(), ["T1", "T2"]);
    await player.seek(0, 1);
    // The first fill runs to a window ahead (program 132, the end of S2) and stops there.
    await vi.waitFor(() => expect(voices("a2")).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(10);
    // Ann's return in S1 (program 132) is not scheduled yet.
    expect(voices("a1")).toHaveLength(1);
    // Two seconds on (48 frames), less than a window is scheduled ahead. Nothing calls tick().
    context.currentTime = 2;
    await vi.advanceTimersByTimeAsync(600);
    await vi.waitFor(() => expect(voices("a1")).toHaveLength(3));
    // Pause stops the timer as well as the frame loop.
    player.pause();
    const scheduled = sources.length;
    context.currentTime = 20;
    await vi.advanceTimersByTimeAsync(2000);
    expect(sources).toHaveLength(scheduled);
    player.close();
  });
  it("scrubbing sounds short grains from each audible mic, once decoded", async () => {
    vi.useFakeTimers();
    const player = new EditAudio(FPS, vi.fn());
    player.setDocument(edit([{ source: "S1", track: "T2", in_frame: 20, out_frame: 30 }]), ["T1", "T2"]);
    player.scrub(10);
    expect(sources).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    for (const grain of sources) {
      const [when, offset, length] = startOf(grain);
      expect(when).toBe(0); expect(length).toBeCloseTo(.055, 6); expect(offset).toBeCloseTo(10 / FPS - .0275, 6);
      expect(grain.gain!.gain.curves).toHaveLength(1);
    }
    // Bob is muted at frame 25 of S1, so only Ann's grain sounds there.
    await vi.advanceTimersByTimeAsync(40);
    player.scrub(25);
    await vi.advanceTimersByTimeAsync(40);
    expect(sources.slice(2).map((grain) => grain.buffer?.track)).toEqual(["a1"]);
    // A gap has nothing to scrub.
    await vi.advanceTimersByTimeAsync(40);
    player.scrub(60); await vi.advanceTimersByTimeAsync(200);
    expect(sources).toHaveLength(3);
    player.close();
  });
});
