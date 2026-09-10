import { describe, expect, it, vi } from "vitest";
import { createPresentationPlayback, type PresentationMount } from "./presentation-playback";
import type { PlayerHandle, PlaybackReadiness, SeekResult } from "../components/player-handle";
import type { ResolvedPresentationSource } from "../bindings/ResolvedPresentationSource";

const source: ResolvedPresentationSource = { kind: "split", videoUrl: "https://example.test/video",
  audioUrl: "https://example.test/audio", expiresAt: 123, width: 1920, height: 1080, videoCodec: "avc1", audioCodec: "mp4a" };
const landed = (target: number): SeekResult => ({ requestedSeconds: target, presentedSeconds: target, status: "presented" });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function fixture() {
  let mount: PresentationMount | null = null;
  let lastEpoch = 0;
  const readiness: PlaybackReadiness = { generation: 1, confirmedSeconds: 0, bufferedAheadSeconds: 10,
    durationSeconds: 149, failed: false, seeking: false, hasFutureData: true };
  let highSeek: ReturnType<typeof deferred<SeekResult>> | null = null;
  const make = (high: boolean) => {
    let time = 0, playing = false;
    const handle: PlayerHandle = {
      play: vi.fn(() => { playing = true; }), pause: vi.fn(() => { playing = false; }),
      seekTo: vi.fn(async (target) => {
        time = target;
        if (high && highSeek) return highSeek.promise;
        if (high) readiness.confirmedSeconds = target;
        return landed(target);
      }),
      beginScrub: vi.fn(() => { playing = false; }), scrubTo: vi.fn((target) => { time = target; }),
      endScrub: vi.fn(async (target) => { time = target; return landed(target); }),
      getCurrentTime: () => time, getDuration: () => 149, isReady: () => true, isPlaying: () => playing,
      setVolume: vi.fn(), getVolume: () => 1, setMuted: vi.fn(), isMuted: () => false,
      setShuttle: vi.fn(), setPlaybackRate: vi.fn(), supportsPlaybackRate: high,
      ...(high ? { getPlaybackReadiness: () => ({ ...readiness }) } : {}),
    };
    return handle;
  };
  const proxy = make(false), high = make(true);
  let clock = 1000;
  const ports = { proxy: () => proxy, high: () => high, fps: () => 24, now: () => clock,
    mount: vi.fn((value: PresentationMount | null) => { mount = value; if (value) lastEpoch = value.epoch; }), representation: vi.fn(),
    time: vi.fn(), playing: vi.fn(), diag: vi.fn(), error: vi.fn() };
  const c = createPresentationPlayback(ports);
  c.updateSource(source);
  const ready = async () => { c.ready(mount!.epoch); await flush(); };
  return { c, proxy, high, ports, readiness, ready, epoch: () => lastEpoch,
    deferHigh: () => { highSeek = deferred<SeekResult>(); return highSeek; },
    releaseHigh: () => { highSeek = null; }, mount: () => mount, advanceClock: (ms: number) => { clock += ms; } };
}

describe("playback-first presentation coordinator", () => {
  it("retains a qualified native player when Pause invalidates callback generation", async () => {
    const f = fixture(); await f.ready(); await f.c.play();
    const pause = f.high.pause;
    f.high.pause = vi.fn(() => { pause(); f.readiness.generation++; });
    const seeks = vi.mocked(f.high.seekTo).mock.calls.length;
    f.c.pause(); await flush(); await f.c.play();
    expect(f.c.isProxy()).toBe(false);
    expect(f.high.seekTo).toHaveBeenCalledTimes(seeks);
  });
  it("recovers from fresh-but-desynchronized decoded frames without reversing the clock", async () => {
    const f = fixture(); await f.ready(); await f.c.play();
    await f.high.seekTo(12);
    f.c.reportTime("presentation", 12, f.epoch());
    f.readiness.confirmedSeconds = 11;
    f.readiness.sampledAtMs = 1000;
    f.c.tick(); await flush();
    expect(f.c.isProxy()).toBe(true);
    expect(f.proxy.seekTo).toHaveBeenLastCalledWith(12);
    expect(f.ports.time).toHaveBeenLastCalledWith(12);
    const mounts = f.ports.mount.mock.calls.length;
    f.c.tick(); f.c.proxyReady();
    expect(f.ports.mount).toHaveBeenCalledTimes(mounts);
  });
  it("only the selected engine drives captions/transcript time, and EOF stops playback", async () => {
    const f = fixture();
    f.c.reportTime("presentation", 50, f.epoch());
    expect(f.ports.time).not.toHaveBeenCalled();
    f.c.reportTime("proxy", 0); await f.ready(); await f.c.play();
    f.c.reportTime("proxy", 99);
    expect(f.ports.time).not.toHaveBeenLastCalledWith(99);
    await f.high.seekTo(149); // simulated native clock reaching end-of-media
    f.c.reportTime("presentation", 149, f.epoch());
    f.c.reportPlaying("presentation", false, f.epoch());
    expect(f.ports.time).toHaveBeenLastCalledWith(149);
    expect(f.c.isPlaying()).toBe(false);
  });
  it("does not promote over a local J/K/L shuttle", async () => {
    const f = fixture(), pending = f.deferHigh(); await f.ready();
    f.c.setShuttle(4);
    pending.resolve(landed(0)); await flush();
    expect(f.c.isProxy()).toBe(true); expect(f.c.isPlaying()).toBe(true);
    expect(f.proxy.setShuttle).toHaveBeenCalledWith(4);
    f.c.setShuttle(0); expect(f.c.isPlaying()).toBe(false);
  });

  it("coalesces duplicate fatal signals while local fallback is landing", async () => {
    const f = fixture(); await f.ready(); await f.c.play();
    f.readiness.confirmedSeconds = 42;
    const pending = deferred<SeekResult>(); vi.mocked(f.proxy.seekTo).mockReturnValueOnce(pending.promise);
    f.c.error(f.epoch()); f.c.error(f.epoch());
    expect(f.proxy.seekTo).toHaveBeenCalledTimes(1);
    pending.resolve(landed(42)); await flush();
    expect(f.c.isProxy()).toBe(true); expect(f.c.isPlaying()).toBe(true);
  });
  it("ignores queued native pause events after a newer Play", async () => {
    const f = fixture(); const pending = f.deferHigh(); await f.ready();
    await f.c.play();
    f.c.reportPlaying("proxy", false);
    pending.resolve(landed(0)); await flush();
    expect(f.c.isPlaying()).toBe(true);
    expect(f.c.isProxy()).toBe(true);
  });

  it("Play reuses the local landing still pending after a paused high-quality frame", async () => {
    const f = fixture(); await f.ready();
    f.readiness.confirmedSeconds = 10;
    const local = deferred<SeekResult>();
    vi.mocked(f.proxy.seekTo).mockReturnValueOnce(local.promise);
    f.c.pause();
    f.readiness.bufferedAheadSeconds = 0;
    const play = f.c.play();
    expect(f.proxy.seekTo).toHaveBeenCalledTimes(1);
    expect(f.proxy.play).not.toHaveBeenCalled();
    local.resolve(landed(10)); await play;
    expect(f.proxy.play).toHaveBeenCalledTimes(1);
  });

  it("does not replace the parked picture if alignment of the safety copy fails", async () => {
    const f = fixture(); await f.ready();
    vi.mocked(f.proxy.seekTo).mockResolvedValueOnce({ ...landed(0), status: "unavailable" });
    f.c.pause(); await flush();
    expect(f.c.isProxy()).toBe(false);
    expect(f.c.isPlaying()).toBe(false);
  });
  it("starts locally in the same call while high-quality resolution is pending", () => {
    const f = fixture();
    void f.c.play();
    expect(f.proxy.play).toHaveBeenCalledTimes(1);
    expect(f.high.seekTo).not.toHaveBeenCalled();
  });
  it("does not wait for a delayed high-quality seek or promote without advancing readiness", async () => {
    const f = fixture(), pending = f.deferHigh();
    await f.ready();
    const play = f.c.play();
    expect(f.proxy.play).toHaveBeenCalledTimes(1);
    await play;
    pending.resolve(landed(0)); await flush(); f.c.inspect(f.epoch());
    expect(f.c.isProxy()).toBe(true);
    expect(f.high.play).not.toHaveBeenCalled();
    expect(f.proxy.pause).not.toHaveBeenCalled();
  });
  it("promotes an exact parked frame and starts prepared high quality without another seek", async () => {
    const f = fixture(); await f.ready();
    expect(f.c.isProxy()).toBe(false);
    expect(f.high.play).not.toHaveBeenCalled();
    await f.c.play();
    expect(f.high.play).toHaveBeenCalledTimes(1);
    expect(f.high.seekTo).toHaveBeenCalledTimes(1);
  });
  it("rechecks buffer eviction at Play instead of trusting an earlier ready event", async () => {
    const f = fixture(); await f.ready(); f.readiness.bufferedAheadSeconds = 0;
    await f.c.play();
    expect(f.proxy.play).toHaveBeenCalledTimes(1);
    expect(f.high.play).not.toHaveBeenCalled();
  });
  it("returns local seek completion before high-quality preparation resolves", async () => {
    const f = fixture(); await f.ready(); const pending = f.deferHigh();
    expect(await f.c.seekTo(105.7)).toEqual(landed(105.7));
    await f.c.play(); expect(f.proxy.play).toHaveBeenCalledTimes(1);
    pending.resolve(landed(105.7)); await flush();
    expect(f.c.isProxy()).toBe(true);
  });
  it.each([105.7, 67.8, 1919.0, 2113.9])("coalesces repeated preparation at %ss", async (target) => {
    const f = fixture(); await f.ready(); f.deferHigh();
    f.readiness.durationSeconds = 4610;
    for (let i = 0; i < 6; i++) await f.c.seekTo(target);
    expect(vi.mocked(f.high.seekTo).mock.calls.filter(([at]) => at === target)).toHaveLength(1);
  });
  it("unmounts high quality for a drag and resumes the local copy immediately", async () => {
    const f = fixture(); await f.ready(); await f.c.play();
    f.c.beginScrub();
    expect(f.mount()).toBeNull();
    const before = vi.mocked(f.high.seekTo).mock.calls.length;
    for (const at of [42, 43, 67.8]) f.c.scrubTo(at);
    expect(f.mount()).toBeNull();
    expect(await f.c.endScrub(67.8)).toEqual(landed(67.8));
    expect(f.proxy.play).toHaveBeenCalledTimes(1);
    expect(f.high.seekTo).toHaveBeenCalledTimes(before);
    expect(f.mount()?.target).toBe(67.8); // exactly one preparation after settling
  });
  it("late preparation cannot restart or move playback after Pause or a different seek", async () => {
    const f = fixture(), old = f.deferHigh(); await f.ready();
    await f.c.play(); f.c.pause(); await flush();
    f.releaseHigh(); await f.c.seekTo(43);
    old.resolve(landed(0)); await flush();
    expect(f.c.position()).toBe(43); expect(f.c.isPlaying()).toBe(false);
    expect(f.high.play).not.toHaveBeenCalled();
  });
  it("falls back on genuine starvation once and never oscillates in the same run", async () => {
    const f = fixture(); await f.ready(); await f.c.play();
    f.readiness.confirmedSeconds = 43; f.c.reportTime("presentation", 43, f.epoch());
    f.readiness.bufferedAheadSeconds = 0;
    f.c.waiting(f.epoch()); await flush();
    expect(f.proxy.seekTo).toHaveBeenLastCalledWith(43);
    expect(f.proxy.play).toHaveBeenCalledTimes(1);
    f.c.waiting(f.epoch()); f.readiness.bufferedAheadSeconds = 10; f.c.inspect(f.epoch());
    expect(f.c.isProxy()).toBe(true); expect(f.high.play).toHaveBeenCalledTimes(1);
  });
  it("ignores waiting while paused or seeking", async () => {
    const f = fixture(); await f.ready(); f.c.waiting(f.epoch());
    expect(f.c.isProxy()).toBe(false);
    await f.c.play(); f.readiness.seeking = true; f.c.waiting(f.epoch());
    expect(f.c.isProxy()).toBe(false); expect(f.proxy.play).not.toHaveBeenCalled();
  });
  it("standby failures do not move or stop local playback", async () => {
    const f = fixture(); await f.c.play(); f.c.reportTime("proxy", 68.3);
    f.c.error(f.epoch()); await flush();
    expect(f.ports.time).toHaveBeenLastCalledWith(68.3);
    expect(f.proxy.seekTo).not.toHaveBeenCalled(); expect(f.c.isPlaying()).toBe(true);
  });
  it("holds refreshed URLs until a safe pause and rejects events from the old mount", async () => {
    const f = fixture(); await f.ready(); await f.c.play(); const old = f.epoch();
    f.c.updateSource({ ...source, expiresAt: 456 });
    expect(f.epoch()).toBe(old);
    f.c.pause(); await flush(); expect(f.epoch()).not.toBe(old);
    f.c.reportTime("presentation", 100, old); f.c.error(old);
    expect(f.ports.time).not.toHaveBeenLastCalledWith(100);
    expect(f.ports.error).not.toHaveBeenCalled();
  });
  it("preserves volume/mute on a newly mounted candidate and ignores disposed results", async () => {
    const f = fixture(); f.c.setVolume(0.28); f.c.setMuted(true);
    const pending = f.deferHigh(); await f.ready();
    expect(f.high.setVolume).toHaveBeenLastCalledWith(0.28);
    expect(f.high.setMuted).toHaveBeenLastCalledWith(true);
    f.c.dispose(); pending.resolve(landed(0)); await flush();
    expect(f.ports.representation).not.toHaveBeenCalled();
  });
  it("hands off only after advancing decoded frames match, closing local audio first", async () => {
    const f = fixture(), pending = f.deferHigh(); await f.ready();
    await f.c.play(); f.releaseHigh();
    Object.assign(f.readiness, { bufferedStartSeconds: 0, bufferedEndSeconds: 30 });
    pending.resolve(landed(0)); await flush();
    expect(f.high.seekTo).toHaveBeenLastCalledWith(0.75);
    expect(f.c.isProxy()).toBe(true);
    await f.proxy.seekTo(0.75); f.c.tick();
    expect(f.high.play).toHaveBeenCalledTimes(1);
    expect(f.high.setMuted).toHaveBeenLastCalledWith(true);
    // play() succeeded but no decoded frame evidence: stay local.
    f.c.tick(); expect(f.c.isProxy()).toBe(true);
    Object.assign(f.readiness, { confirmedSeconds: 0.75, sampledAtMs: 1000, advancingFrames: 2 });
    f.c.tick();
    expect(f.c.isProxy()).toBe(false);
    expect(f.c.isPlaying()).toBe(true);
    expect(f.high.setMuted).toHaveBeenLastCalledWith(false);
    const muteOrder = vi.mocked(f.proxy.setMuted).mock.invocationCallOrder.at(-1)!;
    const unmuteOrder = vi.mocked(f.high.setMuted).mock.invocationCallOrder.at(-1)!;
    expect(muteOrder).toBeLessThan(unmuteOrder);
    const seeks = vi.mocked(f.high.seekTo).mock.calls.length;
    f.c.pause(); await flush(); await f.c.play();
    expect(f.c.isProxy()).toBe(false);
    expect(f.high.seekTo).toHaveBeenCalledTimes(seeks);
  });
  it("an abandoned preparation cannot revive when a late seek succeeds", async () => {
    const f = fixture(), pending = f.deferHigh(); await f.ready(); await f.c.play();
    f.advanceClock(21_000); f.c.tick();
    pending.resolve(landed(0)); await flush();
    Object.assign(f.readiness, { bufferedStartSeconds: 0, bufferedEndSeconds: 30, sampledAtMs: 22_000, advancingFrames: 4 });
    for (let i = 0; i < 30; i++) f.c.tick();
    expect(f.high.seekTo).toHaveBeenCalledTimes(1);
    expect(f.high.play).not.toHaveBeenCalled();
    expect(f.c.isProxy()).toBe(true);
  });
  it.each([0.5, 2, 4])("does not rehearse at unsupported or non-forward 1× rate %s", async (rate) => {
    const f = fixture(); f.c.setRate(rate); await f.c.play();
    await f.ready(); f.c.tick();
    expect(f.high.seekTo).not.toHaveBeenCalled();
    expect(f.c.isProxy()).toBe(true);
  });
});
