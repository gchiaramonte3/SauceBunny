import { GRAIN_MIN_INTERVAL_MS, grainEnvelope, idleScrubState, planGrain } from "./audio-scrub";
import { clampFrame } from "./multitrack";
import { MultitrackAudioCache } from "./multitrack-audio-cache";
import { nextShuttleRate } from "./shuttle";
import { formatError } from "./error-format";
import { clampTrackGain } from "./multitrack-gain";

export type AuditionState = { frame: number; rate: number; busy: boolean; error: string | null };
// Existing Web Audio scheduling headroom, not a readiness wait.
const SCHEDULE_LEAD_SECONDS = 0.015;
/** Every microphone starts on one AudioContext clock. No independent media-element clocks. */
export class MultitrackAudio {
  private context: AudioContext;
  private cache: MultitrackAudioCache;
  private master: GainNode;
  private trackLevels = new Map<string, GainNode>();
  private voices = new Set<AudioBufferSourceNode>();
  private buffers = new Map<string, AudioBuffer>();
  private bufferStart = -1;
  private request = 0;
  private requestedRate = 0;
  private closed = false;
  private timer = 0;
  private originTime = 0;
  private originFrame = 0;
  private grainState = idleScrubState();
  private scrubTimer = 0;
  private grainTimer = 0;
  private resuming: Promise<void> | null = null;
  private preparingStart: number | null = null;
  private scrubEnabled = true;
  private state: AuditionState = { frame: 0, rate: 0, busy: false, error: null };
  private next: { buffers: Map<string, AudioBuffer>; start: number; when: number; request: number } | null = null;
  constructor(documentId: string, private fps: number, private duration: number, private ids: string[], private notify: (state: AuditionState) => void) {
    this.context = new AudioContext(); this.master = this.context.createGain(); this.master.connect(this.context.destination);
    this.cache = new MultitrackAudioCache(documentId, fps, duration, this.context);
  }
  private publish(patch: Partial<AuditionState>) { this.state = { ...this.state, ...patch }; if (!this.closed) this.notify(this.state); }
  private stopVoices() { for (const voice of this.voices) { try { voice.stop(); } catch { /* already ended */ } voice.disconnect(); } this.voices.clear(); }
  private currentFrame() {
    if (!this.state.rate || this.state.busy) return this.state.frame;
    const frame = this.originFrame + Math.max(0, this.context.currentTime - this.originTime) * this.fps * this.state.rate;
    // Never advance captions/the playhead into audio that hasn't been scheduled.
    const covered = this.state.rate === 1 ? (this.next?.start ?? this.bufferStart) + this.cache.windowFrames : this.duration;
    return clampFrame(Math.min(frame, covered), this.duration);
  }
  setLevel(volume: number, muted: boolean) { this.master.gain.value = muted ? 0 : volume; }
  private trackGain(id: string) {
    let gain = this.trackLevels.get(id);
    if (!gain) { gain = this.context.createGain(); gain.connect(this.master); this.trackLevels.set(id, gain); }
    return gain;
  }
  /** Audition only: change current and queued voices without seeking or decoding. */
  setTrackLevel(id: string, volume: number) {
    this.trackGain(id).gain.value = clampTrackGain(volume);
  }
  setScrubbing(enabled: boolean) { this.scrubEnabled = enabled; if (!enabled) { clearTimeout(this.grainTimer); clearTimeout(this.scrubTimer); if (this.state.rate !== 1) this.stopVoices(); } }
  setTracks(ids: string[]) {
    if (ids.join("|") === this.ids.join("|")) return;
    const frame = this.currentFrame(), rate = this.requestedRate; this.ids = ids;
    // Changing the audition mix while parked must not emit a scrub grain.
    void this.seek(frame, rate, false);
  }
  shuttle(direction: 1 | -1) { return this.seek(this.currentFrame(), nextShuttleRate(this.requestedRate, direction)); }
  pause(cancelPreparation = true) {
    const frame = this.currentFrame(); ++this.request; cancelAnimationFrame(this.timer); clearTimeout(this.scrubTimer); clearTimeout(this.grainTimer); this.next = null; this.stopVoices();
    this.grainState = idleScrubState();
    this.requestedRate = 0;
    if (cancelPreparation) this.cache.cancel(); this.preparingStart = null;
    this.publish({ frame, rate: 0, busy: false });
  }
  suspend() { this.pause(); this.cache.clear(); this.buffers.clear(); this.bufferStart = -1; }
  close() { this.suspend(); this.closed = true; for (const gain of this.trackLevels.values()) gain.disconnect(); this.trackLevels.clear(); void this.context.close(); }
  /** Decode the parked window plus one look-ahead silently. No context resume,
   * voices or playhead movement; Play reuses pending/completed cache entries. */
  async warm(frame: number) {
    const request = this.request;
    try {
      const buffers = await this.cache.get(this.ids, frame);
      if (request !== this.request || this.closed || this.state.rate) return;
      this.buffers = buffers; this.bufferStart = this.cache.start(frame);
      const next = this.bufferStart + this.cache.windowFrames;
      if (next < this.duration) await this.cache.get(this.ids, next);
    } catch { /* Play reports an actionable preparation error if it persists. */ }
  }
  /** Pointer feedback is synchronous; no decode/IPC in the drag path. */
  scrub(frame: number) {
    if (this.state.rate || this.state.busy) this.pause();
    this.publish({ frame: clampFrame(frame, this.duration) });
    if (!this.scrubEnabled) return;
    // Silent warming does not unlock Web Audio. The actual pointer gesture
    // must resume it even when PCM is already cached, using the latest frame.
    if (this.scrubEnabled && this.context.state === "suspended") {
      const request = this.request;
      if (!this.resuming) this.resuming = this.context.resume().finally(() => { this.resuming = null; });
      void this.resuming.then(() => { if (request === this.request && !this.closed && !this.state.rate) this.queueGrain(); })
        .catch((cause) => { if (request === this.request && !this.closed) this.publish({ error: formatError(cause) }); });
    } else this.queueGrain();
    // Coalesce cold scrub positions. Never move the UI back to an old decode result.
    if (!this.hasBuffers(this.state.frame) && this.preparingStart !== this.cache.start(this.state.frame)) {
      clearTimeout(this.scrubTimer);
      this.scrubTimer = window.setTimeout(() => { void this.prepareScrub(); }, 80);
    }
  }
  private async prepareScrub() {
    if (!this.scrubEnabled || this.closed) return;
    const target = this.state.frame, start = this.cache.start(target), request = ++this.request;
    this.cache.cancel(); this.preparingStart = start;
    try {
      if (this.context.state === "suspended") await this.context.resume();
      if (request !== this.request || this.closed || !this.scrubEnabled) return;
      const buffers = await this.cache.get(this.ids, target);
      if (request !== this.request || this.closed || this.state.rate) return;
      this.buffers = buffers; this.bufferStart = start;
      // Only the latest pointer position may sound, and only if it is covered.
      this.queueGrain();
    } catch (cause) { if (request === this.request && !this.closed) this.publish({ error: formatError(cause) }); }
    finally { if (request === this.request) this.preparingStart = null; }
  }
  private hasBuffers(frame: number) { return this.cache.start(frame) === this.bufferStart && this.ids.every((id) => this.buffers.has(id)); }
  async seek(frame: number, rate = 0, soundScrub = true) {
    this.pause(false); const target = clampFrame(frame, this.duration), request = ++this.request;
    this.requestedRate = rate;
    this.publish({ frame: target, error: null });
    try {
      if (this.context.state === "suspended") await this.context.resume();
      if (request !== this.request || this.closed) return;
      if (!this.hasBuffers(target)) {
        this.publish({ busy: true });
        const buffers = await this.cache.get(this.ids, target);
        if (request !== this.request || this.closed) return;
        this.buffers = buffers; this.bufferStart = this.cache.start(target);
      }
      this.publish({ busy: false });
      if (!rate) { if (soundScrub) this.grain(target); void this.warm(target); return; }
      this.startPlayback(target, rate);
    } catch (cause) { if (request === this.request && !this.closed) this.fail(cause); }
  }
  private startPlayback(frame: number, rate: number) {
    this.originFrame = frame; this.originTime = this.context.currentTime + SCHEDULE_LEAD_SECONDS;
    this.grainState = idleScrubState(); this.publish({ frame, rate, busy: false });
    if (rate === 1) { this.schedule(this.buffers, this.bufferStart, frame, this.originTime); this.prepareNext(this.bufferStart, this.originTime - (frame - this.bufferStart) / this.fps); }
    this.tick();
  }
  private bufferAt(frame: number) {
    cancelAnimationFrame(this.timer); this.stopVoices();
    // Keep Play intent and request ownership. Only the matching ready block may
    // resume; Pause, a new seek or disposal still invalidates it synchronously.
    this.publish({ frame, busy: true });
  }
  private fail(cause: unknown) { this.pause(); this.publish({ error: formatError(cause) }); }
  private voice(trackId: string, buffer: AudioBuffer, when: number, offset: number, length: number, peak: number, fade = 0) {
    if (length <= 0) return;
    const source = this.context.createBufferSource(), gain = this.context.createGain(); source.buffer = buffer;
    source.connect(gain); gain.connect(this.trackGain(trackId));
    if (fade) gain.gain.setValueCurveAtTime(grainEnvelope(peak, length, Math.min(fade, length / 2)), when, length);
    else gain.gain.value = peak;
    source.onended = () => { this.voices.delete(source); source.disconnect(); gain.disconnect(); };
    this.voices.add(source); source.start(when, offset, length);
  }
  private schedule(buffers: Map<string, AudioBuffer>, start: number, frame: number, when: number) {
    const gain = 1 / Math.max(1, this.ids.length), offset = (frame - start) / this.fps;
    for (const id of this.ids) { const buffer = buffers.get(id); if (buffer) this.voice(id, buffer, when, offset, buffer.duration - offset, gain); }
  }
  private prepareNext(start: number, startTime: number) {
    const end = Math.min(this.duration, start + this.cache.windowFrames), request = this.request;
    if (end >= this.duration) return;
    void this.cache.get(this.ids, end).then((buffers) => {
      if (request !== this.request || this.closed || this.state.rate !== 1) return;
      const when = startTime + (end - start) / this.fps;
      if (when < this.context.currentTime) {
        this.bufferAt(end); this.next = null; this.buffers = buffers; this.bufferStart = end;
        this.startPlayback(end, 1); return;
      }
      this.schedule(buffers, end, end, when); this.next = { buffers, start: end, when, request };
    }).catch((cause) => { if (request === this.request && !this.closed) this.fail(cause); });
  }
  private tick = () => {
    if (!this.state.rate || this.state.busy || this.closed) return;
    const frame = this.currentFrame(); this.publish({ frame });
    if (this.next?.request === this.request && this.context.currentTime >= this.next.when) {
      const next = this.next; this.next = null; this.buffers = next.buffers; this.bufferStart = next.start;
      this.prepareNext(next.start, next.when);
    }
    if (this.state.rate === 1 && frame >= this.bufferStart + this.cache.windowFrames) {
      this.bufferAt(this.bufferStart + this.cache.windowFrames); return;
    }
    const playedToEnd = this.state.rate > 0 && this.context.currentTime >= this.originTime + (this.duration - this.originFrame) / (this.fps * this.state.rate);
    if (playedToEnd || (frame === 0 && this.state.rate < 0)) { this.pause(); return; }
    if (this.state.rate !== 1) {
      if (!this.hasBuffers(frame)) { void this.seek(frame, this.state.rate); return; }
      this.grain(frame);
    }
    this.timer = requestAnimationFrame(this.tick);
  };
  private queueGrain() {
    clearTimeout(this.grainTimer);
    if (!this.scrubEnabled || this.closed) return;
    const elapsed = this.grainState.lastFiredAtMs === null ? Infinity : performance.now() - this.grainState.lastFiredAtMs;
    if (elapsed >= GRAIN_MIN_INTERVAL_MS) this.grain(this.state.frame);
    else this.grainTimer = window.setTimeout(() => { if (!this.state.rate) this.grain(this.state.frame); }, GRAIN_MIN_INTERVAL_MS - elapsed);
  }
  private grain(frame: number) {
    if (!this.scrubEnabled || !this.hasBuffers(frame) || this.context.state !== "running") return;
    const source = frame / this.fps, plan = planGrain(this.grainState, performance.now(), source, this.duration / this.fps);
    if (!plan) return;
    const offset = Math.max(0, plan.offsetSec - this.bufferStart / this.fps), when = this.context.currentTime;
    for (const id of this.ids) { const buffer = this.buffers.get(id); if (buffer) this.voice(id, buffer, when, offset, Math.min(plan.durationSec, buffer.duration - offset), plan.gain / Math.max(1, this.ids.length), plan.fadeSec); }
    this.grainState = { lastFiredAtMs: performance.now(), lastSourceSec: source };
  }
}
