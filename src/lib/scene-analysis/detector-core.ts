export interface DetectorConfig {
  gridColumns: number;
  gridRows: number;
  lumaBins: number;
  chromaBins: number;
  sensitivity: number;
  localWindowUs: number;
  localRadius: number;
  minimumShotUs: number;
  suppressFlashes: boolean;
  suppressGradualSpikes: boolean;
}

export type PublicDetectorConfig = Pick<
  DetectorConfig,
  | 'sensitivity'
  | 'localWindowUs'
  | 'localRadius'
  | 'minimumShotUs'
  | 'suppressFlashes'
  | 'suppressGradualSpikes'
>;

export interface FeatureLayout {
  gridColumns: number;
  gridRows: number;
  lumaBins: number;
  chromaBins: number;
  channelStride: number;
}

export interface FrameFeatures {
  histograms: Float32Array;
  luma: Uint8Array;
  meanLuma: number;
  width: number;
  height: number;
  layout: FeatureLayout;
}

export interface FrameObservation {
  ptsUs: number;
  durationUs: number;
  features: FrameFeatures;
}

export interface FrameScore {
  histogram: number;
  content: number;
  combined: number;
  lumaJump: number;
}

export type BoundaryFlag = 'flashSuspected' | 'gradualSuspected';

export interface BoundaryComponents {
  histogram: number;
  content: number;
  lumaJump: number;
  localBaseline: number;
  localThreshold: number;
  flashReturn: number | null;
  activeNeighborRatio: number;
  contextDrift: number;
}

export interface SceneBoundary {
  id: string;
  beforePtsUs: number;
  afterPtsUs: number;
  beforeFrameIndex: number;
  afterFrameIndex: number;
  type: 'cut';
  score: number;
  components: BoundaryComponents;
  flags: BoundaryFlag[];
  origin: 'machine';
}

export interface DetectorResult {
  boundaries: SceneBoundary[];
  scores: FrameScore[];
  config: PublicDetectorConfig;
  diagnostics: {
    peakRetainedFeatureFrames: number;
  };
}

export interface BoundaryAccumulator {
  push(frame: FrameObservation): void;
  finalize(): DetectorResult;
}

export interface BoundaryLike {
  afterPtsUs: number;
}

export interface Scene<TBoundary extends BoundaryLike = SceneBoundary> {
  id: string;
  startUs: number;
  endUs: number;
  boundaryBefore: TBoundary | null;
  boundaryAfter: TBoundary | null;
}

export const DEFAULT_DETECTOR_CONFIG: Readonly<DetectorConfig> = Object.freeze({
  gridColumns: 4,
  gridRows: 3,
  lumaBins: 16,
  chromaBins: 8,
  sensitivity: 95,
  localWindowUs: 1_000_000,
  localRadius: 2,
  minimumShotUs: 300_000,
  suppressFlashes: true,
  suppressGradualSpikes: true,
});

const ACTIVITY_RADIUS = 15;
const CONTEXT_RADIUS = 10;
const FLASH_RADIUS = 3;

const clampByte = (value: number): number => Math.max(0, Math.min(255, value));

export function analysisDimensions(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth = 160,
  maxHeight = 90,
): { width: number; height: number } {
  const width = Math.max(1, Number(sourceWidth) || maxWidth);
  const height = Math.max(1, Number(sourceHeight) || maxHeight);
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function extractFrameFeatures(
  imageData: ImageData | Uint8ClampedArray,
  width: number,
  height: number,
  options: Partial<DetectorConfig> = {},
): FrameFeatures {
  const config = { ...DEFAULT_DETECTOR_CONFIG, ...options };
  const { gridColumns, gridRows, lumaBins, chromaBins } = config;
  const pixels = imageData instanceof Uint8ClampedArray ? imageData : imageData.data;
  const channelStride = lumaBins + chromaBins * 2;
  const tileCount = gridColumns * gridRows;
  const histograms = new Float32Array(tileCount * channelStride);
  const tilePixels = new Uint32Array(tileCount);
  const luma = new Uint8Array(width * height);

  let meanLuma = 0;
  let pixelIndex = 0;
  for (let y = 0; y < height; y += 1) {
    const tileY = Math.min(gridRows - 1, Math.floor((y * gridRows) / height));
    for (let x = 0; x < width; x += 1) {
      const sourceIndex = pixelIndex * 4;
      const red = pixels[sourceIndex] ?? 0;
      const green = pixels[sourceIndex + 1] ?? 0;
      const blue = pixels[sourceIndex + 2] ?? 0;
      const luminance = (77 * red + 150 * green + 29 * blue) >> 8;
      const cb = clampByte(128 + (((blue - luminance) * 144) >> 8));
      const cr = clampByte(128 + (((red - luminance) * 183) >> 8));
      const tileX = Math.min(gridColumns - 1, Math.floor((x * gridColumns) / width));
      const tile = tileY * gridColumns + tileX;
      const base = tile * channelStride;
      const lumaIndex = base + Math.min(lumaBins - 1, (luminance * lumaBins) >> 8);
      const cbIndex = base + lumaBins + Math.min(chromaBins - 1, (cb * chromaBins) >> 8);
      const crIndex = base + lumaBins + chromaBins
        + Math.min(chromaBins - 1, (cr * chromaBins) >> 8);

      luma[pixelIndex] = luminance;
      meanLuma += luminance;
      tilePixels[tile] = (tilePixels[tile] ?? 0) + 1;
      histograms[lumaIndex] = (histograms[lumaIndex] ?? 0) + 1;
      histograms[cbIndex] = (histograms[cbIndex] ?? 0) + 1;
      histograms[crIndex] = (histograms[crIndex] ?? 0) + 1;
      pixelIndex += 1;
    }
  }

  for (let tile = 0; tile < tileCount; tile += 1) {
    const count = tilePixels[tile] || 1;
    const base = tile * channelStride;
    for (let index = 0; index < channelStride; index += 1) {
      const histogramIndex = base + index;
      histograms[histogramIndex] = (histograms[histogramIndex] ?? 0) / count;
    }
  }

  return {
    histograms,
    luma,
    meanLuma: meanLuma / Math.max(1, width * height) / 255,
    width,
    height,
    layout: { gridColumns, gridRows, lumaBins, chromaBins, channelStride },
  };
}

export function compareFrameFeatures(
  previous: FrameFeatures | undefined,
  current: FrameFeatures | undefined,
): FrameScore {
  if (!previous || !current) {
    return { histogram: 0, content: 0, combined: 0, lumaJump: 0 };
  }
  if (previous.histograms.length !== current.histograms.length) {
    throw new Error('Feature layouts do not match.');
  }

  const { gridColumns, gridRows, lumaBins, chromaBins, channelStride } = current.layout;
  const tileCount = gridColumns * gridRows;
  const tileDistances = new Float32Array(tileCount);

  for (let tile = 0; tile < tileCount; tile += 1) {
    const base = tile * channelStride;
    let lumaL1 = 0;
    let cbL1 = 0;
    let crL1 = 0;
    for (let index = 0; index < lumaBins; index += 1) {
      lumaL1 += Math.abs(
        (previous.histograms[base + index] ?? 0) - (current.histograms[base + index] ?? 0),
      );
    }
    for (let index = 0; index < chromaBins; index += 1) {
      cbL1 += Math.abs(
        (previous.histograms[base + lumaBins + index] ?? 0)
          - (current.histograms[base + lumaBins + index] ?? 0),
      );
      crL1 += Math.abs(
        (previous.histograms[base + lumaBins + chromaBins + index] ?? 0)
          - (current.histograms[base + lumaBins + chromaBins + index] ?? 0),
      );
    }
    tileDistances[tile] = 0.5 * (0.5 * lumaL1 + 0.25 * cbL1 + 0.25 * crL1);
  }

  const ordered = Array.from(tileDistances).sort((a, b) => a - b);
  const medianDistance = median(ordered);
  const upperQuartile = ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.75))]
    ?? medianDistance;
  const histogram = 0.62 * medianDistance + 0.38 * upperQuartile;

  const count = Math.min(previous.luma.length, current.luma.length);
  let contentDelta = 0;
  for (let index = 0; index < count; index += 1) {
    contentDelta += Math.abs((previous.luma[index] ?? 0) - (current.luma[index] ?? 0));
  }
  const content = contentDelta / Math.max(1, count) / 255;
  const lumaJump = Math.abs(previous.meanLuma - current.meanLuma);

  return {
    histogram,
    content,
    lumaJump,
    combined: 0.62 * histogram + 0.38 * content,
  };
}

function median(values: ArrayLike<number>): number {
  if (!values.length) return 0;
  const ordered = Array.from(values).sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]!
    : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

interface AdaptiveThreshold {
  baseline: number;
  mad: number;
  k: number;
  absoluteFloor: number;
  threshold: number;
}

interface FrameTiming {
  ptsUs: number;
  durationUs: number;
}

function robustThreshold(
  scores: readonly FrameScore[],
  frameIndex: number,
  frames: readonly FrameTiming[],
  config: DetectorConfig,
): AdaptiveThreshold {
  const centerPts = frames[frameIndex]!.ptsUs;
  const neighbors: number[] = [];

  let low = 1;
  let high = frames.length;
  const windowStart = centerPts - config.localWindowUs;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (frames[middle]!.ptsUs < windowStart) low = middle + 1;
    else high = middle;
  }
  const start = low;

  low = start;
  high = frames.length;
  const windowEnd = centerPts + config.localWindowUs;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (frames[middle]!.ptsUs <= windowEnd) low = middle + 1;
    else high = middle;
  }

  for (let index = start; index < low; index += 1) {
    if (index === frameIndex || Math.abs(index - frameIndex) <= config.localRadius) continue;
    neighbors.push(scores[index]!.combined);
  }

  const baseline = median(neighbors);
  const deviations = neighbors.map((value) => Math.abs(value - baseline));
  const mad = median(deviations);
  const normalizedSensitivity = Math.max(0, Math.min(100, config.sensitivity)) / 100;
  const k = 5.2 - 2.7 * normalizedSensitivity;
  const absoluteFloor = 0.22 - 0.13 * normalizedSensitivity;
  const robustScale = Math.max(0.008, 1.4826 * mad);
  return {
    baseline,
    mad,
    k,
    absoluteFloor,
    threshold: Math.max(absoluteFloor, baseline + k * robustScale),
  };
}

function isLocalMaximum(scores: readonly FrameScore[], index: number, radius: number): boolean {
  const score = scores[index]!.combined;
  const start = Math.max(1, index - radius);
  const end = Math.min(scores.length - 1, index + radius);
  for (let neighbor = start; neighbor <= end; neighbor += 1) {
    if (neighbor === index) continue;
    const neighborScore = scores[neighbor]!.combined;
    if (neighborScore > score + 1e-7) return false;
    if (Math.abs(neighborScore - score) <= 1e-7 && neighbor < index) return false;
  }
  return true;
}

function enforceMinimumShotDuration(
  boundaries: readonly SceneBoundary[],
  minimumShotUs: number,
): SceneBoundary[] {
  const selected: SceneBoundary[] = [];
  for (const boundary of boundaries) {
    const previous = selected.at(-1);
    if (!previous || boundary.afterPtsUs - previous.afterPtsUs >= minimumShotUs) {
      selected.push(boundary);
      continue;
    }
    if (boundary.score > previous.score) selected[selected.length - 1] = boundary;
  }
  return selected;
}

function publicConfig(config: DetectorConfig): PublicDetectorConfig {
  return {
    sensitivity: config.sensitivity,
    localWindowUs: config.localWindowUs,
    localRadius: config.localRadius,
    minimumShotUs: config.minimumShotUs,
    suppressFlashes: config.suppressFlashes,
    suppressGradualSpikes: config.suppressGradualSpikes,
  };
}

function evaluateCandidate(
  index: number,
  frames: readonly FrameTiming[],
  scores: readonly FrameScore[],
  features: ReadonlyMap<number, FrameFeatures>,
  config: DetectorConfig,
): SceneBoundary | null {
  const score = scores[index]!;
  const adaptive = robustThreshold(scores, index, frames, config);
  if (score.combined < adaptive.threshold || !isLocalMaximum(scores, index, config.localRadius)) {
    return null;
  }

  let flashReturn: number | null = null;
  const flags: BoundaryFlag[] = [];
  if (features.get(index - 1) && features.get(index + 1)) {
    const crossEdgeReturns: number[] = [];
    for (let left = 1; left <= FLASH_RADIUS; left += 1) {
      for (let right = 0; right <= FLASH_RADIUS; right += 1) {
        const leftFrame = features.get(index - left);
        const rightFrame = features.get(index + right);
        if (leftFrame && rightFrame && left + right >= 2) {
          crossEdgeReturns.push(compareFrameFeatures(leftFrame, rightFrame).combined);
        }
      }
    }
    if (crossEdgeReturns.length) flashReturn = Math.min(...crossEdgeReturns);
    const isFlashLike = flashReturn !== null
      && flashReturn < 0.075
      && score.combined > Math.max(0.2, flashReturn * 2.5)
      && score.lumaJump > 0.16;
    if (isFlashLike) flags.push('flashSuspected');
  }
  if (config.suppressFlashes && flags.includes('flashSuspected')) return null;

  const activityStart = Math.max(1, index - ACTIVITY_RADIUS);
  const activityEnd = Math.min(scores.length - 1, index + ACTIVITY_RADIUS);
  let activeNeighbors = 0;
  let neighborCount = 0;
  for (let neighbor = activityStart; neighbor <= activityEnd; neighbor += 1) {
    if (neighbor === index || Math.abs(neighbor - index) <= config.localRadius) continue;
    neighborCount += 1;
    if (scores[neighbor]!.combined > 0.0025) activeNeighbors += 1;
  }
  const activeNeighborRatio = activeNeighbors / Math.max(1, neighborCount);
  const preContextStart = features.get(Math.max(0, index - CONTEXT_RADIUS));
  const preContextEnd = features.get(index - 1);
  const postContextStart = features.get(index);
  const postContextEnd = features.get(Math.min(frames.length - 1, index + CONTEXT_RADIUS));
  const contextDrift = Math.max(
    compareFrameFeatures(preContextStart, preContextEnd).combined,
    compareFrameFeatures(postContextStart, postContextEnd).combined,
  );
  const isGradualSpike = score.combined < 0.5
    && score.lumaJump < 0.08
    && score.content < 0.08
    && (activeNeighborRatio > 0.34 || contextDrift > 0.1);
  if (isGradualSpike) flags.push('gradualSuspected');
  if (config.suppressGradualSpikes && isGradualSpike) return null;

  return {
    id: `cut-${frames[index]!.ptsUs}`,
    beforePtsUs: frames[index - 1]!.ptsUs,
    afterPtsUs: frames[index]!.ptsUs,
    beforeFrameIndex: index - 1,
    afterFrameIndex: index,
    type: 'cut',
    score: score.combined,
    components: {
      histogram: score.histogram,
      content: score.content,
      lumaJump: score.lumaJump,
      localBaseline: adaptive.baseline,
      localThreshold: adaptive.threshold,
      flashReturn,
      activeNeighborRatio,
      contextDrift,
    },
    flags,
    origin: 'machine',
  };
}

export function createBoundaryAccumulator(
  options: Partial<DetectorConfig> = {},
): BoundaryAccumulator {
  const config: DetectorConfig = { ...DEFAULT_DETECTOR_CONFIG, ...options };
  const frames: FrameTiming[] = [];
  const scores: FrameScore[] = [];
  const features = new Map<number, FrameFeatures>();
  const candidates: SceneBoundary[] = [];
  let nextCandidateIndex = 1;
  let finalized = false;
  let peakRetainedFeatureFrames = 0;

  const flush = (flushAll = false): void => {
    const lastIndex = frames.length - 1;
    const lastPtsUs = frames[lastIndex]?.ptsUs ?? 0;
    while (nextCandidateIndex < frames.length) {
      const index = nextCandidateIndex;
      const hasTimeContext = lastPtsUs - frames[index]!.ptsUs > config.localWindowUs;
      const hasFrameContext = lastIndex
        >= index + Math.max(ACTIVITY_RADIUS, CONTEXT_RADIUS, config.localRadius);
      if (!flushAll && (!hasTimeContext || !hasFrameContext)) break;

      const candidate = evaluateCandidate(index, frames, scores, features, config);
      if (candidate) candidates.push(candidate);
      nextCandidateIndex += 1;

      const oldestRequiredFeature = Math.max(0, nextCandidateIndex - CONTEXT_RADIUS);
      for (const featureIndex of features.keys()) {
        if (featureIndex >= oldestRequiredFeature) break;
        features.delete(featureIndex);
      }
    }
  };

  return {
    push(frame): void {
      if (finalized) throw new Error('Cannot add a frame after finalization.');
      const index = frames.length;
      const previous = frames[index - 1];
      if (previous && frame.ptsUs < previous.ptsUs) {
        throw new Error('Frames must be added in presentation order.');
      }

      const previousFeatures = features.get(index - 1);
      frames.push({ ptsUs: frame.ptsUs, durationUs: frame.durationUs });
      features.set(index, frame.features);
      scores.push(index === 0
        ? { histogram: 0, content: 0, combined: 0, lumaJump: 0 }
        : compareFrameFeatures(previousFeatures, frame.features));
      peakRetainedFeatureFrames = Math.max(peakRetainedFeatureFrames, features.size);
      flush(false);
    },
    finalize(): DetectorResult {
      if (!finalized) {
        flush(true);
        finalized = true;
        features.clear();
      }
      return {
        boundaries: enforceMinimumShotDuration(candidates, config.minimumShotUs),
        scores,
        config: publicConfig(config),
        diagnostics: { peakRetainedFeatureFrames },
      };
    },
  };
}

export function detectBoundaries(
  frames: readonly FrameObservation[],
  options: Partial<DetectorConfig> = {},
): DetectorResult {
  const accumulator = createBoundaryAccumulator(options);
  const orderedFrames = [...frames].sort((a, b) => a.ptsUs - b.ptsUs);
  for (const frame of orderedFrames) accumulator.push(frame);
  return accumulator.finalize();
}

export function buildScenes<TBoundary extends BoundaryLike>(
  boundaries: readonly TBoundary[],
  durationUs: number,
): Scene<TBoundary>[] {
  const endUs = Math.max(0, Number(durationUs) || 0);
  const cuts = [...boundaries]
    .filter((boundary) => boundary.afterPtsUs > 0 && boundary.afterPtsUs < endUs)
    .sort((a, b) => a.afterPtsUs - b.afterPtsUs);
  const scenes: Scene<TBoundary>[] = [];
  let startUs = 0;
  let boundaryBefore: TBoundary | null = null;
  cuts.forEach((boundary, index) => {
    scenes.push({
      id: `scene-${index + 1}`,
      startUs,
      endUs: boundary.afterPtsUs,
      boundaryBefore,
      boundaryAfter: boundary,
    });
    startUs = boundary.afterPtsUs;
    boundaryBefore = boundary;
  });
  scenes.push({
    id: `scene-${scenes.length + 1}`,
    startUs,
    endUs,
    boundaryBefore,
    boundaryAfter: null,
  });
  return scenes;
}

export function formatTimestamp(microseconds: number, includeMillis = true): string {
  const totalMs = Math.max(0, Math.round((Number(microseconds) || 0) / 1_000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1_000);
  const millis = totalMs % 1_000;
  const base = `${hours > 0 ? `${String(hours).padStart(2, '0')}:` : ''}`
    + `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return includeMillis ? `${base}.${String(millis).padStart(3, '0')}` : base;
}
