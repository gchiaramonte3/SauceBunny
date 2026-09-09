import type { PlayerHandle, SeekResult } from "../components/player-handle";

export type PlaybackSnapshot = {
  sourceId: string | null;
  phase: "loading" | "ready" | "playing" | "scrubbing" | "landing" | "error";
  requestedSeconds: number;
  presentedSeconds: number;
  durationSeconds: number;
  playing: boolean;
  playbackRate: number;
  representation: "proxy" | "presentation";
};

export type TransportOptions = { origin?: "local" | "remote"; phase?: "seek" | "frame-step" };
export type PlaybackCommand = {
  sequence: number; sourceId: string | null;
  phase: "play" | "pause" | "seek" | "frame-step" | "scrub-release" | "rate";
  target: number; playing: boolean; rate: number;
};

export interface PlaybackSessionController {
  play(options?: TransportOptions): Promise<void>;
  pause(options?: TransportOptions): void;
  seekTo(seconds: number, options?: TransportOptions): Promise<SeekResult>;
  setPlaybackRate(rate: number, options?: TransportOptions): void;
  subscribeCommands(listener: (command: PlaybackCommand) => void): () => void;
  beginScrub(): void;
  scrubTo(seconds: number): void;
  endScrub(seconds: number): Promise<SeekResult>;
  subscribe(listener: () => void): () => void;
  getSnapshot(): PlaybackSnapshot;
}

export type PlaybackSessionReporter = {
  setExternalProgram(active: boolean): void;
  setSource(sourceId: string | null, durationSeconds?: number, representation?: PlaybackSnapshot["representation"]): void;
  setDuration(durationSeconds: number): void;
  reportRepresentation(representation: PlaybackSnapshot["representation"]): void;
  reportPresented(seconds: number): void;
  reportPlaying(playing: boolean): void;
  reportPlaybackRate(rate: number): void;
  reportError(): void;
};

const EMPTY: PlaybackSnapshot = {
  sourceId: null,
  phase: "loading",
  requestedSeconds: 0,
  presentedSeconds: 0,
  durationSeconds: 0,
  playing: false,
  playbackRate: 1,
  representation: "proxy",
};

/**
 * One transport boundary for Clip, Review, comments, transcript cues and room
 * sync. Engines report decoded media through the reporter side; callers never
 * promote a requested seek to presented state themselves.
 */
export function createPlaybackSessionController(
  getPlayer: () => PlayerHandle | null,
): PlaybackSessionController & PlaybackSessionReporter {
  let snapshot = EMPTY;
  let command = 0;
  let resumeAfterScrub = false;
  let externalProgram = false;
  const listeners = new Set<() => void>();
  const commandListeners = new Set<(command: PlaybackCommand) => void>();
  let sequence = 0;
  const issue = (phase: PlaybackCommand["phase"], target: number, playing: boolean, options?: TransportOptions) => {
    if (options?.origin === "remote") return;
    const event: PlaybackCommand = Object.freeze({ sequence: ++sequence, sourceId: snapshot.sourceId,
      phase, target, playing, rate: snapshot.playbackRate });
    commandListeners.forEach((listener) => listener(event));
  };
  const targetSeconds = (seconds: number) => Math.max(0, Number.isFinite(seconds) ? seconds : 0);

  const publish = (patch: Partial<PlaybackSnapshot>) => {
    const next = { ...snapshot, ...patch };
    if (Object.keys(patch).every((key) =>
      snapshot[key as keyof PlaybackSnapshot] === next[key as keyof PlaybackSnapshot])) return;
    snapshot = next;
    listeners.forEach((listener) => listener());
  };

  const unavailable = (seconds: number): SeekResult => ({
    requestedSeconds: seconds,
    presentedSeconds: snapshot.presentedSeconds,
    status: "unavailable",
  });

  const applyResult = (id: number, result: SeekResult) => {
    if (id !== command) return { ...result, status: "superseded" as const };
    if (result.status === "presented") {
      publish({
        presentedSeconds: result.presentedSeconds,
        requestedSeconds: result.requestedSeconds,
        phase: snapshot.playing ? "playing" : "ready",
      });
    } else if (result.status === "unavailable") publish({ phase: "error" });
    return result;
  };

  return {
    async play(options) {
      if (externalProgram) return;
      const player = getPlayer();
      if (!player?.isReady()) return;
      const id = ++command;
      issue("play", snapshot.presentedSeconds, true, options);
      try {
        await player.play();
        if (externalProgram) { player.pause(); return; }
        if (id === command) publish({ playing: true, phase: "playing" });
      } catch {
        if (id === command) {
          publish({ playing: false, phase: "error" });
          issue("pause", snapshot.presentedSeconds, false, options);
        }
      }
    },
    pause(options) {
      if (externalProgram) return;
      command++;
      publish({ playing: false, phase: snapshot.sourceId ? "ready" : "loading" });
      getPlayer()?.pause();
      issue("pause", snapshot.presentedSeconds, false, options);
    },
    async seekTo(seconds, options) {
      if (externalProgram) return unavailable(targetSeconds(seconds));
      const target = targetSeconds(seconds);
      const id = ++command;
      publish({ requestedSeconds: target, phase: "landing" });
      if (options?.phase === "frame-step") {
        publish({ playing: false });
        getPlayer()?.pause();
      }
      issue(options?.phase ?? "seek", target, snapshot.playing, options);
      const player = getPlayer();
      if (!player?.isReady()) return applyResult(id, unavailable(target));
      try { return applyResult(id, await player.seekTo(target)); }
      catch { return applyResult(id, unavailable(target)); }
    },
    setPlaybackRate(rate, options) {
      if (externalProgram) return;
      const next = Number.isFinite(rate) && rate > 0 ? rate : 1;
      const changed = snapshot.playbackRate !== next;
      getPlayer()?.setPlaybackRate(next);
      publish({ playbackRate: next });
      if (changed) issue("rate", snapshot.presentedSeconds, snapshot.playing, options);
    },
    subscribeCommands(listener) {
      commandListeners.add(listener);
      return () => { commandListeners.delete(listener); };
    },
    beginScrub() {
      if (externalProgram) return;
      if (snapshot.phase === "scrubbing") return;
      const player = getPlayer();
      resumeAfterScrub = snapshot.playing || !!player?.isPlaying();
      command++;
      publish({ phase: "scrubbing", representation: "proxy" });
      player?.beginScrub();
    },
    scrubTo(seconds) {
      if (externalProgram) return;
      const target = targetSeconds(seconds);
      getPlayer()?.scrubTo(target);
      publish({ requestedSeconds: target, phase: "scrubbing", representation: "proxy" });
    },
    async endScrub(seconds) {
      if (externalProgram) return unavailable(targetSeconds(seconds));
      const target = targetSeconds(seconds);
      const id = ++command;
      publish({ requestedSeconds: target, phase: "landing", representation: "proxy" });
      issue("scrub-release", target, resumeAfterScrub);
      const player = getPlayer();
      let result: SeekResult;
      try { result = player?.isReady() ? await player.endScrub(target) : unavailable(target); }
      catch { result = unavailable(target); }
      if (id !== command) return { ...result, status: "superseded" as const };
      publish({ playing: result.status === "presented" && resumeAfterScrub });
      resumeAfterScrub = false;
      return applyResult(id, result);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    setExternalProgram(active) {
      if (externalProgram === active) return;
      externalProgram = active;
      command++; resumeAfterScrub = false;
      if (active) {
        getPlayer()?.setShuttle?.(0);
        getPlayer()?.pause();
        publish({ playing: false, phase: snapshot.sourceId ? "ready" : "loading" });
      }
    },
    setSource(sourceId, durationSeconds = 0, representation = "proxy") {
      if (snapshot.sourceId === sourceId) {
        publish({
          durationSeconds: Math.max(snapshot.durationSeconds, durationSeconds),
          representation,
        });
        return;
      }
      command++;
      resumeAfterScrub = false;
      snapshot = {
        ...EMPTY,
        playbackRate: snapshot.playbackRate,
        sourceId,
        durationSeconds: Math.max(0, durationSeconds),
        representation,
        phase: "loading",
      };
      listeners.forEach((listener) => listener());
    },
    setDuration(durationSeconds) {
      const phase = snapshot.phase === "scrubbing" || snapshot.phase === "landing"
        ? snapshot.phase
        : "ready";
      publish({ durationSeconds: Math.max(0, durationSeconds), phase });
    },
    reportRepresentation(representation) {
      publish({ representation });
    },
    reportPresented(seconds) {
      // While scrubbing/landing, the requested coordinate remains visible.
      // Decoded-frame reports still update the confirmed media clock.
      publish({ presentedSeconds: Math.max(0, seconds) });
    },
    reportPlaying(playing) {
      if (externalProgram) { if (playing) getPlayer()?.pause(); return; }
      const stopped = snapshot.playing && !playing
        && snapshot.phase !== "scrubbing" && snapshot.phase !== "landing";
      const phase = (snapshot.phase === "scrubbing" || snapshot.phase === "landing")
        ? snapshot.phase : playing ? "playing" : (snapshot.sourceId ? "ready" : "loading");
      publish({ playing, phase });
      // End-of-media is an observable transport action too. Explicit pause
      // already clears playing before invoking the engine, so it cannot echo.
      if (stopped) issue("pause", snapshot.presentedSeconds, false);
    },
    reportPlaybackRate(rate) {
      publish({ playbackRate: Math.max(0.01, rate) });
    },
    reportError() {
      publish({ phase: "error", playing: false });
    },
  };
}
