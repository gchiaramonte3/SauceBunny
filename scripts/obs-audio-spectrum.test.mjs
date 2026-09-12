import { expect, it } from 'vitest';
import { tonePairs, verifyIsolatedStereo } from './obs-audio-spectrum.mjs';

function generated(pair, { competing = false, swapped = false, silent = false, dropout = false, shortDropout = false } = {}) {
  const pcm = Buffer.alloc(5 * 48000 * 8);
  for (let n = 0; n < 5 * 48000; n++) for (let channel = 0; channel < 2; channel++) {
    const phase = 2 * Math.PI * n / 48000;
    let value = 0.01 * Math.sin(phase * tonePairs[pair][swapped ? 1 - channel : channel]);
    if (competing) value += 0.01 * Math.sin(phase * tonePairs[1 - pair][channel]);
    if (silent || (dropout && n >= 48000 && n < 52800) || (shortDropout && n >= 48000 && n < 49024)) value = 0;
    pcm.writeFloatLE(value, n * 8 + channel * 4);
  }
  return pcm;
}

it('accepts each distinct stereo positive control', () => {
  for (const pair of [0, 1]) expect(verifyIsolatedStereo(generated(pair), pair)).toHaveLength(2);
});
it('rejects a system mix containing both apps', () => {
  for (const pair of [0, 1]) expect(() => verifyIsolatedStereo(generated(pair, { competing: true }), pair)).toThrow('leaked');
});
it('rejects silence, swapped stereo and a single silent 100 ms interval', () => {
  for (const options of [{ silent: true }, { swapped: true }, { dropout: true }]) {
    expect(() => verifyIsolatedStereo(generated(0, options), 0)).toThrow(/missing, swapped or interrupted|tone interrupted/);
  }
});
it('rejects a 1024-sample dropout even when the 100 ms tone magnitude stays above its threshold', () => {
  for (const pair of [0, 1]) {
    expect(() => verifyIsolatedStereo(generated(pair, { shortDropout: true }), pair)).toThrow('21.33 ms near-silence');
  }
});
it('rejects empty/truncated/non-finite PCM instead of passing without samples', () => {
  expect(() => verifyIsolatedStereo(Buffer.alloc(0), 0)).toThrow('five seconds');
  const pcm = generated(0);
  expect(() => verifyIsolatedStereo(pcm.subarray(0, pcm.length - 1), 0)).toThrow('five seconds');
  pcm.writeFloatLE(NaN, 0);
  expect(() => verifyIsolatedStereo(pcm, 0)).toThrow('Non-finite');
});
