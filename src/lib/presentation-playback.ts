import type { ResolvedPresentationSource } from "../bindings/ResolvedPresentationSource";
import type { PlayerHandle, SeekResult } from "../components/player-handle";
import { presentationCanPlay, sameSourceFrame } from "./presentation-readiness";

export type PresentationMount = { source: ResolvedPresentationSource; epoch: number; target: number };
type Candidate = { target: number; epoch: number; phase: "waiting" | "seeking" | "buffering" | "ready" | "failed"; generation?: number };
type Ports = {
  proxy: () => PlayerHandle | null;
  high: () => PlayerHandle | null;
  fps: () => number;
  mount: (value: PresentationMount | null) => void;
  representation: (value: "proxy" | "presentation") => void;
  time: (seconds: number) => void;
  playing: (value: boolean) => void;
  diag: (tag: string, message: string) => void;
  error: (message: string) => void;
};

/** The local copy owns transport. A standby stream may prepare, but never
 * holds a transport promise or promotes itself while playback is running. */
export function createPresentationPlayback(p: Ports) {
  let disposed = false;
  let active: "proxy" | "presentation" = "proxy";
  let playing = false;
  let phase: "idle" | "landing" | "scrubbing" = "idle";
  let position = 0;
  let command = 0;
  let epoch = 0;
  let resumeScrub = false;
  let blocked = false;
  let latest: ResolvedPresentationSource | null = null;
  let mounted: PresentationMount | null = null;
  let candidate: Candidate | null = null;
  let localLanding: { target: number; result: Promise<SeekResult> } | null = null;
  let volume = 1;
  let muted = false;
  let rate = 1;
  const sameFrame = (a: number, b: number) => sameSourceFrame(a, b, p.fps());
  const current = () => active === "proxy" ? p.proxy() : p.high();
  const show = (value: typeof active) => {
    if (active === value) return;
    active = value;
    p.representation(value);
  };
  const configure = () => {
    p.high()?.setVolume(volume);
    p.high()?.setMuted(muted);
    p.high()?.setPlaybackRate(rate);
  };
  const targetNow = () => current()?.getPlaybackReadiness?.().confirmedSeconds
    ?? current()?.getCurrentTime() ?? position;
  const qualified = (target: number) => {
    const state = p.high()?.getPlaybackReadiness?.();
    return !!mounted && !!candidate && candidate.epoch === mounted.epoch
      && candidate.phase !== "failed" && candidate.phase !== "seeking"
      && candidate.generation === state?.generation
      && presentationCanPlay(state, target, p.fps());
  };
  const inspect = (eventEpoch: number) => {
    if (disposed || mounted?.epoch !== eventEpoch || !candidate
      || candidate.phase === "waiting" || candidate.phase === "seeking" || candidate.phase === "failed") return;
    if (!qualified(candidate.target)) return;
    if (candidate.phase !== "ready") {
      candidate.phase = "ready";
      p.diag("ok", `High-quality buffer ready at ${candidate.target.toFixed(2)}s`);
    }
    if (playing || blocked || active === "presentation" || phase !== "idle" || !sameFrame(position, candidate.target)) return;
    p.proxy()?.pause();
    show("presentation");
    p.diag("ok", `High-quality picture selected while paused at ${position.toFixed(2)}s`);
  };
  const prepare = () => {
    if (disposed || playing || blocked || phase !== "idle" || !latest || !p.proxy()?.isReady()) return;
    if (!mounted || mounted.source !== latest) {
      mounted = { source: latest, target: position, epoch: ++epoch };
      candidate = { target: position, epoch, phase: "waiting" };
      p.mount(mounted);
      return;
    }
    const high = p.high();
    if (!high?.isReady()) return;
    configure();
    if (!candidate || !sameFrame(candidate.target, position)) {
      high.pause();
      candidate = { target: position, epoch: mounted.epoch, phase: "waiting" };
    }
    const pending = candidate;
    if (pending.phase !== "waiting") {
      const state = high.getPlaybackReadiness?.();
      if (pending.phase !== "seeking" && presentationCanPlay(state, pending.target, p.fps())) pending.generation = state?.generation;
      inspect(pending.epoch); return;
    }
    pending.phase = "seeking";
    p.diag("info", `Preparing high-quality buffer at ${pending.target.toFixed(2)}s (source ${pending.epoch})`);
    void high.seekTo(pending.target).then((result) => {
      if (disposed || candidate !== pending || mounted?.epoch !== pending.epoch) return;
      if (result.status !== "presented") {
        pending.phase = "failed";
        p.diag("warn", "High-quality preparation unavailable; local playback remains ready.");
        return;
      }
      pending.generation = high.getPlaybackReadiness?.().generation;
      pending.phase = "buffering";
      inspect(pending.epoch);
    }).catch(() => {
      if (candidate === pending && !disposed) {
        pending.phase = "failed";
        p.diag("warn", "High-quality preparation failed; local playback remains ready.");
      }
    });
  };
  const failLocal = (id: number) => {
    if (disposed || command !== id) return;
    playing = false;
    phase = "idle";
    p.playing(false);
    p.error("The local review copy could not resume playback.");
  };
  const startLocal = async (target: number, id: number) => {
    const proxy = p.proxy();
    if (!proxy?.isReady()) { failLocal(id); return; }
    // The warm, already-positioned copy starts in the same call as Play.
    if (localLanding || !sameFrame(proxy.getCurrentTime(), target)) {
      phase = "landing";
      const result = await (localLanding && sameFrame(localLanding.target, target)
        ? localLanding.result : proxy.seekTo(target));
      if (disposed || command !== id) return;
      if (result.status !== "presented") { failLocal(id); return; }
      position = result.presentedSeconds;
      p.time(position);
    }
    if (disposed || command !== id) return;
    phase = "idle";
    show("proxy");
    playing = true;
    await proxy.play();
    if (!disposed && command === id) p.playing(true);
  };
  const fallback = (eventEpoch: number, reason: string, fatal = false) => {
    if (disposed || blocked || mounted?.epoch !== eventEpoch) return;
    const state = p.high()?.getPlaybackReadiness?.();
    if (!fatal && (!playing || phase !== "idle" || state?.seeking)) return;
    if (candidate) candidate.phase = "failed";
    if (active !== "presentation") return;
    const at = state?.confirmedSeconds ?? position;
    const resume = playing;
    const id = ++command;
    blocked = true;
    phase = "landing";
    p.high()?.pause();
    p.diag("warn", `Using local playback at ${at.toFixed(2)}s: ${reason}`);
    position = at;
    if (resume) void startLocal(at, id).catch(() => failLocal(id));
    else void p.proxy()?.seekTo(at).then((result) => {
      if (disposed || command !== id) return;
      phase = "idle";
      if (result.status === "presented") { show("proxy"); position = result.presentedSeconds; p.time(position); }
    }).catch(() => failLocal(id));
  };
  const land = async (target: number, scrub: boolean): Promise<SeekResult> => {
    const resume = scrub ? resumeScrub : playing;
    resumeScrub = false;
    const id = ++command;
    phase = "landing";
    // Do not cancel a matching paused preparation: repeated clicks must not
    // repeatedly destroy the very pipeline that is trying to reach them.
    if (!candidate || !sameFrame(candidate.target, target)) {
      candidate = null;
      p.high()?.pause();
    } else if (active === "presentation") p.high()?.pause();
    show("proxy");
    const proxy = p.proxy();
    if (!scrub) proxy?.pause();
    const pending = { target, result: proxy?.isReady()
      ? (scrub ? proxy.endScrub(target) : proxy.seekTo(target))
      : Promise.resolve({ requestedSeconds: target, presentedSeconds: position, status: "unavailable" as const }) };
    localLanding = pending;
    const result = await pending.result;
    if (localLanding === pending) localLanding = null;
    if (disposed || command !== id) return { ...result, status: "superseded" };
    phase = "idle";
    if (result.status === "presented") {
      position = result.presentedSeconds;
      p.time(position);
      playing = resume;
      if (resume) {
        if (!proxy?.isPlaying()) void proxy?.play();
        p.playing(true);
      } else { blocked = false; prepare(); }
    } else {
      playing = false;
      p.playing(false);
    }
    return result;
  };
  return {
    activate() { disposed = false; },
    updateSource(source: ResolvedPresentationSource | null) {
      latest = source;
      // A refreshed URL is only a candidate. Never remount an active stream.
      if (active === "proxy") prepare();
    },
    ready(eventEpoch: number) {
      if (mounted?.epoch !== eventEpoch || disposed) return;
      configure(); prepare();
    },
    proxyReady() { prepare(); },
    inspect,
    error: (eventEpoch: number) => fallback(eventEpoch, "high-quality media failed", true),
    waiting: (eventEpoch: number) => fallback(eventEpoch, "high-quality buffer ran dry"),
    reportTime(engine: typeof active, seconds: number, eventEpoch?: number) {
      if (disposed || engine !== active || phase !== "idle"
        || (engine === "presentation" && mounted?.epoch !== eventEpoch)) return;
      position = seconds;
      p.time(seconds);
    },
    reportPlaying(engine: typeof active, value: boolean, eventEpoch?: number) {
      if (disposed || engine !== active || phase !== "idle"
        || (engine === "presentation" && mounted?.epoch !== eventEpoch)) return;
      // Native play/pause events are queued tasks: an old pause event can
      // arrive after the next Play. Transport intent wins, except at EOF.
      if (value !== playing) {
        const player = current();
        const ended = !value && (player?.getDuration() ?? 0) > 0
          && (player?.getCurrentTime() ?? 0) >= player!.getDuration() - 1 / (p.fps() || 30);
        if (!ended) return;
      }
      playing = value;
      p.playing(value);
    },
    async play() {
      if (disposed || playing) return;
      const at = localLanding?.target ?? targetNow();
      const id = ++command;
      playing = true;
      phase = "idle";
      if (!blocked && qualified(at)) {
        phase = "landing";
        p.proxy()?.pause();
        show("presentation");
        phase = "idle";
        playing = true;
        p.diag("info", "Play: buffered high quality");
        await p.high()?.play();
        if (!disposed && command === id) p.playing(true);
      } else {
        // A paused standby seek can finish filling its bounded buffer, but
        // inspect() cannot promote it during this playback run.
        if (active === "presentation") { phase = "landing"; p.high()?.pause(); }
        p.diag("info", "Play: local review copy (no high-quality wait)");
        await startLocal(at, id).catch(() => failLocal(id));
      }
    },
    pause() {
      if (disposed) return;
      const at = localLanding?.target ?? targetNow();
      const id = ++command;
      playing = false;
      resumeScrub = false;
      blocked = false;
      phase = "landing";
      p.proxy()?.pause(); p.high()?.pause();
      position = at;
      p.playing(false);
      // Align the safety copy before replacing a paused presentation source.
      const pending = localLanding ?? (active === "presentation" && p.proxy()?.isReady()
        ? { target: at, result: p.proxy()!.seekTo(at) } : null);
      localLanding = pending;
      void (pending?.result ?? Promise.resolve(null)).then((result) => {
        if (localLanding === pending) localLanding = null;
        if (disposed || command !== id) return;
        phase = "idle";
        if (result && result.status !== "presented") return; // retain the confirmed high-quality picture
        show("proxy");
        if (candidate?.phase === "failed") { mounted = null; candidate = null; }
        else if (candidate?.phase === "seeking") candidate = null;
        prepare();
      }).catch(() => { if (!disposed && command === id) phase = "idle"; });
    },
    seekTo: (target: number) => land(Math.max(0, target), false),
    beginScrub() {
      if (phase === "scrubbing") return;
      resumeScrub = playing;
      phase = "scrubbing";
      command++;
      p.high()?.pause();
      // No background decoder/remux may keep working through a drag.
      mounted = null; candidate = null; epoch++;
      p.mount(null);
      p.proxy()?.beginScrub();
      show("proxy");
    },
    scrubTo(target: number) { p.proxy()?.scrubTo(Math.max(0, target)); },
    endScrub: (target: number) => land(Math.max(0, target), true),
    current,
    position: () => phase === "idle" ? targetNow() : position,
    isPlaying: () => playing,
    isProxy: () => active === "proxy",
    setShuttle(value: number) {
      if (disposed) return;
      command++;
      playing = value !== 0;
      phase = "idle";
      if (active === "proxy") p.high()?.pause();
      current()?.setShuttle(value);
      position = targetNow();
      p.playing(playing);
    },
    setVolume(value: number) { volume = value; p.proxy()?.setVolume(value); p.high()?.setVolume(value); },
    setMuted(value: boolean) { muted = value; p.proxy()?.setMuted(value); p.high()?.setMuted(value); },
    setRate(value: number) { rate = value; p.proxy()?.setPlaybackRate(value); p.high()?.setPlaybackRate(value); },
    dispose() {
      disposed = true; command++; epoch++;
      candidate = null; mounted = null; localLanding = null;
      p.high()?.pause(); p.proxy()?.pause();
    },
  };
}
