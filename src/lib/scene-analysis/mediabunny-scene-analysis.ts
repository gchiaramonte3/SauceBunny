import {
  BlobSource,
  type Source,
  Input,
  MP4,
  VideoSampleSink,
} from 'mediabunny';
import {
  DEFAULT_DETECTOR_CONFIG,
  analysisDimensions,
  createBoundaryAccumulator,
  extractFrameFeatures,
  type DetectorConfig,
  type PublicDetectorConfig,
  type SceneBoundary,
} from './detector-core.js';

export interface SceneAnalysisConfig extends DetectorConfig {
  analysisWidth: number;
  analysisHeight: number;
  maximumTimelinePoints: number;
  progressIntervalMs: number;
  blobCacheBytes: number;
}

export const DEFAULT_SCENE_ANALYSIS_CONFIG: Readonly<SceneAnalysisConfig> = Object.freeze({
  ...DEFAULT_DETECTOR_CONFIG,
  analysisWidth: 160,
  analysisHeight: 90,
  maximumTimelinePoints: 2_000,
  progressIntervalMs: 100,
  blobCacheBytes: 8 * 1024 * 1024,
});

const DECODER_OPTIONS = { hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true } as const;

export type SceneAnalysisPhase = 'open' | 'decode' | 'detect';

export interface SceneAnalysisProgress {
  phase: SceneAnalysisPhase;
  progress: number;
  processed?: number;
  total?: number;
  label: string;
}

export interface TimelineScore {
  ptsUs: number;
  combined: number;
}

export interface SceneAnalysisResult {
  schemaVersion: 'ella.scene-analysis.v1';
  profile: 'mediabunny-full-frame';
  durationUs: number;
  boundaries: SceneBoundary[];
  timelineScores: TimelineScore[];
  source: {
    fileName: string;
    codec: string | null;
    width: number;
    height: number;
    frameCount: number;
  };
  analysis: {
    library: 'mediabunny';
    libraryVersion: '1.52.3';
    width: number;
    height: number;
    config: PublicDetectorConfig;
    peakRetainedFeatureFrames: number;
  };
  performance: {
    elapsedMs: number;
    framesPerSecond: number;
    realtimeMultiple: number;
  };
}

export interface AnalyzeSceneBoundariesOptions {
  file: File | Blob | { name: string; source: Source };
  config?: Partial<SceneAnalysisConfig>;
  signal?: AbortSignal;
  onProgress?: (progress: SceneAnalysisProgress) => void;
}

export type SceneAnalysisErrorCode =
  | 'ABORTED'
  | 'UNSUPPORTED_API'
  | 'NO_VIDEO'
  | 'UNSUPPORTED_CODEC'
  | 'PIPELINE_ERROR';

export class SceneAnalysisError extends Error {
  constructor(
    public readonly code: SceneAnalysisErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SceneAnalysisError';
  }
}

function compactTimelineScores(
  scores: readonly { combined: number }[],
  ptsUs: readonly number[],
  maximumPoints: number,
): TimelineScore[] {
  const pointLimit = Math.max(1, Math.floor(maximumPoints));
  if (scores.length <= pointLimit) {
    return scores.map((score, index) => ({ ptsUs: ptsUs[index] ?? 0, combined: score.combined }));
  }

  const bucketSize = Math.ceil(scores.length / pointLimit);
  const compact: TimelineScore[] = [];
  for (let start = 0; start < scores.length; start += bucketSize) {
    const end = Math.min(scores.length, start + bucketSize);
    let peakIndex = start;
    for (let index = start + 1; index < end; index += 1) {
      if (scores[index]!.combined > scores[peakIndex]!.combined) peakIndex = index;
    }
    compact.push({ ptsUs: ptsUs[peakIndex] ?? 0, combined: scores[peakIndex]!.combined });
  }
  return compact;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SceneAnalysisError('ABORTED', 'Scene analysis was cancelled.');
}

function assertWorkerCapabilities(): void {
  if (typeof VideoDecoder === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    throw new SceneAnalysisError(
      'UNSUPPORTED_API',
      'Full-frame analysis requires worker VideoDecoder and OffscreenCanvas support.',
    );
  }
}

function fileNameOf(file: AnalyzeSceneBoundariesOptions['file']): string {
  return 'name' in file && typeof file.name === 'string' ? file.name : 'video.mp4';
}

/**
 * Decode and score every presentation frame. Run this in a dedicated module worker;
 * decoded samples, pixels, and frame features intentionally never cross that boundary.
 */
export async function analyzeSceneBoundaries({
  file,
  config: overrides,
  signal,
  onProgress,
}: AnalyzeSceneBoundariesOptions): Promise<SceneAnalysisResult> {
  assertWorkerCapabilities();
  const config: SceneAnalysisConfig = { ...DEFAULT_SCENE_ANALYSIS_CONFIG, ...overrides };
  const startedAt = performance.now();
  const input = new Input({
    formats: [MP4],
    source: file instanceof Blob ? new BlobSource(file, { maxCacheSize: config.blobCacheBytes }) : file.source,
  });
  const abort = (): void => input.dispose();
  signal?.addEventListener('abort', abort, { once: true });

  try {
    throwIfAborted(signal);
    onProgress?.({ phase: 'open', progress: 0.02, label: 'Opening MP4 with MediaBunny' });

    const track = await input.getPrimaryVideoTrack();
    throwIfAborted(signal);
    if (!track) throw new SceneAnalysisError('NO_VIDEO', 'No video track was found.');
    if (!(await track.canDecode())) {
      const codecName = await track.getCodecParameterString();
      throw new SceneAnalysisError(
        'UNSUPPORTED_CODEC',
        `WebCodecs cannot decode ${codecName || 'this video codec'}.`,
      );
    }
    // canDecode probes the codec with default options. Probe the actual sink
    // configuration too so unavailable hardware is a typed codec error.
    const decoderConfig = await track.getDecoderConfig();
    if (!decoderConfig || !(await VideoDecoder.isConfigSupported({ ...decoderConfig, ...DECODER_OPTIONS })).supported) {
      throw new SceneAnalysisError('UNSUPPORTED_CODEC', 'The full-frame decoder configuration is unavailable in this browser.');
    }

    const [codec, width, height, durationSeconds, packetStats] = await Promise.all([
      track.getCodecParameterString(),
      track.getDisplayWidth(),
      track.getDisplayHeight(),
      track.computeDuration(),
      track.computePacketStats(),
    ]);
    throwIfAborted(signal);

    const dimensions = analysisDimensions(
      width,
      height,
      config.analysisWidth,
      config.analysisHeight,
    );
    const canvas = new OffscreenCanvas(dimensions.width, dimensions.height);
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!context) {
      throw new SceneAnalysisError('UNSUPPORTED_API', 'OffscreenCanvas 2D is unavailable.');
    }

    const detector = createBoundaryAccumulator(config);
    const framePtsUs: number[] = [];
    const total = packetStats.packetCount;
    let processed = 0;
    let lastProgressAt = 0;
    const sink = new VideoSampleSink(track, DECODER_OPTIONS);

    for await (const sample of sink.samples()) {
      try {
        throwIfAborted(signal);
        sample.draw(context, 0, 0, dimensions.width, dimensions.height);
        const image = context.getImageData(0, 0, dimensions.width, dimensions.height);
        const ptsUs = sample.microsecondTimestamp;
        framePtsUs.push(ptsUs);
        detector.push({
          ptsUs,
          durationUs: sample.microsecondDuration,
          features: extractFrameFeatures(image, dimensions.width, dimensions.height, config),
        });
        processed += 1;

        const now = performance.now();
        if (processed === 1 || processed === total || now - lastProgressAt >= config.progressIntervalMs) {
          lastProgressAt = now;
          onProgress?.({
            phase: 'decode',
            processed,
            total,
            progress: total ? 0.08 + 0.86 * processed / total : 0.08,
            label: `Decoded ${processed.toLocaleString()} of ${total.toLocaleString()} frames`,
          });
        }
      } finally {
        sample.close();
      }
    }

    throwIfAborted(signal);
    onProgress?.({ phase: 'detect', progress: 0.96, label: 'Finalizing boundaries' });
    const detection = detector.finalize();
    const elapsedMs = performance.now() - startedAt;
    const elapsedSeconds = Math.max(0.001, elapsedMs / 1_000);

    return {
      schemaVersion: 'ella.scene-analysis.v1',
      profile: 'mediabunny-full-frame',
      durationUs: Math.round(durationSeconds * 1_000_000),
      boundaries: detection.boundaries,
      timelineScores: compactTimelineScores(
        detection.scores,
        framePtsUs,
        config.maximumTimelinePoints,
      ),
      source: {
        fileName: fileNameOf(file),
        codec,
        width,
        height,
        frameCount: processed,
      },
      analysis: {
        library: 'mediabunny',
        libraryVersion: '1.52.3',
        width: dimensions.width,
        height: dimensions.height,
        config: detection.config,
        peakRetainedFeatureFrames: detection.diagnostics.peakRetainedFeatureFrames,
      },
      performance: {
        elapsedMs,
        framesPerSecond: processed / elapsedSeconds,
        realtimeMultiple: durationSeconds / elapsedSeconds,
      },
    };
  } catch (error) {
    if (signal?.aborted) {
      throw new SceneAnalysisError('ABORTED', 'Scene analysis was cancelled.', { cause: error });
    }
    if (error instanceof SceneAnalysisError) throw error;
    throw new SceneAnalysisError('PIPELINE_ERROR', `MediaBunny scene analysis failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  } finally {
    signal?.removeEventListener('abort', abort);
    input.dispose();
  }
}
