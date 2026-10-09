import type { EditDocument } from "../bindings/EditDocument";
import type { EditTrack } from "../bindings/EditTrack";
import { GRAIN_MIN_INTERVAL_MS, grainEnvelope, idleScrubState, planGrain } from "./audio-scrub";
import { formatError } from "./error-format";
import { clampFrame } from "./multitrack";
import { MultitrackAudioCache } from "./multitrack-audio-cache";
import { clampTrackGain } from "./multitrack-gain";
import { nextShuttleRate } from "./shuttle";
import { AudioOutput } from "./audio-output";

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

/**
 * Material some lanes play across a block instead of the segment's clip (an
 * Overwrite on those tracks alone): `source` from frame `at`, inside the
 * cache window starting at `window`.
 */
export type BlockVoice = { source: string; at: number; window: number; lanes: string[] };

/**
 * Part of one segment inside one cache window. Program frames are [program, end).
 * A segment where some lanes play other material is cut wherever ANY of its
 * ranges crosses a window, so every voice of a block sits in one window.
 */
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
  /** What lanes overwritten here alone play instead, grouped by range. */
  overrides?: BlockVoice[];
};
/** One range a block plays: the clip's own (`lanes` null, every lane not overridden) or an override's. */
type Voice = { source: string; at: number; window: number; lanes: string[] | null };

/** Why a piece's edge is faded: a cut between segments, or the edge of a mute. */
export type EdgeKind = "join" | "mute" | null;
export type VoicePiece = { from: number; to: number; fadeIn: EdgeKind; fadeOut: EdgeKind };

// Web Audio scheduling headroom, not a readiness wait (same as MultitrackAudio).
const SCHEDULE_LEAD_SECONDS = 0.015;
/** Equal-power crossfade length at a join, and the fade at a mute's edges. */
export const JOIN_FADE_SECONDS = 0.01;
const CURVE_POINTS = 64;
const HELD_WINDOWS = 6;
/**
 * How often playback checks it has the next window coming, besides each
 * animation frame. WebKit stops animation frames for a window that is hidden
 * (behind Media Composer, say), and with only the frame loop asking for the
 * next window the sound stopped once what was scheduled ran out. A timer keeps
 * running there, if throttled to about a second, and a window is five.
 */
const FEED_MS = 500;

const segmentFrames = (segment: EditDocument["segments"][number]) => segment.kind === "gap" ? segment.frames : segment.out_frame - segment.in_frame;
/**
 * Whether a clip's own range plays a track: every track unless the clip was
 * cut with only some (a bite of one person), and not one that plays something
 * else here, or nothing, because it was edited alone.
 */
const clipPlays = (document: EditDocument, index: number, track: string) => {
  const segment = document.segments[index];
  return !segment || segment.kind !== "source" || ((!segment.tracks || segment.tracks.includes(track)) && !segment.overrides?.[track]);
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
      // Lanes that overwrite the same range share one voice.
      const others = new Map<string, { source: string; from: number; lanes: string[] }>();
      for (const [lane, over] of Object.entries(segment.overrides ?? {})) {
        if (over?.source == null) continue;
        const key = `${over.source}@${over.in_frame}`;
        const group = others.get(key) ?? { source: over.source, from: over.in_frame, lanes: [] };
        group.lanes.push(lane); others.set(key, group);
      }
      const windowOf = (frame: number) => Math.floor(frame / windowFrames) * windowFrames;
      for (let offset = 0; offset < length;) {
        const at = segment.in_frame + offset;
        // The block ends where the first of its ranges leaves its window.
        let next = Math.min(length, windowOf(at) + windowFrames - segment.in_frame);
        for (const other of others.values()) next = Math.min(next, windowOf(other.from + offset) + windowFrames - other.from);
        blocks.push({ program: program + offset, end: program + next, segment: index, source: segment.source, at, window: windowOf(at),
          joinIn: joinIn && offset === 0, joinOut: joinOut && next === length,
          ...(others.size ? { overrides: [...others.values()].map((other) => ({ source: other.source, at: other.from + offset, window: windowOf(other.from + offset), lanes: other.lanes })) } : {}) });
        offset = next;
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
 * program frame `from`, with that track's mutes cut out of them. `voice` is
 * the range played, when it is an override's rather than the block's own.
 */
export function trackPieces(document: EditDocument, block: EditBlock, trackId: string, from = block.program, voice: { source: string | null; at: number } = block): VoicePiece[] {
  if (voice.source === null) return [];
  const start = voice.at + Math.max(0, from - block.program), end = voice.at + block.end - block.program;
  const mutes = (mutesOf(document).get(`${voice.source}\n${trackId}`) ?? []).filter((mute) => mute.out_frame > start && mute.in_frame < end);
  // A segment join is a cut for this track only where its own material changes
  // there; where it carries straight on (another track was cut) it plays through.
  const joinIn = block.joinIn && !continuesAt(document, block.segment, trackId);
  const joinOut = block.joinOut && !continuesAt(document, block.segment + 1, trackId);
  const pieces: VoicePiece[] = [];
  let cursor = start, cursorKind: EdgeKind = joinIn && from <= block.program ? "join" : null;
  for (const mute of mutes) {
    if (mute.in_frame > cursor) pieces.push({ from: cursor, to: mute.in_frame, fadeIn: cursorKind, fadeOut: "mute" });
    if (mute.out_frame > cursor) { cursor = mute.out_frame; cursorKind = "mute"; }
  }
  if (cursor < end) pieces.push({ from: cursor, to: end, fadeIn: cursorKind, fadeOut: joinOut ? "join" : null });
  return pieces;
}

const mutesIndex = new WeakMap<EditDocument, Map<string, EditDocument["mutes"]>>();
/**
 * A document's mutes by source and person, each list in order, built once per
 * document: a playback block asked for its own track's, and filtering every
 * mute for every track of every block was thousands of checks a block after
 * Strip Silence.
 */
function mutesOf(document: EditDocument) {
  let index = mutesIndex.get(document);
  if (!index) {
    index = new Map();
    for (const mute of document.mutes) {
      const key = `${mute.source}\n${mute.track}`, list = index.get(key);
      if (list) list.push(mute); else index.set(key, [mute]);
    }
    for (const list of index.values()) list.sort((a, b) => a.in_frame - b.in_frame);
    mutesIndex.set(document, index);
  }
  return index;
}

/** What a track plays across a segment, from which source frame and on which record track, or null where it plays nothing. */
function playOf(document: EditDocument, index: number, trackId: string) {
  const segment = document.segments[index];
  if (!segment || segment.kind !== "source") return null;
  const over = segment.overrides?.[trackId];
  const layer = segment.layers?.[trackId] ?? null;
  if (over) return over.source == null ? null : { source: over.source, from: over.in_frame, layer };
  return clipPlays(document, index, trackId) ? { source: segment.source, from: segment.in_frame, layer } : null;
}

/**
 * Whether a track runs straight on from segment `index - 1` into `index`:
 * the same source, from the frame where it stopped, on the same record track.
 * A segment boundary falls wherever ANY track was cut, and crossfading a
 * track that simply carries on there blends it with itself, a bump in level
 * the cut does not have (and the AAF, which joins it, does not either).
 */
export function continuesAt(document: EditDocument, index: number, trackId: string) {
  if (index <= 0 || index >= document.segments.length) return false;
  const before = playOf(document, index - 1, trackId), after = playOf(document, index, trackId);
  if (!before || !after) return false;
  return before.source === after.source && before.layer === after.layer && before.from + segmentFrames(document.segments[index - 1]) === after.from;
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
  for (const segment of document.segments) {
    if (segment.kind !== "source") continue;
    if (segment.source === source) extent = Math.max(extent, segment.out_frame);
    for (const over of Object.values(segment.overrides ?? {})) if (over?.source === source) extent = Math.max(extent, over.in_frame + segment.out_frame - segment.in_frame);
  }
  for (const mute of document.mutes) if (mute.source === source) extent = Math.max(extent, mute.out_frame);
  return extent;
}

export class EditAudio {
  /** Made again after a long silence, a device change or a stopped clock (audio-output.ts). */
  private output: AudioOutput;
  private get context(): AudioContext { return this.output.context; }
  private master!: GainNode;
  /**
   * Every track at unity, as Media Composer plays a sequence, through a
   * limiter so a pile-up of voices clips gently rather than hard. The mix used
   * to be divided by the number of people heard: about −26 dB with twenty, and
   * a little quieter each time someone new was cut in.
   */
  private mix!: GainNode;
  private limiter!: DynamicsCompressorNode;
  private trackLevels = new Map<string, GainNode>();
  /** The levels asked for, kept to rebuild a new output with. */
  private level: { volume: number; muted: boolean } | null = null;
  private levels = new Map<string, number>();
  private voices = new Set<AudioBufferSourceNode>();
  private caches = new Map<string, MultitrackAudioCache>();
  private cacheOf = new Map<string, string>();
  private held = new Map<string, Map<string, AudioBuffer>>();
  private document: EditDocument | null = null;
  private documentKey = "";
  private tracks: EditTrack[] = [];
  /** Record tracks silenced by solo and mute, and where each person sits when a clip does not say. */
  private quiet = new Set<number>();
  private homes = new Map<string, number>();
  private blocks: EditBlock[] = [];
  private total = 0;
  private readonly windowFrames: number;
  private request = 0;
  private fillRequest = -1;
  private closed = false;
  private timer = 0;
  private feeder = 0;
  private origin: { frame: number; time: number } | null = null;
  /** A J or L shuttle at a speed other than 1x forward: where and when it started, and the run it belongs to. */
  private shuttling: { rate: number; frame: number; time: number; request: number } | null = null;
  private scheduledUntil = 0;
  private grainState = idleScrubState();
  private scrubTimer = 0;
  private grainTimer = 0;
  private preparing: string | null = null;
  private resuming: Promise<void> | null = null;
  private state: EditAudioState = { frame: 0, rate: 0, busy: false, error: null };
  private joinFade = JOIN_FADE_SECONDS;
  private readonly fadeIn = equalPower(true);
  private readonly fadeOut = equalPower(false);

  constructor(private fps: number, private notify: (state: EditAudioState) => void) {
    this.windowFrames = Math.ceil(5 * fps);
    this.output = new AudioOutput("String Outs", (context) => this.wire(context));
  }

  /** The nodes every voice plays through, on a new output, with the levels asked for so far. */
  private wire(context: AudioContext) {
    for (const gain of this.trackLevels.values()) gain.disconnect();
    this.trackLevels.clear();
    this.master = context.createGain(); this.master.connect(context.destination);
    if (this.level) this.master.gain.value = this.level.muted ? 0 : this.level.volume;
    this.limiter = context.createDynamicsCompressor();
    this.limiter.threshold.value = -1; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002; this.limiter.release.value = 0.1;
    this.limiter.connect(this.master);
    this.mix = context.createGain(); this.mix.connect(this.limiter);
    context.onstatechange = () => {
      if (!this.closed && this.state.rate && context.state !== "running") this.fail(new Error("Audio output was interrupted. Press Play to resume."));
    };
  }

  /** Before anything sounds: an output idle a minute or more, or on a device that changed, is made again. */
  private freshen() {
    const reason = this.output.staleness();
    if (!reason) return;
    this.stopVoices();
    this.output.replace(reason);
  }

  /**
   * Replace the edit or the audible tracks. A playing edit keeps playing from
   * the same program frame. `quietLayers` are record tracks (1 for A1) that
   * solo or mute silence: a person sounds there only where they are on
   * another track.
   */
  setDocument(document: EditDocument, audibleTrackIds: string[], sourceFrames: Record<string, number> = {}, quietLayers: number[] = []) {
    const key = `${audibleTrackIds.join("|")}\n${JSON.stringify(sourceFrames)}\n${quietLayers.join("|")}`;
    if (document === this.document && key === this.documentKey) return;
    const playing = this.state.rate !== 0 || this.state.busy, frame = this.currentFrame();
    this.document = document; this.documentKey = key;
    const audible = new Set(audibleTrackIds);
    this.tracks = document.tracks.filter((track) => track.kind === "sound" && audible.has(track.id));
    this.quiet = new Set(quietLayers);
    // A person's patched track, numbered as String Outs numbers them (edit-new peopleOf), for clips from before layers.
    this.homes = new Map(document.tracks.filter((track) => track.kind === "sound" && track.featured !== false).map((track, index) => [track.id, index + 1]));
    this.blocks = planBlocks(document, this.windowFrames); this.total = programLength(document);
    const used = new Set<string>(); this.cacheOf.clear();
    for (const source of document.sources) {
      const cacheKey = `${source.document_id}|${sourceFrames[source.id] ?? sourceExtent(document, source.id)}`;
      if (!this.caches.has(cacheKey)) this.caches.set(cacheKey, new MultitrackAudioCache(source.document_id, this.fps, Number(cacheKey.split("|").at(-1)), () => this.context));
      this.cacheOf.set(source.id, cacheKey); used.add(cacheKey);
    }
    for (const [cacheKey, cache] of this.caches) if (!used.has(cacheKey)) { cache.clear(); this.caches.delete(cacheKey); }
    for (const heldKey of this.held.keys()) if (!used.has(heldKey.slice(0, heldKey.lastIndexOf("@")))) this.held.delete(heldKey);
    if (playing) void this.seek(frame, 1);
    else if (this.state.frame !== clampFrame(this.state.frame, this.total)) this.publish({ frame: clampFrame(this.state.frame, this.total) });
  }

  setLevel(volume: number, muted: boolean) { this.level = { volume, muted }; this.master.gain.value = muted ? 0 : volume; }
  /** Crossfade length at a cut, from View ▸ Audio; "Off" still keeps the 10 ms that stops a click. Takes effect from the next block scheduled. */
  setJoinFade(seconds = JOIN_FADE_SECONDS) { this.joinFade = Math.max(JOIN_FADE_SECONDS, seconds); }
  setTrackLevel(trackId: string, gain: number) { this.levels.set(trackId, clampTrackGain(gain)); this.trackGain(trackId).gain.value = clampTrackGain(gain); }

  toggle() {
    if (this.state.rate || this.state.busy) { this.pause(); return Promise.resolve(); }
    return this.seek(this.state.frame >= this.total - 1 ? 0 : this.state.frame, 1);
  }

  pause() { const frame = this.halt(true); this.publish({ frame, rate: 0, busy: false }); }

  /**
   * J and L, as Avid's shuttle and AAF Audio's: each press steps the ladder
   * (1, 2, 4, 8 times speed, and back down through 1 to the other way). Forward
   * at 1x is playback; any other speed moves the playhead at that rate and
   * plays a short grain of what passes under it, as scrubbing does. It used to
   * be that L only played and J stepped back a second.
   */
  shuttle(direction: 1 | -1) {
    const rate = nextShuttleRate(this.shuttling?.rate ?? this.state.rate, direction), frame = this.currentFrame();
    return rate === 1 ? this.seek(frame, 1) : this.runShuttle(frame, rate);
  }

  private async runShuttle(frame: number, rate: number) {
    this.halt(false);
    this.freshen();
    const request = ++this.request, target = clampFrame(frame, this.total);
    this.publish({ frame: target, rate, busy: false, error: null });
    try {
      if (this.context.state !== "running") await this.resumeOutput();
      if (request !== this.request || this.closed) return;
      this.shuttling = { rate, frame: target, time: this.context.currentTime, request };
      this.timer = requestAnimationFrame(this.shuttleTick);
    } catch (cause) { if (request === this.request && !this.closed) this.fail(cause); }
  }

  private shuttleTick = () => {
    const run = this.shuttling;
    if (!run || run.request !== this.request || this.closed) return;
    const frame = clampFrame(run.frame + (this.context.currentTime - run.time) * this.fps * run.rate, this.total);
    this.publish({ frame });
    if ((run.rate < 0 && frame <= 0) || (run.rate > 0 && frame >= this.total - 1)) { this.pause(); return; }
    const block = this.blocks[blockIndex(this.blocks, frame)];
    if (block && !this.ready(block)) void this.prepareShuttle(block, run.request); else this.grain(frame);
    this.timer = requestAnimationFrame(this.shuttleTick);
  };

  /** The window a shuttle has run into, read once; the shuttle carries on (silent) while it arrives. */
  private async prepareShuttle(block: EditBlock, request: number) {
    const key = this.heldKey(block);
    if (this.preparing === key) return;
    this.preparing = key;
    try { await this.buffersFor(block); } catch (cause) { if (request === this.request && !this.closed) this.fail(cause); }
    finally { if (this.preparing === key) this.preparing = null; }
  }

  /** Stop everything sounding and invalidate every run in flight; returns the frame it stopped on. */
  private halt(cancelPreparation: boolean) {
    const frame = this.currentFrame(); ++this.request;
    cancelAnimationFrame(this.timer); clearInterval(this.feeder); clearTimeout(this.scrubTimer); clearTimeout(this.grainTimer); this.stopVoices();
    this.origin = null; this.shuttling = null; this.grainState = idleScrubState(); this.preparing = null;
    if (cancelPreparation) for (const cache of this.caches.values()) cache.cancel();
    return frame;
  }

  close() {
    this.pause(); this.closed = true;
    for (const cache of this.caches.values()) cache.clear();
    this.caches.clear(); this.held.clear();
    for (const gain of this.trackLevels.values()) gain.disconnect();
    this.trackLevels.clear(); this.output.close();
  }

  /** Park at `frame` (rate 0, with a scrub grain when it is decoded) or play from it (any other rate plays forward at 1x). */
  async seek(frame: number, rate = 0, soundScrub = true) {
    // Preparation is kept: a re-plan or a nearby seek reuses reads in flight.
    this.halt(false);
    this.freshen();
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
    this.freshen();
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
    if (!gain) { gain = this.context.createGain(); gain.gain.value = this.levels.get(id) ?? 1; gain.connect(this.mix); this.trackLevels.set(id, gain); }
    return gain;
  }

  /** Whether solo or mute silences a person in a segment: the record track they sit on there is quiet. */
  private silenced(segment: number, trackId: string) {
    if (!this.quiet.size || !this.document) return false;
    const at = this.document.segments[segment];
    const layer = (at?.kind === "source" ? at.layers?.[trackId] : undefined) ?? this.homes.get(trackId);
    return layer != null && this.quiet.has(layer);
  }

  private rawFrame() { return this.origin ? this.origin.frame + Math.max(0, this.context.currentTime - this.origin.time) * this.fps : this.state.frame; }
  private currentFrame() {
    if (!this.state.rate || this.state.busy || !this.origin) return this.state.frame;
    // Never report a frame whose sound has not been scheduled.
    return clampFrame(Math.min(this.rawFrame(), this.scheduledUntil), this.total);
  }

  /** Every range a block plays: its own clip first, then each override's. A gap plays none. */
  private rangesOf(block: EditBlock): Voice[] {
    if (!block.source) return [];
    return [{ source: block.source, at: block.at, window: block.window, lanes: null }, ...(block.overrides ?? [])];
  }
  /** AAF track ids the audible tracks read in `source`; for an override, only its lanes'. */
  private mics(source: string, lanes: string[] | null = null) {
    return [...new Set(this.tracks.filter((track) => !lanes || lanes.includes(track.id)).map((track) => track.source_tracks[source]).filter((id): id is string => !!id))];
  }
  private heldKey(voice: { source: string | null; window: number }) { return `${voice.source ? this.cacheOf.get(voice.source) ?? "" : ""}@${voice.window}`; }
  private ready(block: EditBlock | undefined) {
    if (!block?.source) return true;
    return this.rangesOf(block).every((voice) => {
      const held = this.held.get(this.heldKey(voice));
      return this.mics(voice.source, voice.lanes).every((id) => held?.has(id));
    });
  }
  /** Each voice's decoded mics, in `voices(block)` order. */
  private async buffersFor(block: EditBlock): Promise<Map<string, AudioBuffer>[]> {
    const out: Map<string, AudioBuffer>[] = [];
    for (const voice of this.rangesOf(block)) out.push(await this.voiceBuffers(voice));
    return out;
  }
  private async voiceBuffers(voice: Voice): Promise<Map<string, AudioBuffer>> {
    const cacheKey = this.cacheOf.get(voice.source), cache = cacheKey ? this.caches.get(cacheKey) : undefined;
    const ids = this.mics(voice.source, voice.lanes);
    if (!cache || !ids.length) return new Map();
    const key = this.heldKey(voice), held = this.held.get(key);
    if (held && ids.every((id) => held.has(id))) return held;
    const buffers = await cache.get(ids, voice.at);
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
      if (restart) {
        cancelAnimationFrame(this.timer); this.timer = requestAnimationFrame(this.tick);
        clearInterval(this.feeder); this.feeder = window.setInterval(this.keepFed, FEED_MS);
      }
    }
  }

  private scheduleBlock(block: EditBlock, from: number, when: number, buffers: Map<string, AudioBuffer>[]) {
    if (!block.source || !this.document) return;
    this.rangesOf(block).forEach((voice, index) => {
      for (const track of this.tracks) {
        // The clip's own range plays the lanes nobody overrode; an override, its own lanes.
        if (voice.lanes ? !voice.lanes.includes(track.id) : !clipPlays(this.document!, block.segment, track.id)) continue;
        if (this.silenced(block.segment, track.id)) continue;
        const mic = track.source_tracks[voice.source], buffer = mic ? buffers[index]?.get(mic) : undefined;
        if (buffer) this.scheduleTrack(block, voice, track.id, buffer, from, when);
      }
    });
  }

  private scheduleTrack(block: EditBlock, voice: Voice, trackId: string, buffer: AudioBuffer, from: number, when: number) {
    const startSource = voice.at + from - block.program;
    for (const piece of trackPieces(this.document!, block, trackId, from, voice)) {
      const offset = (piece.from - voice.window) / this.fps, start = when + (piece.from - startSource) / this.fps;
      const length = Math.min((piece.to - piece.from) / this.fps, buffer.duration - offset);
      // A join is an equal-power crossfade centred on the cut: the outgoing
      // piece runs on into its handle and the incoming one starts early,
      // each as far as its decoded window (and the clock) allows.
      const handle = this.joinFade / 2;
      const pre = piece.fadeIn === "join" ? Math.max(0, Math.min(handle, offset, start - this.context.currentTime)) : 0;
      const post = piece.fadeOut === "join" ? Math.max(0, Math.min(handle, buffer.duration - offset - length)) : 0;
      this.voice(trackId, buffer, start - pre, offset - pre, length + pre + post, piece.fadeIn === "join" ? this.joinFade : piece.fadeIn ? JOIN_FADE_SECONDS : 0, piece.fadeOut === "join" ? this.joinFade : piece.fadeOut ? JOIN_FADE_SECONDS : 0);
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

  /**
   * Keeps the sound coming: asks for the next window when the playhead is
   * within one of the end of what is scheduled, and holds the playhead at the
   * edge when the next block is late. Runs on every animation frame and on a
   * timer (FEED_MS); false when playback is not running on.
   */
  private keepFed = (): boolean => {
    if (!this.state.rate || this.state.busy || this.closed || !this.origin) return false;
    // A clock that has stopped plays nothing and says nothing: make the output again and carry on.
    if (this.output.stalled()) {
      const frame = this.currentFrame();
      this.output.replace("its clock stopped while playing");
      void this.seek(frame, 1);
      return false;
    }
    this.output.touch();
    const raw = this.rawFrame();
    if (raw >= this.scheduledUntil) {
      if (this.scheduledUntil >= this.total) { this.pause(); return false; }
      // The next block is late: hold the playhead at the edge of the sound.
      this.origin = null; this.stopVoices();
      this.publish({ frame: clampFrame(this.scheduledUntil, this.total), busy: true });
      void this.fill(this.request);
      return false;
    }
    if (this.scheduledUntil - raw < this.windowFrames) void this.fill(this.request);
    return true;
  };

  private tick = () => {
    if (!this.keepFed()) return;
    this.publish({ frame: this.currentFrame() });
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
    const program = frame / this.fps, plan = planGrain(this.grainState, performance.now(), program, this.total / this.fps);
    if (!plan) return;
    this.output.touch();
    const when = this.context.currentTime;
    for (const voice of this.rangesOf(block)) {
      const held = this.held.get(this.heldKey(voice));
      if (!held) continue;
      const sourceFrame = voice.at + frame - block.program;
      const offset = Math.max(0, (sourceFrame - voice.window) / this.fps - (program - plan.offsetSec));
      for (const track of this.tracks) {
        if (voice.lanes ? !voice.lanes.includes(track.id) : !clipPlays(this.document, block.segment, track.id)) continue;
        if (this.silenced(block.segment, track.id)) continue;
        const mic = track.source_tracks[voice.source], buffer = mic ? held.get(mic) : undefined;
        if (!buffer) continue;
        if (this.document.mutes.some((mute) => mute.source === voice.source && mute.track === track.id && sourceFrame >= mute.in_frame && sourceFrame < mute.out_frame)) continue;
        const length = Math.min(plan.durationSec, buffer.duration - offset);
        if (length <= 0) continue;
        const source = this.context.createBufferSource(), gain = this.context.createGain(); source.buffer = buffer;
        source.connect(gain); gain.connect(this.trackGain(track.id));
        gain.gain.setValueCurveAtTime(grainEnvelope(plan.gain, length, Math.min(plan.fadeSec, length / 2)), when, length);
        this.start(source, gain, when, offset, length);
      }
    }
    this.grainState = { lastFiredAtMs: performance.now(), lastSourceSec: program };
  }
}
