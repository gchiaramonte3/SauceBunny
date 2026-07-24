/**
 * Timeline audio waveform lane — peak extraction + downsampling math.
 *
 * The pure bucket math (`createPeakBuckets` / `foldPeaks`) is kept free of
 * any decode so it unit-tests with synthetic PCM. `extractWaveformPeaks`
 * streams the audio track through mediabunny's `AudioBufferSink` and folds
 * each decoded chunk straight into the buckets — no staging buffer, so a
 * multi-hour file never holds its full PCM in memory (unlike the Whisper
 * WAV path in `mediabunny-audio.ts`, which must keep the samples).
 *
 * Sample-rate note: WebCodecs decoders always emit at the track's native
 * rate — mediabunny has no "decode at 8kHz" fast path — so the compute cost
 * is (a) the native AAC/Opus decode, which runs many× realtime, plus (b) one
 * linear pass over the samples (~0.7s per hour of 48kHz stereo on Apple
 * Silicon; measured in waveform.test.ts). Bucket count doesn't change the
 * cost — it's purely display resolution.
 *
 * This opens its own `Input` rather than sharing the filmstrip's: the two
 * decode DIFFERENT tracks (video frames vs audio samples), so no sample is
 * ever decoded twice — the only shared cost is the container/moov parse,
 * which is a couple of range reads. Sharing would mean refactoring
 * `extractFilmstrip`'s lifecycle for no measurable win.
 */
import { Input, ALL_FORMATS, AudioBufferSink } from "mediabunny";
import { mediabunnySource } from "./mediabunny-source";

/** Min/max sample value per time bucket, index-aligned across the duration. */
export type WaveformPeaks = {
  /** Per-bucket minimum sample in [-1, 0]. */
  mins: Float32Array;
  /** Per-bucket maximum sample in [0, 1]. */
  maxs: Float32Array;
};

/**
 * Buckets across the full duration. ~1500 gives ≥1 bucket per CSS pixel on
 * any realistic timeline width (the draw pass aggregates buckets per pixel
 * column), and the peaks arrays stay tiny (2 × 1500 × 4 bytes = 12 KB).
 */
export const WAVEFORM_BUCKETS = 1500;

/** Zeroed peak buckets — untouched buckets render as silence. */
export function createPeakBuckets(count: number): WaveformPeaks {
  return { mins: new Float32Array(count), maxs: new Float32Array(count) };
}

/**
 * Fold one PCM chunk into the peak buckets. The chunk's first sample sits at
 * `chunkStartSec` on a `durationSec`-long timeline; each sample lands in the
 * bucket covering its absolute time. Samples outside [0, duration) are
 * dropped (a decoder can overshoot the container duration by a frame).
 * Call once per channel — min/max fold across channels for free.
 */
export function foldPeaks(
  peaks: WaveformPeaks,
  samples: Float32Array,
  sampleRate: number,
  chunkStartSec: number,
  durationSec: number,
): void {
  const count = peaks.mins.length;
  if (count === 0 || !(durationSec > 0) || !(sampleRate > 0)) return;
  const bucketsPerFrame = count / (durationSec * sampleRate);
  const baseFrame = chunkStartSec * sampleRate;
  const { mins, maxs } = peaks;
  for (let i = 0; i < samples.length; i++) {
    const b = Math.floor((baseFrame + i) * bucketsPerFrame);
    if (b < 0 || b >= count) continue;
    const s = samples[i];
    if (s < mins[b]) mins[b] = s;
    if (s > maxs[b]) maxs[b] = s;
  }
}

/**
 * Bounded-Map insert with insertion-order LRU eviction. A `Map` iterates in
 * insertion order, so delete+set makes `key` the newest entry (refreshing its
 * recency when it already exists) and the first key is always the oldest.
 * Route cache HITS through this too (re-setting the value just read) so the
 * entry for the currently-displayed source is always the newest and never the
 * eviction victim. Shared by the peaks cache below and the filmstrip cache in
 * `Timeline.tsx`; both hold plain data (Float32Arrays / data-URL strings), so
 * evicting is just dropping the reference — nothing to close or revoke.
 */
export function lruSet<K, V>(cache: Map<K, V>, key: K, value: V, max: number): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size <= max) return;
  for (const oldest of cache.keys()) {
    cache.delete(oldest); // deleting the current key mid-iteration is spec-safe
    if (cache.size <= max) return;
  }
}

/**
 * In-memory peaks cache, keyed by source path (bucket count is fixed, so the
 * path alone identifies the result). Module-level — survives Timeline
 * remounts, dies with the window, mirroring the filmstrip's in-memory-only
 * caching (the filmstrip never persists to disk, so neither do we).
 * `null` = probed and has no decodable audio track (cached so reopening an
 * audio-less video doesn't re-probe); decode ERRORS are not cached.
 * LRU-bounded to `PEAKS_CACHE_MAX` sources so a session that hops across many
 * files can't grow it without limit (~12 KB of Float32 per entry → ≤ ~200 KB;
 * cheap `null` entries share the same cap rather than tracking two counts).
 */
const PEAKS_CACHE_MAX = 16;
const peaksCache = new Map<string, WaveformPeaks | null>();

/**
 * Decode the audio track of a local file and reduce it to min/max peaks.
 * Returns `null` when the file has no audio track, the codec can't be
 * decoded here, the signal aborts, or any decode error occurs — the caller
 * simply renders no waveform. Honours `signal` per decoded chunk so an
 * in-flight pass is abandoned promptly when the source changes.
 */
export async function extractWaveformPeaks(
  localPath: string,
  opts?: { buckets?: number; signal?: AbortSignal },
): Promise<WaveformPeaks | null> {
  const cached = peaksCache.get(localPath);
  if (cached !== undefined) {
    lruSet(peaksCache, localPath, cached, PEAKS_CACHE_MAX); // hit → newest
    return cached;
  }

  // Read through the shared range-reader, not asset://. Tauri's asset handler
  // is a synchronous closure on the WKWebView main thread that caps each
  // response at 1 MiB, and mediabunny re-issues a whole new request whenever a
  // range is capped — so draining a long audio track this way meant one
  // main-thread scheme task per megabyte, contending with the player's own
  // reads. Every other local read already goes through mediabunnySource.
  const input = new Input({ source: mediabunnySource(localPath), formats: ALL_FORMATS });
  try {
    const at = await input.getPrimaryAudioTrack();
    if (!at || !(await at.canDecode())) {
      lruSet(peaksCache, localPath, null, PEAKS_CACHE_MAX);
      return null;
    }
    const durationSec = await input.computeDuration();
    if (!(durationSec > 0)) {
      lruSet(peaksCache, localPath, null, PEAKS_CACHE_MAX);
      return null;
    }
    const peaks = createPeakBuckets(opts?.buckets ?? WAVEFORM_BUCKETS);
    const sink = new AudioBufferSink(at);
    for await (const { buffer, timestamp } of sink.buffers()) {
      if (opts?.signal?.aborted) return null; // abandoned — don't cache a partial
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        foldPeaks(peaks, buffer.getChannelData(ch), buffer.sampleRate, timestamp, durationSec);
      }
    }
    if (opts?.signal?.aborted) return null;
    lruSet(peaksCache, localPath, peaks, PEAKS_CACHE_MAX);
    return peaks;
  } catch {
    return null; // decode error → no waveform; a later retry may still succeed
  } finally {
    void input.dispose();
  }
}
