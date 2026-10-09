import { pipelineLog } from "./pipeline";

/**
 * A Web Audio output that is made again when it can no longer be trusted
 * (owner report, 2026-10-08: "the app is no longer playing back audio after
 * it's idle for a long period of time").
 *
 * An AudioContext is bound to the output device that was there when it
 * started, and macOS can take that device away and put a new one in its
 * place: the virtual device a remote-desktop session provides goes when the
 * session idles or reconnects (Jump Desktop Audio was this Mac's default
 * output), a display's speakers go when it sleeps, headphones disconnect.
 * The context can stay "running" with its clock still moving, and nothing
 * reports an error: playback is simply silent. A new context binds to the
 * output as it is now.
 *
 * So the output is made again before it plays after OUTPUT_IDLE_MS of
 * silence, after the Mac's devices change, and when its clock stops while
 * playing. The player rebuilds its nodes on the new context through
 * `build`. Decoded audio is kept: an AudioBuffer belongs to no context.
 * Every replacement is written to the Pipeline, so a report says why.
 */
export const OUTPUT_IDLE_MS = 60_000;
/** A clock that has not moved for this long while playing has stopped. */
export const CLOCK_STALL_MS = 1_500;

export class AudioOutput {
  private current: AudioContext;
  private usedAt: number;
  private devicesChanged = false;
  /** The clock as last seen moving (`at`), and when it was last checked: a stall is only seen while it is watched. */
  private clock = { time: -1, at: 0, checked: 0 };
  private readonly unlisten: () => void;

  /** `player` names it in the Pipeline; `build` wires a new context's nodes and returns nothing. */
  constructor(private readonly player: string, private readonly build: (context: AudioContext) => void) {
    this.current = this.create();
    this.usedAt = performance.now();
    this.unlisten = listenForDevices(() => { this.devicesChanged = true; });
  }

  get context(): AudioContext { return this.current; }

  /** The output made or kept sound just now (it is playing, scrubbing, or just stopped). */
  touch(now = performance.now()) { this.usedAt = now; }

  /** Why the output should be made again before it next sounds, or null when it is fine. */
  staleness(now = performance.now()): string | null {
    if (this.devicesChanged) return "the Mac's audio devices changed";
    const idle = now - this.usedAt;
    return idle > OUTPUT_IDLE_MS ? `${Math.max(1, Math.round(idle / 60_000))} min without sound` : null;
  }

  /** A new context in place of this one, wired by `build`; the old one is closed. */
  replace(reason: string) {
    const old = this.current;
    old.onstatechange = null;
    void old.close().catch(() => undefined);
    this.current = this.create();
    this.devicesChanged = false;
    this.clock = { time: -1, at: 0, checked: 0 };
    this.touch();
    pipelineLog("audio", `${this.player}: made the audio output again (${reason}).`, "warn");
  }

  /**
   * Called while playing: true once the clock has not moved for CLOCK_STALL_MS
   * of watching. A gap between checks longer than that (a pause, then Play
   * again; a hidden window's slowed timers) starts the watch again rather than
   * reading a still clock across it as a stall.
   */
  stalled(now = performance.now()): boolean {
    const time = this.current.currentTime, watched = now - this.clock.checked <= CLOCK_STALL_MS;
    if (time !== this.clock.time || !watched) { this.clock = { time, at: now, checked: now }; return false; }
    this.clock.checked = now;
    return now - this.clock.at > CLOCK_STALL_MS;
  }

  close() {
    this.unlisten();
    this.current.onstatechange = null;
    void this.current.close().catch(() => undefined);
  }

  private create() {
    const context = new AudioContext();
    this.build(context);
    return context;
  }
}

/** Told when the Mac's media devices change, where the page can hear of it. */
function listenForDevices(changed: () => void): () => void {
  const devices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  if (!devices || typeof devices.addEventListener !== "function") return () => undefined;
  devices.addEventListener("devicechange", changed);
  return () => devices.removeEventListener("devicechange", changed);
}
