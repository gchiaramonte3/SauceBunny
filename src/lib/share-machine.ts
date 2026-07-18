/**
 * Screen-share state machine (pure - the pipeline is injected at the
 * invoke/DOM seams so vitest drives it). One rule holds everything: the
 * stop button, session end, and the ffmpeg child dying ALL converge on the
 * same cleanup exactly once - share track retracted (camera restored via
 * the mesh override), peers un-flagged, pipeline stopped.
 */

export type ShareState = "idle" | "starting" | "sharing";

export type ShareDeps = {
  /** invoke start_screen_share -> the token-gated proxy URL. */
  start: (displayIndex: number) => Promise<string>;
  /** invoke stop_screen_share (kills the ffmpeg child). */
  stopPipeline: () => Promise<void>;
  /** Play the proxy stream hidden and captureStream() it (share-stream.ts).
   *  `onDied` fires when the pipeline ends underneath us (ffmpeg death). */
  open: (url: string, onDied: () => void) => Promise<{ stream: MediaStream; track: MediaStreamTrack; close: () => void }>;
  /** Mesh video override: the share track out, null restores the camera. */
  setOverride: (track: MediaStreamTrack | null) => void;
  /** Relay SessionMsg::Sharing so remote tiles badge. */
  announce: (on: boolean) => void;
  onChange: (state: ShareState, stream: MediaStream | null) => void;
  log: (tag: "info" | "warn" | "err", msg: string) => void;
};

export class ShareController {
  private deps: ShareDeps;
  private state: ShareState = "idle";
  private opened: { stream: MediaStream; track: MediaStreamTrack; close: () => void } | null = null;

  constructor(deps: ShareDeps) {
    this.deps = deps;
  }

  current(): ShareState {
    return this.state;
  }

  async start(displayIndex: number): Promise<void> {
    if (this.state !== "idle") return;
    this.set("starting", null);
    try {
      const url = await this.deps.start(displayIndex);
      const opened = await this.deps.open(url, () => this.onPipelineDied());
      this.opened = opened;
      this.deps.setOverride(opened.track);
      this.deps.announce(true);
      this.set("sharing", opened.stream);
      this.deps.log("info", `screen share started (display ${displayIndex})`);
    } catch (err) {
      this.deps.log("err", `screen share failed to start: ${err instanceof Error ? err.message : String(err)}`);
      await this.cleanup();
    }
  }

  /** Bar button / session end. */
  async stop(): Promise<void> {
    if (this.state === "idle") return;
    await this.cleanup();
  }

  /** The ffmpeg child died underneath us - same cleanup, loud log. */
  private onPipelineDied(): void {
    if (this.state === "idle") return;
    this.deps.log("err", "screen share pipeline died; restoring camera");
    void this.cleanup();
  }

  private async cleanup(): Promise<void> {
    const opened = this.opened;
    this.opened = null;
    this.set("idle", null);
    try { opened?.close(); } catch { /* already closed */ }
    this.deps.setOverride(null);
    this.deps.announce(false);
    try { await this.deps.stopPipeline(); } catch { /* proxy already gone */ }
  }

  private set(state: ShareState, stream: MediaStream | null): void {
    this.state = state;
    this.deps.onChange(state, stream);
  }
}
