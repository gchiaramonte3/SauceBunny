// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  constructor() { context = this; }
  createGain(): FakeGain {
    const curves: Curve[] = [];
    return { gain: { value: 1, curves, setValueCurveAtTime: (curve, when, duration) => { curves.push({ curve, when, duration }); } }, connect: vi.fn(), disconnect: vi.fn() };
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
