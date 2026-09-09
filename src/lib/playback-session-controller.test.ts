import { describe, expect, it, vi } from "vitest";
import { createPlaybackSessionController, type PlaybackCommand } from "./playback-session-controller";
import type { PlayerHandle, SeekResult } from "../components/player-handle";

const result = (seconds: number): SeekResult => ({
  requestedSeconds: seconds,
  presentedSeconds: seconds,
  status: "presented",
});

function player(overrides: Partial<PlayerHandle> = {}): PlayerHandle {
  return {
    play: vi.fn(), pause: vi.fn(), seekTo: vi.fn(async (s) => result(s)),
    beginScrub: vi.fn(), scrubTo: vi.fn(), endScrub: vi.fn(async (s) => result(s)),
    getCurrentTime: () => 0, getDuration: () => 100, isReady: () => true,
    isPlaying: () => false, setVolume: vi.fn(), getVolume: () => 1,
    setMuted: vi.fn(), isMuted: () => false, setShuttle: vi.fn(),
    setPlaybackRate: vi.fn(), supportsPlaybackRate: true,
    ...overrides,
  };
}

describe("PlaybackSessionController", () => {
  it("pauses an asynchronous file play that completes after live input takes over", async () => {
    let finish!: () => void;
    const p = player({ play: () => new Promise<void>(resolve => { finish = resolve; }) });
    const c = createPlaybackSessionController(() => p); c.setSource("file", 100);
    const playing = c.play(); c.setExternalProgram(true);
    vi.mocked(p.pause).mockClear(); finish(); await playing;
    expect(p.pause).toHaveBeenCalledOnce();
    expect(c.getSnapshot().playing).toBe(false);
  });
  it("suspends hidden file transport while Premiere owns the live picture", async () => {
    const p=player();const c=createPlaybackSessionController(()=>p);c.setSource("file",100);
    const commands=vi.fn();c.subscribeCommands(commands);
    c.setExternalProgram(true);
    await c.play();c.beginScrub();c.scrubTo(30);
    expect((await c.endScrub(30)).status).toBe("unavailable");
    expect((await c.seekTo(20)).status).toBe("unavailable");
    expect(p.play).not.toHaveBeenCalled();expect(p.seekTo).not.toHaveBeenCalled();expect(p.scrubTo).not.toHaveBeenCalled();
    expect(commands).not.toHaveBeenCalled();
    c.setExternalProgram(false);await c.seekTo(20);
    expect(p.seekTo).toHaveBeenCalledWith(20);
  });
  it("emits each transport action immediately with an immutable target", async () => {
    const p = player();
    const c = createPlaybackSessionController(() => p);
    c.setSource("source", 100);
    const commands: PlaybackCommand[] = [];
    c.subscribeCommands((event) => commands.push(event));
    const seeking = c.seekTo(25);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ phase: "seek", target: 25 });
    c.reportPresented(24.9);
    c.reportPlaying(false);
    expect(commands).toHaveLength(1);
    expect(commands[0].target).toBe(25);
    expect(Object.isFrozen(commands[0])).toBe(true);
    await seeking;
    await c.seekTo(30, { phase: "frame-step" });
    expect(commands.at(-1)?.phase).toBe("frame-step");
  });

  it("does not publish remote corrections or intermediate drag updates as commands", async () => {
    const c = createPlaybackSessionController(() => player());
    c.setSource("source", 100);
    const listener = vi.fn();
    c.subscribeCommands(listener);
    await c.seekTo(5, { origin: "remote" });
    await c.play({ origin: "remote" });
    c.pause({ origin: "remote" });
    c.beginScrub();
    c.scrubTo(10); c.scrubTo(20);
    expect(listener).not.toHaveBeenCalled();
    await c.endScrub(20);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0]).toMatchObject({ phase: "scrub-release", target: 20 });
  });

  it("does not let an old asynchronous play activate a new source", async () => {
    let finish!: () => void;
    const c = createPlaybackSessionController(() => player({ play: () => new Promise<void>((resolve) => { finish = resolve; }) }));
    c.setSource("old", 100);
    const playing = c.play();
    c.setSource("new", 200);
    finish();
    await playing;
    expect(c.getSnapshot()).toMatchObject({ sourceId: "new", playing: false, phase: "loading" });
  });

  it("settles failed seeks and preserves a landing during native play events", async () => {
    const c = createPlaybackSessionController(() => player({ seekTo: async () => { throw Error("decoder failed"); } }));
    c.setSource("source", 100);
    const seek = c.seekTo(20);
    c.reportPlaying(true);
    expect(c.getSnapshot().phase).toBe("landing");
    await expect(seek).resolves.toMatchObject({ status: "unavailable" });
    expect(c.getSnapshot().phase).toBe("error");
  });
  it("keeps requested and presented time distinct until a seek confirms", async () => {
    let finish!: (value: SeekResult) => void;
    const p = player({ seekTo: vi.fn((): Promise<SeekResult> => new Promise((resolve) => { finish = resolve; })) });
    const c = createPlaybackSessionController(() => p);
    c.setSource("source", 100);
    c.reportPresented(4);
    const pending = c.seekTo(50);
    expect(c.getSnapshot()).toMatchObject({ phase: "landing", requestedSeconds: 50, presentedSeconds: 4 });
    finish(result(50));
    await pending;
    expect(c.getSnapshot()).toMatchObject({ phase: "ready", requestedSeconds: 50, presentedSeconds: 50 });
  });

  it("routes drag updates only through scrubTo and performs one landing", async () => {
    const p = player();
    const c = createPlaybackSessionController(() => p);
    c.setSource("source", 100);
    c.beginScrub();
    c.scrubTo(10); c.scrubTo(20); c.scrubTo(30);
    expect(p.seekTo).not.toHaveBeenCalled();
    expect(p.scrubTo).toHaveBeenCalledTimes(3);
    await c.endScrub(30);
    expect(p.endScrub).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot()).toMatchObject({ phase: "ready", presentedSeconds: 30, representation: "proxy" });
  });

  it("does not let a superseded completion paint stale state", async () => {
    const resolvers: Array<(value: SeekResult) => void> = [];
    const p = player({ seekTo: vi.fn((): Promise<SeekResult> => new Promise((resolve) => resolvers.push(resolve))) });
    const c = createPlaybackSessionController(() => p);
    c.setSource("source", 100);
    const first = c.seekTo(10);
    const second = c.seekTo(20);
    resolvers[0](result(10));
    await expect(first).resolves.toMatchObject({ status: "superseded" });
    resolvers[1](result(20));
    await second;
    expect(c.getSnapshot().presentedSeconds).toBe(20);
  });

  it("tracks the representation without treating a landing pause as completion", () => {
    const c = createPlaybackSessionController(() => player());
    c.setSource("source", 100);
    void c.seekTo(20);
    c.reportPlaying(false);
    c.reportRepresentation("presentation");
    expect(c.getSnapshot()).toMatchObject({ phase: "landing", representation: "presentation" });
  });
});
