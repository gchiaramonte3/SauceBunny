/**
 * Screen-share state machine (pure - the pipeline is injected at the
 * invoke/DOM seams so vitest drives it). One rule holds everything: the
 * stop button, session end, and the ffmpeg child dying ALL converge on the
 * same cleanup exactly once - share track retracted (camera restored via
 * the mesh override), peers un-flagged, pipeline stopped.
 */

export type ShareState = "idle" | "starting" | "sharing";
export type ShareOpenOptions = { audio: boolean; signal: AbortSignal };

import type { ShareSourceArg } from "../bindings/ShareSourceArg";

export type ShareDeps = {
  /** invoke start_screen_share -> the token-gated proxy URL. */
  start: (source: ShareSourceArg) => Promise<string>;
  /** invoke stop_screen_share (kills the capture pipeline). */
  stopPipeline: () => Promise<void>;
  /** Play the proxy stream hidden and captureStream() it (share-stream.ts).
   *  `onDied` fires when the pipeline ends underneath us (ffmpeg death). */
  open: (url: string, onDied: () => void, options: ShareOpenOptions) => Promise<{ stream: MediaStream; track: MediaStreamTrack; audioTrack: MediaStreamTrack | null; close: () => void }>;
  /** Mesh video override: the share track out, null restores the camera. */
  setOverride: (track: MediaStreamTrack | null) => void;
  /** Mesh audio override: system audio mixed with the mic, null = mic only. */
  setAudioOverride: (track: MediaStreamTrack | null) => void;
  /** Build the share+mic mix (share-stream.ts's mixShareAudio at the seam). */
  mixAudio: (share: MediaStreamTrack) => { track: MediaStreamTrack; close: () => void };
  /** Relay SessionMsg::Sharing so remote tiles badge. */
  announce: (on: boolean) => void;
  onChange: (state: ShareState, stream: MediaStream | null) => void;
  log: (tag: "info" | "warn" | "err", msg: string) => void;
  /** Start failed (after the picker) - the room surfaces it to the USER.
   *  Without this the failure dead-ends in the console and the share button
   *  just silently re-enables. Optional so tests stay minimal. */
  onStartError?: (err: unknown) => void;
};

type ShareAttempt = {
  generation: number;
  abort: AbortController;
  opened: Awaited<ReturnType<ShareDeps["open"]>> | null;
  mix: ReturnType<ShareDeps["mixAudio"]> | null;
  began: boolean;
  pending: boolean;
  settled: Promise<void>;
  finish: () => void;
  cleanup: Promise<void> | null;
};

export class ShareController {
  private deps: ShareDeps;
  private state: ShareState = "idle";
  private generation = 0;
  private attempt: ShareAttempt | null = null;
  // stopPipeline addresses a global native pipeline, not an attempt ID. A
  // replacement must wait until old open/stop calls can no longer affect it.
  private retiring: Promise<void> = Promise.resolve();

  constructor(deps: ShareDeps) {
    this.deps = deps;
  }

  current(): ShareState {
    return this.state;
  }

  async start(source: ShareSourceArg): Promise<void> {
    if (this.state !== "idle") return;
    const predecessor = this.retiring;
    let finish = () => {};
    const settled = new Promise<void>((resolve) => { finish = resolve; });
    const attempt: ShareAttempt = { generation: ++this.generation, abort: new AbortController(), opened: null, mix: null,
      began: false, pending: true, settled, finish, cleanup: null };
    this.attempt = attempt;
    this.set("starting", null);
    let failure: { error: unknown } | null = null;
    try {
      await predecessor;
      if (this.attempt !== attempt) return;
      attempt.began = true;
      const url = await this.deps.start(source);
      if (this.attempt !== attempt) return;
      const opened = await this.deps.open(url, () => this.onPipelineDied(attempt), { audio: source.audio, signal: attempt.abort.signal });
      attempt.opened = opened;
      if (this.attempt !== attempt) { this.closeOwned(attempt); return; }
      this.deps.setOverride(opened.track);
      if (opened.audioTrack) {
        // System audio rode the fMP4: mix it with the mic into the one
        // outgoing audio track (no renegotiation).
        attempt.mix = this.deps.mixAudio(opened.audioTrack);
        this.deps.setAudioOverride(attempt.mix.track);
      }
      this.deps.announce(true);
      this.set("sharing", opened.stream);
      this.deps.log("info", `screen share started (${source.kind} ${source.id}${source.audio ? " + audio" : ""})`);
    } catch (err) {
      if (this.attempt === attempt) {
        this.deps.log("err", `screen share failed to start: ${err instanceof Error ? err.message : String(err)}`);
        failure = { error: err };
      }
    } finally {
      attempt.pending = false;
      attempt.finish();
    }
    if (failure) {
      await this.cleanup(attempt);
      if (this.generation === attempt.generation) this.deps.onStartError?.(failure.error);
    }
  }

  /** Bar button / session end. */
  async stop(): Promise<void> {
    ++this.generation;
    await (this.attempt ? this.cleanup(this.attempt) : this.retiring);
  }

  /** The ffmpeg child died underneath us - same cleanup, loud log. */
  private onPipelineDied(attempt: ShareAttempt): void {
    if (this.attempt !== attempt) return;
    this.deps.log("err", "screen share pipeline died; restoring camera");
    void this.cleanup(attempt);
  }

  private closeOwned(attempt: ShareAttempt): void {
    const { opened, mix } = attempt;
    attempt.opened = null;
    attempt.mix = null;
    try { opened?.close(); } catch { /* already closed */ }
    try { mix?.close(); } catch { /* already closed */ }
  }

  private cleanup(attempt: ShareAttempt): Promise<void> {
    if (attempt.cleanup) return attempt.cleanup;
    const predecessor = this.retiring;
    let finish = () => {};
    attempt.cleanup = new Promise<void>((resolve) => { finish = resolve; });
    this.retiring = attempt.cleanup;
    this.attempt = null; // Invalidate before close can fire onDied again.
    attempt.abort.abort(); // Own fetch/decode even before open returns a handle.
    this.set("idle", null);
    this.closeOwned(attempt);
    this.deps.setOverride(null);
    this.deps.setAudioOverride(null);
    this.deps.announce(false);
    const pending = attempt.pending && attempt.began;
    void (async () => {
      if (attempt.began) await this.stopPipeline();
      await predecessor;
      await attempt.settled;
      this.closeOwned(attempt);
      // Stop may have reached native before an in-flight open created its
      // pipeline. Retire that late result before admitting any replacement.
      if (pending) await this.stopPipeline();
      finish();
    })();
    return attempt.cleanup;
  }

  private async stopPipeline(): Promise<void> {
    try { await this.deps.stopPipeline(); } catch { /* proxy already gone */ }
  }

  private set(state: ShareState, stream: MediaStream | null): void {
    this.state = state;
    this.deps.onChange(state, stream);
  }
}
