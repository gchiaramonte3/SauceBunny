import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  DEFAULT_DETECTOR_CONFIG,
  analysisDimensions,
  buildScenes,
  compareFrameFeatures,
  createBoundaryAccumulator,
  detectBoundaries,
  extractFrameFeatures,
  formatTimestamp,
  type FrameFeatures,
  type FrameObservation,
} from './detector-core';

type RGB = readonly [number, number, number];

function solidFrame(
  red: number,
  green: number,
  blue: number,
  width = 16,
  height = 9,
): FrameFeatures {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = red;
    data[index * 4 + 1] = green;
    data[index * 4 + 2] = blue;
    data[index * 4 + 3] = 255;
  }
  return extractFrameFeatures(data, width, height);
}

function timeline(
  colors: readonly RGB[],
  framesPerColor = 45,
  frameDurationUs = 33_333,
): FrameObservation[] {
  const frames: FrameObservation[] = [];
  let index = 0;
  for (const color of colors) {
    const features = solidFrame(...color);
    for (let count = 0; count < framesPerColor; count += 1) {
      frames.push({ ptsUs: index * frameDurationUs, durationUs: frameDurationUs, features });
      index += 1;
    }
  }
  return frames;
}

test('analysis dimensions preserve aspect ratio without upscaling', () => {
  assert.deepEqual(analysisDimensions(1920, 1080), { width: 160, height: 90 });
  assert.deepEqual(analysisDimensions(80, 60), { width: 80, height: 60 });
});

test('production default sensitivity is 95', () => {
  assert.equal(DEFAULT_DETECTOR_CONFIG.sensitivity, 95);
});

test('streaming detection retains a bounded feature window', () => {
  const accumulator = createBoundaryAccumulator();
  const frames = timeline([[20, 60, 220], [240, 90, 30]], 300);
  for (const frame of frames) accumulator.push(frame);
  const result = accumulator.finalize();
  assert.ok(result.diagnostics.peakRetainedFeatureFrames < 80);
  assert.deepEqual(result.boundaries.map((boundary) => boundary.afterFrameIndex), [300]);
});

test('identical frames score zero and distances stay bounded', () => {
  const blue = solidFrame(20, 60, 220);
  const same = compareFrameFeatures(blue, blue);
  const orange = compareFrameFeatures(blue, solidFrame(240, 90, 30));
  assert.equal(same.combined, 0);
  assert.ok(orange.combined > 0.2);
  assert.ok(orange.combined <= 1);
  assert.ok(orange.histogram <= 1);
});

test('persistent visual changes produce exact boundary PTS', () => {
  const frames = timeline([[20, 60, 220], [240, 90, 30], [30, 180, 120]]);
  const result = detectBoundaries(frames, { sensitivity: 95, minimumShotUs: 250_000 });
  assert.deepEqual(
    result.boundaries.map((boundary) => boundary.afterPtsUs),
    [45, 90].map((frame) => frame * 33_333),
  );
  assert.deepEqual(result.boundaries.map((boundary) => boundary.afterFrameIndex), [45, 90]);
  assert.ok(result.boundaries.every((boundary) => boundary.origin === 'machine'));
});

test('one-frame return is flagged and can be suppressed', () => {
  const frames = timeline([[40, 80, 130]], 90);
  frames[45] = { ...frames[45]!, features: solidFrame(255, 255, 255) };
  const visible = detectBoundaries(frames, { suppressFlashes: false, minimumShotUs: 0 });
  assert.equal(visible.boundaries.length, 1);
  assert.deepEqual(visible.boundaries[0]!.flags, ['flashSuspected']);
  const suppressed = detectBoundaries(frames, { suppressFlashes: true, minimumShotUs: 0 });
  assert.equal(suppressed.boundaries.length, 0);
});

test('a two-frame flash is suppressed from either edge', () => {
  const frames = timeline([[35, 70, 120]], 90);
  frames[45] = { ...frames[45]!, features: solidFrame(255, 255, 255) };
  frames[46] = { ...frames[46]!, features: solidFrame(255, 255, 255) };
  const suppressed = detectBoundaries(frames, { suppressFlashes: true, minimumShotUs: 0 });
  assert.equal(suppressed.boundaries.length, 0);
});

test('smooth color ramps do not turn histogram crossings into hard cuts', () => {
  const frames: FrameObservation[] = [];
  for (let index = 0; index < 90; index += 1) {
    const ramp = Math.max(0, Math.min(1, (index - 30) / 30));
    const color: RGB = [
      Math.round(40 + ramp * 100),
      Math.round(150 - ramp * 90),
      Math.round(120 + ramp * 30),
    ];
    frames.push({
      ptsUs: index * 33_333,
      durationUs: 33_333,
      features: solidFrame(...color),
    });
  }
  const result = detectBoundaries(frames, { sensitivity: 95, minimumShotUs: 0 });
  assert.equal(result.boundaries.length, 0);
});

test('out-of-order batch input is normalized by presentation timestamp', () => {
  const frames = timeline([[20, 60, 220], [240, 90, 30]]);
  const shuffled = [...frames.slice(45), ...frames.slice(0, 45)];
  const result = detectBoundaries(shuffled, { minimumShotUs: 0 });
  assert.deepEqual(result.boundaries.map((boundary) => boundary.afterFrameIndex), [45]);
});

test('scene construction and timestamps are stable', () => {
  const boundaries = [
    { id: 'a', afterPtsUs: 2_000_000 },
    { id: 'b', afterPtsUs: 4_500_000 },
  ];
  const scenes = buildScenes(boundaries, 7_000_000);
  assert.deepEqual(scenes.map(({ startUs, endUs }) => [startUs, endUs]), [
    [0, 2_000_000],
    [2_000_000, 4_500_000],
    [4_500_000, 7_000_000],
  ]);
  assert.equal(scenes[1]!.boundaryBefore?.id, 'a');
  assert.equal(scenes[1]!.boundaryAfter?.id, 'b');
  assert.equal(formatTimestamp(4_500_000), '00:04.500');
  assert.equal(formatTimestamp(3_723_004_000), '01:02:03.004');
});
