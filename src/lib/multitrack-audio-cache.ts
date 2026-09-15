import { invoke } from "@tauri-apps/api/core";
import type { AafAudioAsset } from "../bindings/AafAudioAsset";
import { assetUrl } from "./asset-url";
import { newJobId } from "./job-id";

/** Two five-second decoded windows, two native reads at a time. Pausing cancels
 * unfinished work but retains completed buffers for instant warm resumes. */
export class MultitrackAudioCache {
  private entries = new Map<string, Promise<AudioBuffer>>();
  private ready = new Set<string>();
  private jobs = new Map<string, { abort: AbortController; start: number }>();
  private windowTokens = new Map<number, symbol>();
  private windows: number[] = [];
  private revision = 0;
  private running = 0;
  private queue: Array<() => void> = [];
  readonly windowFrames: number;
  constructor(private documentId: string, fps: number, private duration: number, private context: AudioContext) { this.windowFrames = Math.ceil(5 * fps); }
  start(frame: number) { return Math.floor(frame / this.windowFrames) * this.windowFrames; }
  private setPendingJob(jobId: string, abort: AbortController, start: number) { this.jobs.set(jobId, { abort, start }); }
  private abortJob(jobId: string, abort: AbortController) { abort.abort(); void invoke("cancel_job", { jobId }).catch(() => {}); }
  cancel() {
    ++this.revision;
    for (const [jobId, { abort }] of this.jobs) this.abortJob(jobId, abort);
    for (const key of this.entries.keys()) if (!this.ready.has(key)) this.entries.delete(key);
  }
  clear() { this.cancel(); this.entries.clear(); this.ready.clear(); this.windows = []; this.windowTokens.clear(); }
  async get(trackIds: string[], frame: number): Promise<Map<string, AudioBuffer>> {
    const start = this.start(frame), revision = this.revision;
    if (!this.windowTokens.has(start)) this.windowTokens.set(start, Symbol());
    const token = this.windowTokens.get(start)!;
    this.windows = [...this.windows.filter((value) => value !== start), start];
    while (this.windows.length > 2) {
      const evicted = this.windows.shift();
      if (evicted !== undefined) this.windowTokens.delete(evicted);
      for (const [jobId, job] of this.jobs) if (job.start === evicted) this.abortJob(jobId, job.abort);
      for (const key of this.entries.keys()) if (key.startsWith(`${evicted}:`)) { this.entries.delete(key); this.ready.delete(key); }
    }
    const pairs = await Promise.all(trackIds.map(async (trackId): Promise<[string, AudioBuffer]> => {
      const key = `${start}:${trackId}`;
      let entry = this.entries.get(key);
      if (!entry) {
        entry = this.load(trackId, start, revision, token); this.entries.set(key, entry);
        void entry.then(() => { if (this.entries.get(key) === entry) this.ready.add(key); }, () => { if (this.entries.get(key) === entry) this.entries.delete(key); });
      }
      return [trackId, await entry];
    }));
    if (revision !== this.revision || this.windowTokens.get(start) !== token) throw new Error("Audio preparation cancelled");
    return new Map(pairs);
  }
  private async load(trackId: string, startFrame: number, revision: number, token: symbol) {
    if (this.running >= 2) await new Promise<void>((resolve) => this.queue.push(resolve)); else ++this.running;
    const jobId = newJobId(), abort = new AbortController();
    const stale = () => revision !== this.revision || abort.signal.aborted || this.windowTokens.get(startFrame) !== token;
    try {
      if (stale()) throw new Error("Audio preparation cancelled");
      this.setPendingJob(jobId, abort, startFrame);
      const asset = await invoke<AafAudioAsset>("aaf_prepare_audio", { documentId: this.documentId, trackId, startFrame,
        durationFrames: Math.min(this.windowFrames, this.duration - startFrame), jobId });
      if (stale()) throw new Error("Audio preparation cancelled");
      const response = await fetch(assetUrl(asset.path), { signal: abort.signal });
      if (!response.ok) throw new Error(`Prepared audio could not be read (${response.status})`);
      const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
      if (stale()) throw new Error("Audio preparation cancelled");
      return buffer;
    } finally { this.jobs.delete(jobId); const next = this.queue.shift(); if (next) next(); else --this.running; }
  }
}
