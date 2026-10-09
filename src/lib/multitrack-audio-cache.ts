import { pipelineInvoke } from "./pipeline";
import type { AafAudioAsset } from "../bindings/AafAudioAsset";
import { assetUrl } from "./asset-url";
import { newJobId } from "./job-id";
const invoke = pipelineInvoke("Audio");

/**
 * Two five-second decoded windows, two native reads at a time. A read that has
 * started always finishes: Pause, a scrub or a third window only stop waiting
 * for it, and its file lands in the native cache for the next request, which
 * is usually the same window (Play after Pause). Cancelled reads used to be
 * thrown away and rendered again. Reads still queued here are dropped, since
 * nothing has been spent on them; `clear` (another document) stops everything.
 */
export class MultitrackAudioCache {
  private entries = new Map<string, Promise<AudioBuffer>>();
  private ready = new Set<string>();
  private jobs = new Map<string, AbortController>();
  /** Reads that have reached the native side, by window and track. */
  private started = new Set<string>();
  private windowTokens = new Map<number, symbol>();
  private windows: number[] = [];
  private revision = 0;
  private running = 0;
  private queue: Array<() => void> = [];
  readonly windowFrames: number;
  /** `context` may be a getter: a player makes its output again after it goes stale (audio-output.ts), and decoding follows it. */
  private readonly contextOf: () => AudioContext;
  constructor(private documentId: string, fps: number, private duration: number, context: AudioContext | (() => AudioContext)) {
    this.windowFrames = Math.ceil(5 * fps);
    this.contextOf = typeof context === "function" ? context : () => context;
  }
  start(frame: number) { return Math.floor(frame / this.windowFrames) * this.windowFrames; }
  private setPendingJob(jobId: string, abort: AbortController, key: string) { this.jobs.set(jobId, abort); this.started.add(key); }
  /** Stop waiting: callers of `get` are told so, queued reads are dropped, and reads in flight finish. */
  cancel() {
    ++this.revision;
    // A request after this one must not be handed a queued read that is about to be dropped.
    for (const key of this.entries.keys()) if (!this.ready.has(key) && !this.started.has(key)) this.entries.delete(key);
  }
  clear() {
    ++this.revision;
    for (const [jobId, abort] of this.jobs) { abort.abort(); void invoke("cancel_job", { jobId }).catch(() => {}); }
    this.entries.clear(); this.ready.clear(); this.windows = []; this.windowTokens.clear();
  }
  async get(trackIds: string[], frame: number): Promise<Map<string, AudioBuffer>> {
    const start = this.start(frame), revision = this.revision;
    if (!this.windowTokens.has(start)) this.windowTokens.set(start, Symbol());
    const token = this.windowTokens.get(start)!;
    this.windows = [...this.windows.filter((value) => value !== start), start];
    while (this.windows.length > 2) {
      const evicted = this.windows.shift();
      if (evicted !== undefined) this.windowTokens.delete(evicted);
      for (const key of this.entries.keys()) if (key.startsWith(`${evicted}:`)) { this.entries.delete(key); this.ready.delete(key); }
    }
    const pairs = await Promise.all(trackIds.map(async (trackId): Promise<[string, AudioBuffer]> => {
      const key = `${start}:${trackId}`;
      let entry = this.entries.get(key);
      if (!entry) {
        entry = this.load(key, trackId, start, revision, token); this.entries.set(key, entry);
        void entry.then(() => { if (this.entries.get(key) === entry) this.ready.add(key); }, () => { if (this.entries.get(key) === entry) this.entries.delete(key); });
      }
      return [trackId, await entry];
    }));
    if (revision !== this.revision || this.windowTokens.get(start) !== token) throw new Error("Audio preparation cancelled");
    return new Map(pairs);
  }
  private async load(key: string, trackId: string, startFrame: number, revision: number, token: symbol) {
    if (this.running >= 2) await new Promise<void>((resolve) => this.queue.push(resolve)); else ++this.running;
    const jobId = newJobId(), abort = new AbortController();
    const evicted = () => abort.signal.aborted || this.windowTokens.get(startFrame) !== token;
    try {
      // Not started yet, and nobody is waiting any more: drop it.
      if (revision !== this.revision || evicted()) throw new Error("Audio preparation cancelled");
      this.setPendingJob(jobId, abort, key);
      const asset = await invoke<AafAudioAsset>("aaf_prepare_audio", { documentId: this.documentId, trackId, startFrame,
        durationFrames: Math.min(this.windowFrames, this.duration - startFrame), jobId });
      // A window nobody holds any more is not decoded; its file is on disk.
      if (evicted()) throw new Error("Audio preparation cancelled");
      const response = await fetch(assetUrl(asset.path), { signal: abort.signal });
      if (!response.ok) throw new Error(`Prepared audio could not be read (${response.status})`);
      const buffer = await this.contextOf().decodeAudioData(await response.arrayBuffer());
      if (evicted()) throw new Error("Audio preparation cancelled");
      return buffer;
    } finally { this.jobs.delete(jobId); this.started.delete(key); const next = this.queue.shift(); if (next) next(); else --this.running; }
  }
}
