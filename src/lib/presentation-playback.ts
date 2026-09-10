import type { ResolvedPresentationSource } from "../bindings/ResolvedPresentationSource";
import type { PlayerHandle, SeekResult } from "../components/player-handle";
import { presentationCanPlay, presentationCanSwitch, sameSourceFrame } from "./presentation-readiness";

export type PresentationMount = { source: ResolvedPresentationSource; epoch: number; target: number };
type Candidate = { target: number; epoch: number; phase: "waiting" | "seeking" | "buffering" | "ready" | "aligning" | "armed" | "rehearsing" | "failed"; generation?: number; deadline?: number };
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
  now?: () => number;
};

/** Local transport never waits for a standby stream. Only a synchronized,
 * decoded and buffered rehearsal may take ownership during ordinary play. */
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
  let shuttling = false;
  const now = () => p.now?.() ?? performance.now();
  const sameFrame = (a: number, b: number) => sameSourceFrame(a, b, p.fps());
  const current = () => active === "proxy" ? p.proxy() : p.high();
  const show = (value: typeof active) => {
    if (active === value) return;
    // Close the old output BEFORE opening the new one, in the same task.
    current()?.setMuted(true);
    active = value;
    current()?.setMuted(muted);
    p.representation(value);
  };
  const configure = () => {
    p.high()?.setVolume(volume);
    p.high()?.setMuted(active !== "presentation" || muted);
    p.high()?.setPlaybackRate(rate);
  };
  const targetNow = () => current()?.getPlaybackReadiness?.().confirmedSeconds
    ?? current()?.getCurrentTime() ?? position;
  const qualified = (target: number) => {
    const state = p.high()?.getPlaybackReadiness?.();
    return !!mounted && !!candidate && candidate.epoch === mounted.epoch
      && (candidate.phase === "ready" || candidate.phase === "buffering")
      && candidate.generation === state?.generation
      && presentationCanPlay(state, target, p.fps());
  };
  const discardStandby = () => {
    candidate = null; mounted = null; epoch++;
    p.mount(null);
  };
  const abandon = (reason: string) => {
    if (candidate) candidate.phase = "failed";
    blocked = true;
    p.high()?.setMuted(true); p.high()?.pause();
    discardStandby();
    p.diag("warn", `High-quality preparation stopped: ${reason}. Continuing locally.`);
  };
  const rehearse = () => {
    const pending = candidate, high = p.high(), proxy = p.proxy();
    if (!pending || !high || !proxy || !playing || active !== "proxy" || blocked
      || phase !== "idle" || shuttling || rate !== 1) return;
    if (pending.deadline != null && now() > pending.deadline) { abandon("synchronization deadline reached"); return; }
    const at = proxy.getCurrentTime(), state = high.getPlaybackReadiness?.();
    if (!state || state.failed) return;
    if (pending.phase === "rehearsing") {
      if (state.generation === pending.generation && presentationCanSwitch(state, at, p.fps(), now())) {
        // Standby has already decoded/played silently; play() is not on this path.
        proxy.setMuted(true); proxy.pause();
        position = Math.max(at, state.confirmedSeconds ?? at);
        pending.phase = "ready";
        pending.target = position;
        show("presentation");
        p.time(position);
        p.diag("ok", `High resolution active at ${position.toFixed(2)}s (source ${pending.epoch})`);
      }
      return;
    }
    if (pending.phase === "armed") {
      if (at >= pending.target) {
        pending.phase = "rehearsing";
        high.setMuted(true);
        void Promise.resolve(high.play()).catch(() => { if (candidate === pending) abandon("standby playback failed"); });
      }
      return;
    }
    if (pending.phase !== "buffering" && pending.phase !== "ready") return;
    // One buffered alignment, never a network rebuild chasing each clock tick.
    const target = Math.ceil((at + 0.75) * (p.fps() || 30)) / (p.fps() || 30);
    const remaining = state.durationSeconds - target;
    if (remaining <= 0 || state.bufferedStartSeconds == null || state.bufferedEndSeconds == null
      || target < state.bufferedStartSeconds || state.bufferedEndSeconds - target < Math.min(5, remaining)) return;
    pending.phase = "aligning";
    pending.target = target;
    pending.deadline ??= now() + 20_000;
    high.setMuted(true); high.pause();
    void high.seekTo(target).then((result) => {
      if (disposed || candidate !== pending || pending.phase !== "aligning" || blocked || !playing || phase !== "idle") return;
      if (result.status !== "presented") { abandon("buffered alignment unavailable"); return; }
      pending.generation = high.getPlaybackReadiness?.().generation;
      pending.phase = "armed";
      rehearse();
    }).catch(() => { if (candidate === pending && !disposed) abandon("buffered alignment failed"); });
  };
  const inspect = (eventEpoch: number) => {
    if (disposed || mounted?.epoch !== eventEpoch || !candidate
      || candidate.phase === "waiting" || candidate.phase === "seeking" || candidate.phase === "failed") return;
    if (playing) { rehearse(); return; }
    if (!qualified(candidate.target)) return;
    if (candidate.phase !== "ready") {
      candidate.phase = "ready";
      p.diag("ok", `Buffer ready at ${candidate.target.toFixed(2)}s`);
    }
    if (playing || blocked || active === "presentation" || phase !== "idle" || !sameFrame(position, candidate.target)) return;
    p.proxy()?.pause();
    show("presentation");
    p.diag("ok", `High-quality picture selected while paused at ${position.toFixed(2)}s`);
  };
  const prepare = () => {
    if (disposed || blocked || phase !== "idle" || !latest || !p.proxy()?.isReady()
      || active !== "proxy" || shuttling || (playing && rate !== 1)) return;
    if (!mounted || mounted.source !== latest) {
      mounted = { source: latest, target: position, epoch: ++epoch };
      candidate = { target: position, epoch, phase: "waiting", deadline: playing ? now() + 20_000 : undefined };
      p.mount(mounted);
      return;
    }
    const high = p.high();
    if (!high?.isReady()) return;
    configure();
    if (!candidate || (!playing && !sameFrame(candidate.target, position))) {
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
      if (disposed || candidate !== pending || pending.phase !== "seeking" || blocked || mounted?.epoch !== pending.epoch) return;
      if (result.status !== "presented") {
        pending.phase = "failed";
        if (playing) blocked = true;
        p.diag("warn", "High-quality preparation unavailable; local playback remains ready.");
        return;
      }
      pending.generation = high.getPlaybackReadiness?.().generation;
      pending.phase = "buffering";
      inspect(pending.epoch);
    }).catch(() => {
      if (candidate === pending && !disposed) {
        pending.phase = "failed";
        if (playing) blocked = true;
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
    if (blocked) discardStandby();
    playing = true;
    proxy.setMuted(muted);
    await proxy.play();
    if (!disposed && command === id) { p.playing(true); prepare(); }
  };
  const fallback = (eventEpoch: number, reason: string, fatal = false) => {
    if (disposed || blocked || mounted?.epoch !== eventEpoch) return;
    const state = p.high()?.getPlaybackReadiness?.();
    if (!fatal && (!playing || phase !== "idle" || state?.seeking)) return;
    if (candidate) candidate.phase = "failed";
    if (active !== "presentation") { abandon(reason); return; }
    const at = Math.max(position, state?.confirmedSeconds ?? position);
    const resume = playing;
    const id = ++command;
    blocked = true;
    phase = "landing";
    p.high()?.pause();
    p.high()?.setMuted(true);
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
      blocked = false;
      if (resume) {
        if (!proxy?.isPlaying()) void proxy?.play();
        p.playing(true);
        prepare();
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
    tick() {
      if (disposed) return;
      if (active === "proxy") rehearse();
      else if (playing && phase === "idle" && !shuttling) {
        const state = p.high()?.getPlaybackReadiness?.();
        if (state?.sampledAtMs != null && now() - state.sampledAtMs > 750) fallback(mounted!.epoch, "high-quality picture stopped advancing", true);
        else if (state?.confirmedSeconds != null
          && Math.abs((p.high()?.getCurrentTime() ?? state.confirmedSeconds) - state.confirmedSeconds) > Math.max(.25, 3 / (p.fps() || 30))) {
          fallback(mounted!.epoch, "high-quality picture lost synchronization", true);
        }
      }
    },
    error: (eventEpoch: number, reason = "high-quality media failed") => fallback(eventEpoch, reason, true),
    waiting: (eventEpoch: number) => fallback(eventEpoch, "high-quality buffer ran dry"),
    reportTime(engine: typeof active, seconds: number, eventEpoch?: number) {
      if (disposed || engine !== active || phase !== "idle"
        || (engine === "presentation" && mounted?.epoch !== eventEpoch)) return;
      position = playing ? Math.max(position, seconds) : seconds;
      p.time(position);
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
      shuttling = false;
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
        if (candidate) candidate.deadline = now() + 20_000;
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
      shuttling = false;
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
        // Keep a qualified, already-active engine and its warm decoder on resume.
        if (active === "presentation" && mounted?.source === latest && candidate?.phase === "ready") {
          candidate.target = at;
          // Native HLS/progressive adapters invalidate pending seek callbacks
          // on Pause. The decoded parked frame is still valid; re-observe it
          // under the adapter's current generation before checking the buffer.
          candidate.generation = p.high()?.getPlaybackReadiness?.().generation;
          if (qualified(at)) return;
        }
        show("proxy");
        if (candidate?.phase === "failed") { mounted = null; candidate = null; }
        else if (candidate && ["seeking", "aligning", "armed", "rehearsing"].includes(candidate.phase)) candidate = null;
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
    acceptsEpoch: (value: number) => !disposed && mounted?.epoch === value,
    position: () => phase === "idle" ? targetNow() : position,
    isPlaying: () => playing,
    isProxy: () => active === "proxy",
    setShuttle(value: number) {
      if (disposed) return;
      command++;
      playing = value !== 0;
      shuttling = value !== 0;
      phase = "idle";
      if (active === "proxy") p.high()?.pause();
      current()?.setShuttle(value);
      position = targetNow();
      p.playing(playing);
    },
    setVolume(value: number) { volume = value; p.proxy()?.setVolume(value); p.high()?.setVolume(value); },
    setMuted(value: boolean) { muted = value; p.proxy()?.setMuted(active !== "proxy" || value); p.high()?.setMuted(active !== "presentation" || value); },
    isMuted: () => muted,
    setRate(value: number) { rate = value; p.proxy()?.setPlaybackRate(value); p.high()?.setPlaybackRate(value); },
    dispose() {
      disposed = true; command++; epoch++;
      candidate = null; mounted = null; localLanding = null;
      p.high()?.pause(); p.proxy()?.pause();
    },
  };
}
