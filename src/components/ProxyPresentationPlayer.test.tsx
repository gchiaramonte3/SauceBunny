// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import { createRef, StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayerHandle, SeekResult } from "./player-handle";

const h = vi.hoisted(() => ({
  proxyScrubs: [] as number[],
  proxyEnds: [] as number[],
  highSeeks: [] as number[],
  fireHighReady: null as null | (() => void),
  deferredResolve: null as null | ((result: SeekResult) => void),
  deferHigh: false,
  highUnavailable: false,
  proxyPlays: 0,
  highPlays: 0,
  highMounts: 0,
  ahead: 10,
}));

function fakeHandle(kind: "proxy" | "high", report: (value: boolean) => void): PlayerHandle {
  let time = 0;
  let playing = false;
  let confirmed: number | null = null;
  return {
    play: () => { playing = true; if (kind === "proxy") h.proxyPlays++; else h.highPlays++; report(true); },
    pause: () => { playing = false; report(false); },
    seekTo: async (seconds) => {
      time = seconds;
      if (kind === "high") {
        h.highSeeks.push(seconds);
        if (h.highUnavailable) return { requestedSeconds: seconds, presentedSeconds: time, status: "unavailable" };
        if (h.deferHigh) {
          return await new Promise<SeekResult>((resolve) => { h.deferredResolve = (result) => {
            confirmed = result.presentedSeconds; resolve(result);
          }; });
        }
      }
      confirmed = seconds;
      return { requestedSeconds: seconds, presentedSeconds: seconds, status: "presented" };
    },
    beginScrub: () => {},
    scrubTo: (seconds) => { time = seconds; if (kind === "proxy") h.proxyScrubs.push(seconds); },
    endScrub: async (seconds) => {
      time = seconds;
      if (kind === "proxy") h.proxyEnds.push(seconds);
      return { requestedSeconds: seconds, presentedSeconds: seconds, status: "presented" };
    },
    getCurrentTime: () => time,
    getDuration: () => 100,
    isReady: () => true,
    isPlaying: () => playing,
    getPlaybackReadiness: () => ({ generation: 1, confirmedSeconds: confirmed,
      bufferedAheadSeconds: h.ahead, durationSeconds: 100, seeking: false, failed: false, hasFutureData: true }),
    setVolume: () => {}, getVolume: () => 1,
    setMuted: () => {}, isMuted: () => false,
    setShuttle: () => {}, setPlaybackRate: () => {}, supportsPlaybackRate: kind === "high",
  };
}

vi.mock("./MediaBunnyPlayer", async () => {
  const React = await import("react");
  return { MediaBunnyPlayer: React.forwardRef<PlayerHandle, { onReady?: (duration: number) => void; onPlayStateChange?: (value: boolean) => void }>((props, ref) => {
    const latest = React.useRef(props); latest.current = props;
    React.useImperativeHandle(ref, () => fakeHandle("proxy", (v) => latest.current.onPlayStateChange?.(v)), []);
    React.useEffect(() => { latest.current.onReady?.(100); }, []);
    return <div data-testid="proxy-engine" />;
  }) };
});

vi.mock("./MSEStreamPlayer", async () => {
  const React = await import("react");
  const High = React.forwardRef<PlayerHandle, { onReady?: (duration: number) => void; onPlayStateChange?: (value: boolean) => void }>((props, ref) => {
    const latest = React.useRef(props); latest.current = props;
    React.useImperativeHandle(ref, () => fakeHandle("high", (v) => latest.current.onPlayStateChange?.(v)), []);
    React.useEffect(() => {
      h.highMounts++;
      h.fireHighReady = () => latest.current.onReady?.(100);
      return () => { h.fireHighReady = null; };
    }, []);
    return <div data-testid="high-engine" />;
  });
  return { MSEStreamPlayer: High };
});
vi.mock("./LocalMediaPlayer", async () => {
  const React = await import("react");
  const High = React.forwardRef<PlayerHandle, { onReady?: (duration: number) => void }>((props, ref) => {
    React.useImperativeHandle(ref, () => fakeHandle("high", () => {}), []);
    React.useEffect(() => {
      h.fireHighReady = () => props.onReady?.(100);
      return () => { h.fireHighReady = null; };
    }, [props]);
    return <div data-testid="high-engine" />;
  });
  return { LocalMediaPlayer: High };
});

import { ProxyPresentationPlayer } from "./ProxyPresentationPlayer";

const presentation = {
  kind: "split" as const,
  videoUrl: "http://127.0.0.1/v1/video",
  audioUrl: "https://cdn.example/audio.m4a",
  expiresAt: 99,
  width: 1920,
  height: 1080,
  videoCodec: "avc1",
  audioCodec: "mp4a",
};

beforeEach(() => {
  h.proxyScrubs.length = 0;
  h.proxyEnds.length = 0;
  h.highSeeks.length = 0;
  h.deferredResolve = null;
  h.deferHigh = false;
  h.highUnavailable = false;
  h.proxyPlays = 0;
  h.highPlays = 0;
  h.highMounts = 0;
  h.ahead = 10;
});

describe("downloaded proxy + presentation boundary", () => {
  it("keeps a failed native handoff playable using the completed review copy", async () => {
    const player = createRef<PlayerHandle>();
    const diag = vi.fn();
    render(<ProxyPresentationPlayer ref={player} proxyPath="/cache/review.mp4" presentation={presentation}
      initialVolume={1} scrubAudio={false} onDiag={diag} />);
    await act(async () => { h.fireHighReady?.(); });
    h.highUnavailable = true;
    await act(async () => { await player.current?.seekTo(68); });
    await act(async () => { await player.current?.play(); });
    expect(h.proxyPlays).toBe(1);
    expect(h.highPlays).toBe(0);
    expect(player.current?.getCurrentTime()).toBe(68);
    expect(diag).toHaveBeenCalledWith("warn", expect.stringContaining("local playback remains ready"));
  });

  it("a delayed handoff cannot restart playback after Pause", async () => {
    const player = createRef<PlayerHandle>();
    render(<ProxyPresentationPlayer ref={player} proxyPath="/cache/review.mp4" presentation={presentation}
      initialVolume={1} scrubAudio={false} />);
    h.deferHigh = true;
    act(() => { h.fireHighReady?.(); });
    let playing!: ReturnType<PlayerHandle["play"]>;
    act(() => { playing = player.current!.play(); });
    await waitFor(() => expect(h.deferredResolve).not.toBeNull());
    act(() => player.current!.pause());
    await act(async () => {
      h.deferredResolve?.({ requestedSeconds: 0, presentedSeconds: 0, status: "presented" });
      await playing;
    });
    expect(h.highPlays).toBe(0);
    expect(h.proxyPlays).toBe(1);
    expect(player.current!.isPlaying()).toBe(false);
  });

  it("never seeks the split presentation during drag and lands it exactly once", async () => {
    const player = createRef<PlayerHandle>();
    render(<ProxyPresentationPlayer ref={player} proxyPath="/cache/review.mp4" presentation={presentation}
      initialVolume={1} scrubAudio={false} />);
    await waitFor(() => expect(h.fireHighReady).not.toBeNull());
    await act(async () => { h.fireHighReady?.(); });
    h.highSeeks.length = 0; // discard the one initial representation handoff

    act(() => {
      player.current?.beginScrub();
      player.current?.scrubTo(10);
      player.current?.scrubTo(11);
      player.current?.scrubTo(12);
    });
    expect(h.proxyScrubs).toEqual([10, 11, 12]);
    expect(h.highSeeks).toEqual([]);

    await act(async () => { await player.current?.endScrub(12); });
    await act(async () => { h.fireHighReady?.(); });
    expect(h.proxyEnds).toEqual([12]);
    expect(h.highSeeks).toEqual([12]);
  });

  it("keeps the proxy frame visible until presentation confirms its decoded frame", async () => {
    const player = createRef<PlayerHandle>();
    const view = render(<ProxyPresentationPlayer ref={player} proxyPath="/cache/review.mp4" presentation={presentation}
      initialVolume={1} scrubAudio={false} />);
    await waitFor(() => expect(h.fireHighReady).not.toBeNull());
    await act(async () => { h.fireHighReady?.(); });

    h.deferHigh = true;
    act(() => {
      player.current?.beginScrub();
      player.current?.scrubTo(42);
    });
    let landing!: Promise<SeekResult>;
    act(() => { landing = player.current!.endScrub(42); });
    await act(async () => { await landing; });
    act(() => { h.fireHighReady?.(); });
    await waitFor(() => expect(h.deferredResolve).not.toBeNull());
    expect((view.container.querySelector(".cp-playback-proxy") as HTMLElement).style.opacity).toBe("1");

    await act(async () => {
      h.deferredResolve?.({ requestedSeconds: 42, presentedSeconds: 42, status: "presented" });
      await landing;
    });
    expect((view.container.querySelector(".cp-playback-proxy") as HTMLElement).style.opacity).toBe("0");
  });

  it("keeps a playing engine mounted across a source refresh", async () => {
    const player = createRef<PlayerHandle>();
    const props = { proxyPath: "/cache/review.mp4", presentation, initialVolume: 1, scrubAudio: false };
    const view = render(<ProxyPresentationPlayer ref={player} {...props} />);
    await act(async () => { h.fireHighReady?.(); });
    await act(async () => { await player.current!.play(); });
    expect(h.highPlays).toBe(1);
    view.rerender(<ProxyPresentationPlayer ref={player} {...props} presentation={{ ...presentation, expiresAt: 200 }} />);
    expect(h.highMounts).toBe(1);
    expect(player.current!.isPlaying()).toBe(true);
  });

  it("survives strict effect replay and reports the active engine's speed capability", async () => {
    const player = createRef<PlayerHandle>();
    render(<StrictMode><ProxyPresentationPlayer ref={player} proxyPath="/cache/review.mp4"
      presentation={presentation} initialVolume={1} scrubAudio={false} /></StrictMode>);
    expect(player.current!.supportsPlaybackRate).toBe(false);
    await act(async () => { h.fireHighReady?.(); });
    expect(player.current!.supportsPlaybackRate).toBe(true);
    h.ahead = 0;
    await act(async () => { await player.current!.play(); });
    expect(player.current!.supportsPlaybackRate).toBe(false);
    expect(h.proxyPlays).toBe(1);
  });
});
