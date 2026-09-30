import type { EditDocument } from "../bindings/EditDocument";
import type { EditTrack } from "../bindings/EditTrack";
import { GRAIN_MIN_INTERVAL_MS, grainEnvelope, idleScrubState, planGrain } from "./audio-scrub";
import { formatError } from "./error-format";
import { clampFrame } from "./multitrack";
import { MultitrackAudioCache } from "./multitrack-audio-cache";
import { clampTrackGain } from "./multitrack-gain";

/**
 * Plays an edit list: the program is a run of segments, each a frame range of
 * one AAF Audio source (or a gap), and every output track draws on whichever
 * mic that track names in the segment's source. One AudioContext clock, as in
 * `MultitrackAudio`; the PCM comes from the same five-second decoded windows,
 * one `MultitrackAudioCache` per source document.
 *
 * The program is cut into BLOCKS: the part of one segment that lies inside one
 * cache window of its source. A block is the unit that is fetched and
 * scheduled, so nothing is scheduled that is not already decoded, and when the
 * next block is late the playhead stops at the edge of what is scheduled and
 * reports busy rather than running ahead of the sound.
 */

export type EditAudioState = { frame: number; rate: number; busy: boolean; error: string | null };

/** Part of one segment inside one cache window. Program frames are [program, end). */
export type EditBlock = {
  program: number; end: number; segment: number;
  /** Source id, or null for a gap. */
  source: string | null;
  /** Source frame at `program`. */
  at: number;
  /** Start of the cache window that holds `at`. */
  window: number;
  /** The block starts at a segment join / ends at one. */
  joinIn: boolean; joinOut: boolean;
};

/** Why a piece's edge is faded: a cut between segments, or the edge of a mute. */
export type EdgeKind = "join" | "mute" | null;
export type VoicePiece = { from: number; to: number; fadeIn: EdgeKind; fadeOut: EdgeKind };

// Web Audio scheduling headroom, not a readiness wait (same as MultitrackAudio).
const SCHEDULE_LEAD_SECONDS = 0.015;
/** Equal-power crossfade length at a join, and the fade at a mute's edges. */
export const JOIN_FADE_SECONDS = 0.01;
const HANDLE_SECONDS = JOIN_FADE_SECONDS / 2;
const CURVE_POINTS = 64;
const HELD_WINDOWS = 6;

const segmentFrames = (segment: EditDocument["segments"][number]) => segment.kind === "gap" ? segment.frames : segment.out_frame - segment.in_frame;
/** Whether a clip plays a track: every track unless the clip was cut with only some (a bite of one person). */
const clipPlays = (document: EditDocument, index: number, track: string) => {
  const segment = document.segments[index];
  return !segment || segment.kind !== "source" || !segment.tracks || segment.tracks.includes(track);
};
export const programLength = (document: EditDocument) => document.segments.reduce((sum, segment) => sum + Math.max(0, segmentFrames(segment)), 0);

export function planBlocks(document: EditDocument, windowFrames: number): EditBlock[] {
  const blocks: EditBlock[] = [], last = document.segments.length - 1;
  let program = 0;
  document.segments.forEach((segment, index) => {
    const length = Math.max(0, segmentFrames(segment));
    if (!length) return;
    const joinIn = index > 0, joinOut = index < last;
    if (segment.kind === "gap") {
      blocks.push({ program, end: program + length, segment: index, source: null, at: 0, window: 0, joinIn, joinOut });
    } else {
      for (let at = segment.in_frame; at < segment.out_frame;) {
        const window = Math.floor(at / windowFrames) * windowFrames, next = Math.min(segment.out_frame, window + windowFrames);
        const start = program + at - segment.in_frame;
        blocks.push({ program: start, end: start + next - at, segment: index, source: segment.source, at, window,
          joinIn: joinIn && at === segment.in_frame, joinOut: joinOut && next === segment.out_frame });
        at = next;
      }
    }
    program += length;
  });
  return blocks;
}

/** The block holding program frame `frame`, or -1 past the end. */
export function blockIndex(blocks: EditBlock[], frame: number) {
  let low = 0, high = blocks.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1, block = blocks[middle];
    if (frame < block.program) high = middle - 1; else if (frame >= block.end) low = middle + 1; else return middle;
  }
  return -1;
}

/** Program frame to (segment, source, source frame); a gap has no source. */
export function programToSource(document: EditDocument, frame: number): { segment: number; source: string | null; frame: number } | null {
  let program = 0;
  for (const [index, segment] of document.segments.entries()) {
    const length = Math.max(0, segmentFrames(segment));
    if (frame >= program && frame < program + length) {
      return segment.kind === "gap" ? { segment: index, source: null, frame: frame - program } : { segment: index, source: segment.source, frame: segment.in_frame + frame - program };
    }
    program += length;
  }
  return null;
}

/**
 * The source frame ranges one edit track sounds inside a block, starting at
 * program frame `from`, with that track's mutes cut out of them.
 */
export function trackPieces(document: EditDocument, block: EditBlock, trackId: string, from = block.program): VoicePiece[] {
  if (block.source === null) return [];
  const start = block.at + Math.max(0, from - block.program), end = block.at + block.end - block.program;
  const mutes = document.mutes.filter((mute) => mute.source === block.source && mute.track === trackId && mute.out_frame > start && mute.in_frame < end)
    .sort((a, b) => a.in_frame - b.in_frame);
  const pieces: VoicePiece[] = [];
  let cursor = start, cursorKind: EdgeKind = block.joinIn && from <= block.program ? "join" : null;
  for (const mute of mutes) {
    if (mute.in_frame > cursor) pieces.push({ from: cursor, to: mute.in_frame, fadeIn: cursorKind, fadeOut: "mute" });
    if (mute.out_frame > cursor) { cursor = mute.out_frame; cursorKind = "mute"; }
  }
  if (cursor < end) pieces.push({ from: cursor, to: end, fadeIn: cursorKind, fadeOut: block.joinOut ? "join" : null });
  return pieces;
}

function equalPower(rising: boolean) {
  const curve = new Float32Array(CURVE_POINTS);
  for (let i = 0; i < CURVE_POINTS; i++) {
    const t = i / (CURVE_POINTS - 1);
    curve[i] = rising ? Math.sin(t * Math.PI / 2) : Math.cos(t * Math.PI / 2);
  }
  return curve;
}

/** Longest stretch of a source any segment or mute touches: the fallback source length. */
function sourceExtent(document: EditDocument, source: string) {
  let extent = 0;
  for (const segment of document.segments) if (segment.kind === "source" && segment.source === source) extent = Math.max(extent, segment.out_frame);
  for (const mute of document.mutes) if (mute.source === source) extent = Math.max(extent, mute.out_frame);
  return extent;
}

export class EditAudio {
  private context: AudioContext;
  private master: GainNode;
  /** 1 / audible tracks, so adding a person does not raise the level. */
  private mix: GainNode;
  private trackLevels = new Map<string, GainNode>();
  private voices = new Set<AudioBufferSourceNode>();
  private caches = new Map<string, MultitrackAudioCache>();
  private cacheOf = new Map<string, string>();
  private held = new Map<string, Map<string, AudioBuffer>>();
  private document: EditDocument | null = null;
  private documentKey = "";
  private tracks: EditTrack[] = [];
  private blocks: EditBlock[] = [];
  private total = 0;
  private readonly windowFrames: number;
  private request = 0;
  private fillRequest = -1;
  private closed = false;
  private timer = 0;
  private origin: { frame: number; time: number } | null = null;
  private scheduledUntil = 0;
  private grainState = idleScrubState();
  private scrubTimer = 0;
  private grainTimer = 0;
  private preparing: string | null = null;
  private resuming: Promise<void> | null = null;
  private state: EditAudioState = { frame: 0, rate: 0, busy: false, error: null };
  private readonly fadeIn = equalPower(true);
  private readonly fadeOut = equalPower(false);

  constructor(private fps: number, private notify: (state: EditAudioState) => void) {
    this.windowFrames = Math.ceil(5 * fps);
    this.context = new AudioContext();
    this.master = this.context.createGain(); this.master.connect(this.context.destination);
    this.mix = this.context.createGain(); this.mix.connect(this.master);
    this.context.onstatechange = () => {
      if (!this.closed && this.state.rate && this.context.state !== "running") this.fail(new Error("Audio output was interrupted. Press Play to resume."));
    };
  }

  /** Replace the edit or the audible tracks. A playing edit keeps playing from the same program frame. */
  setDocument(document: EditDocument, audibleTrackIds: string[], sourceFrames: Record<string, number> = {}) {
    const key = `${audibleTrackIds.join("|")}\n${JSON.stringify(sourceFrames)}`;
    if (document === this.document && key === this.documentKey) return;
    const playing = this.state.rate !== 0 || this.state.busy, frame = this.currentFrame();
    this.document = document; this.documentKey = key;
    const audible = new Set(audibleTrackIds);
    this.tracks = document.tracks.filter((track) => track.kind === "sound" && audible.has(track.id));
    this.mix.gain.value = 1 / Math.max(1, this.tracks.length);
    this.blocks = planBlocks(document, this.windowFrames); this.total = programLength(document);
    const used = new Set<string>(); this.cacheOf.clear();
    for (const source of document.sources) {
      const cacheKey = `${source.document_id}|${sourceFrames[source.id] ?? sourceExtent(document, source.id)}`;
      if (!this.caches.has(cacheKey)) this.caches.set(cacheKey, new MultitrackAudioCache(source.document_id, this.fps, Number(cacheKey.split("|").at(-1)), this.context));
      this.cacheOf.set(source.id, cacheKey); used.add(cacheKey);
    }
    for (const [cacheKey, cache] of this.caches) if (!used.has(cacheKey)) { cache.clear(); this.caches.delete(cacheKey); }
    for (const heldKey of this.held.keys()) if (!used.has(heldKey.slice(0, heldKey.lastIndexOf("@")))) this.held.delete(heldKey);
    if (playing) void this.seek(frame, 1);
    else if (this.state.frame !== clampFrame(this.state.frame, this.total)) this.publish({ frame: clampFrame(this.state.frame, this.total) });
  }

  setLevel(volume: number, muted: boolean) { this.master.gain.value = muted ? 0 : volume; }
  setTrackLevel(trackId: string, gain: number) { this.trackGain(trackId).gain.value = clampTrackGain(gain); }

  toggle() {
    if (this.state.rate || this.state.busy) { this.pause(); return Promise.resolve(); }
    return this.seek(this.state.frame >= this.total - 1 ? 0 : this.state.frame, 1);
  }

  pause() { const frame = this.halt(true); this.publish({ frame, rate: 0, busy: false }); }

  /** Stop everything sounding and invalidate every run in flight; returns the frame it stopped on. */
  private halt(cancelPreparation: boolean) {
    const frame = this.currentFrame(); ++this.request;
    cancelAnimationFrame(this.timer); clearTimeout(this.scrubTimer); clearTimeout(this.grainTimer); this.stopVoices();
    this.origin = null; this.grainState = idleScrubState(); this.preparing = null;
    if (cancelPreparation) for (const cache of this.caches.values()) cache.cancel();
    return frame;
  }

  close() {
    this.pause(); this.closed = true; this.context.onstatechange = null;
    for (const cache of this.caches.values()) cache.clear();
    this.caches.clear(); this.held.clear();
    for (const gain of this.trackLevels.values()) gain.disconnect();
    this.trackLevels.clear(); void this.context.close();
  }

  /** Park at `frame` (rate 0, with a scrub grain when it is decoded) or play from it (any other rate plays forward at 1x). */
  async seek(frame: number, rate = 0, soundScrub = true) {
    // Preparation is kept: a re-plan or a nearby seek reuses reads in flight.
    this.halt(false);
    // The request is claimed before the first await, so a Pause during the
    // output resume or the first read invalidates this run synchronously.
    // Play intent is published at once, so Stop is live for the whole wait.
    const request = ++this.request, target = clampFrame(frame, this.total), play = rate && target < this.total ? 1 : 0;
    const block = this.blocks[blockIndex(this.blocks, target)];
    this.publish({ frame: target, rate: play, busy: play ? !this.ready(block) : false, error: null });
    try {
      if (!play) { if (soundScrub) this.grain(target); return; }
      if (this.context.state !== "running") await this.resumeOutput();
      if (request !== this.request || this.closed) return;
      this.scheduledUntil = target; this.origin = null;
      await this.fill(request);
    } catch (cause) { if (request === this.request && !this.closed) this.fail(cause); }
  }

  /** Pointer feedback is synchronous; decoding a cold position is coalesced. */
  scrub(frame: number) {
    if (this.state.rate || this.state.busy) this.pause();
    this.publish({ frame: clampFrame(frame, this.total) });
    if (this.context.state !== "running") {
      const request = this.request;
      void this.resumeOutput().then(() => { if (request === this.request && !this.closed && !this.state.rate) this.queueGrain(); })
        .catch((cause) => { if (request === this.request && !this.closed) this.publish({ error: formatError(cause) }); });
    } else this.queueGrain();
    const block = this.blocks[blockIndex(this.blocks, this.state.frame)];
    if (block && !this.ready(block) && this.preparing !== this.heldKey(block)) {
      clearTimeout(this.scrubTimer);
      this.scrubTimer = window.setTimeout(() => { void this.prepareScrub(); }, 80);
    }
  }

  private async prepareScrub() {
    if (this.closed) return;
    const block = this.blocks[blockIndex(this.blocks, this.state.frame)];
    if (!block) return;
    const request = ++this.request, key = this.heldKey(block);
    for (const cache of this.caches.values()) cache.cancel();
    this.preparing = key;
    try {
      await this.buffersFor(block);
      if (request !== this.request || this.closed || this.state.rate) return;
      this.queueGrain();
    } catch (cause) { if (request === this.request && !this.closed) this.publish({ error: formatError(cause) }); }
    finally { if (request === this.request) this.preparing = null; }
  }

  private publish(patch: Partial<EditAudioState>) { this.state = { ...this.state, ...patch }; if (!this.closed) this.notify(this.state); }
  private fail(cause: unknown) { this.pause(); this.publish({ error: formatError(cause) }); }
  private async resumeOutput() {
    if (this.context.state === "running") return;
    if (!this.resuming) this.resuming = this.context.resume().finally(() => { this.resuming = null; });
    await this.resuming;
    const state: AudioContextState = this.outputState();
    if (state !== "running") throw new Error("Audio output is unavailable. Check the Mac's output device, then press Play.");
  }
  private outputState(): AudioContextState { return this.context.state; }
  private stopVoices() { for (const voice of this.voices) { try { voice.stop(); } catch { /* already ended */ } voice.disconnect(); } this.voices.clear(); }
  private trackGain(id: string) {
    let gain = this.trackLevels.get(id);
    if (!gain) { gain = this.context.createGain(); gain.connect(this.mix); this.trackLevels.set(id, gain); }
    return gain;
  }

  private rawFrame() { return this.origin ? this.origin.frame + Math.max(0, this.context.currentTime - this.origin.time) * this.fps : this.state.frame; }
  private currentFrame() {
    if (!this.state.rate || this.state.busy || !this.origin) return this.state.frame;
    // Never report a frame whose sound has not been scheduled.
    return clampFrame(Math.min(this.rawFrame(), this.scheduledUntil), this.total);
  }

  /** AAF track ids the audible tracks read in `source`. */
  private mics(source: string) { return [...new Set(this.tracks.map((track) => track.source_tracks[source]).filter((id): id is string => !!id))]; }
  private heldKey(block: EditBlock) { return `${block.source ? this.cacheOf.get(block.source) ?? "" : ""}@${block.window}`; }
  private ready(block: EditBlock | undefined) {
    if (!block?.source) return true;
    const held = this.held.get(this.heldKey(block));
    return this.mics(block.source).every((id) => held?.has(id));
  }
  private async buffersFor(block: EditBlock): Promise<Map<string, AudioBuffer>> {
    const cacheKey = block.source ? this.cacheOf.get(block.source) : undefined, cache = cacheKey ? this.caches.get(cacheKey) : undefined;
    const ids = block.source ? this.mics(block.source) : [];
    if (!block.source || !cache || !ids.length) return new Map();
    const key = this.heldKey(block), held = this.held.get(key);
    if (held && ids.every((id) => held.has(id))) return held;
    const buffers = await cache.get(ids, block.at);
    const merged = new Map([...(this.held.get(key) ?? []), ...buffers]);
    this.held.delete(key); this.held.set(key, merged);
    while (this.held.size > HELD_WINDOWS) this.held.delete(this.held.keys().next().value ?? "");
    return merged;
  }

  /** Schedule blocks, one read at a time, until one window ahead of the playhead. */
  private fill(request: number) {
    if (this.fillRequest === request) return Promise.resolve();
    this.fillRequest = request;
    return this.fillLoop(request)
      .catch((cause) => { if (request === this.request && !this.closed) this.fail(cause); })
      .finally(() => { if (this.fillRequest === request) this.fillRequest = -1; });
  }
  private async fillLoop(request: number) {
    while (request === this.request && !this.closed && this.state.rate) {
      if (this.scheduledUntil >= this.total) return;
      if (this.origin && this.scheduledUntil - this.rawFrame() >= this.windowFrames) return;
      const block = this.blocks[blockIndex(this.blocks, this.scheduledUntil)];
      const buffers = await this.buffersFor(block);
      if (request !== this.request || this.closed || !this.state.rate) return;
      const from = this.scheduledUntil;
      let when = this.origin ? this.origin.time + (from - this.origin.frame) / this.fps : 0;
      const restart = !this.origin || when < this.context.currentTime;
      if (restart) {
        // First block, or the block arrived after its time: restart the clock
        // at the edge of what was scheduled. Nothing past it is sounding.
        if (this.context.state !== "running") throw new Error("Audio output was interrupted. Press Play to resume.");
        when = this.context.currentTime + SCHEDULE_LEAD_SECONDS;
        this.origin = { frame: from, time: when };
        this.publish({ frame: from, busy: false });
      }
      this.scheduleBlock(block, from, when, buffers);
      this.scheduledUntil = block.end;
      if (restart) { cancelAnimationFrame(this.timer); this.timer = requestAnimationFrame(this.tick); }
    }
  }

  private scheduleBlock(block: EditBlock, from: number, when: number, buffers: Map<string, AudioBuffer>) {
    if (!block.source || !this.document) return;
    const startSource = block.at + from - block.program;
    for (const track of this.tracks) {
      const mic = track.source_tracks[block.source], buffer = mic ? buffers.get(mic) : undefined;
      if (!buffer || !clipPlays(this.document, block.segment, track.id)) continue;
      for (const piece of trackPieces(this.document, block, track.id, from)) {
        const offset = (piece.from - block.window) / this.fps, start = when + (piece.from - startSource) / this.fps;
        const length = Math.min((piece.to - piece.from) / this.fps, buffer.duration - offset);
        // A join is an equal-power crossfade centred on the cut: the outgoing
        // piece runs on into its handle and the incoming one starts early,
        // each as far as its decoded window (and the clock) allows.
        const pre = piece.fadeIn === "join" ? Math.max(0, Math.min(HANDLE_SECONDS, offset, start - this.context.currentTime)) : 0;
        const post = piece.fadeOut === "join" ? Math.max(0, Math.min(HANDLE_SECONDS, buffer.duration - offset - length)) : 0;
        this.voice(track.id, buffer, start - pre, offset - pre, length + pre + post, piece.fadeIn ? JOIN_FADE_SECONDS : 0, piece.fadeOut ? JOIN_FADE_SECONDS : 0);
      }
    }
  }

  private voice(trackId: string, buffer: AudioBuffer, when: number, offset: number, length: number, fadeIn: number, fadeOut: number) {
    if (length <= 0) return;
    const source = this.context.createBufferSource(), gain = this.context.createGain(); source.buffer = buffer;
    source.connect(gain); gain.connect(this.trackGain(trackId));
    // Two curves that never touch: setValueCurveAtTime throws on any overlapping event.
    const cap = length * 0.45;
    if (fadeIn) gain.gain.setValueCurveAtTime(this.fadeIn, when, Math.min(fadeIn, cap));
    if (fadeOut) gain.gain.setValueCurveAtTime(this.fadeOut, when + length - Math.min(fadeOut, cap), Math.min(fadeOut, cap));
    this.start(source, gain, when, offset, length);
  }
  private start(source: AudioBufferSourceNode, gain: GainNode, when: number, offset: number, length: number) {
    source.onended = () => { this.voices.delete(source); source.disconnect(); gain.disconnect(); };
    this.voices.add(source); source.start(when, offset, length);
  }

  private tick = () => {
    if (!this.state.rate || this.state.busy || this.closed || !this.origin) return;
    const raw = this.rawFrame();
    if (raw >= this.scheduledUntil) {
      if (this.scheduledUntil >= this.total) { this.pause(); return; }
      // The next block is late: hold the playhead at the edge of the sound.
      this.origin = null; this.stopVoices();
      this.publish({ frame: clampFrame(this.scheduledUntil, this.total), busy: true });
      void this.fill(this.request);
      return;
    }
    this.publish({ frame: this.currentFrame() });
    if (this.scheduledUntil - raw < this.windowFrames) void this.fill(this.request);
    this.timer = requestAnimationFrame(this.tick);
  };

  private queueGrain() {
    clearTimeout(this.grainTimer);
    if (this.closed) return;
    const elapsed = this.grainState.lastFiredAtMs === null ? Infinity : performance.now() - this.grainState.lastFiredAtMs;
    if (elapsed >= GRAIN_MIN_INTERVAL_MS) this.grain(this.state.frame);
    else this.grainTimer = window.setTimeout(() => { if (!this.state.rate) this.grain(this.state.frame); }, GRAIN_MIN_INTERVAL_MS - elapsed);
  }
  /** A short windowed excerpt centred on the playhead, from the playhead's own segment. */
  private grain(frame: number) {
    const block = this.blocks[blockIndex(this.blocks, frame)];
    if (!block?.source || !this.document || this.context.state !== "running" || !this.ready(block)) return;
    const held = this.held.get(this.heldKey(block));
    const program = frame / this.fps, plan = planGrain(this.grainState, performance.now(), program, this.total / this.fps);
    if (!plan || !held) return;
    const sourceFrame = block.at + frame - block.program;
    const offset = Math.max(0, (sourceFrame - block.window) / this.fps - (program - plan.offsetSec)), when = this.context.currentTime;
    for (const track of this.tracks) {
      const mic = track.source_tracks[block.source], buffer = mic ? held.get(mic) : undefined;
      if (!buffer || !clipPlays(this.document, block.segment, track.id)) continue;
      if (this.document.mutes.some((mute) => mute.source === block.source && mute.track === track.id && sourceFrame >= mute.in_frame && sourceFrame < mute.out_frame)) continue;
      const length = Math.min(plan.durationSec, buffer.duration - offset);
      if (length <= 0) continue;
      const source = this.context.createBufferSource(), gain = this.context.createGain(); source.buffer = buffer;
      source.connect(gain); gain.connect(this.trackGain(track.id));
      gain.gain.setValueCurveAtTime(grainEnvelope(plan.gain, length, Math.min(plan.fadeSec, length / 2)), when, length);
      this.start(source, gain, when, offset, length);
    }
    this.grainState = { lastFiredAtMs: performance.now(), lastSourceSec: program };
  }
}
