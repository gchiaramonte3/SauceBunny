import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyFlashSync } from './obs-av-sync.mjs';

function fixture(offset = 0, missing = false) {
  const pictures = Array.from({ length: 210 }, (_, frame) => ({
    time: frame / 30, brightness: frame % 30 < 3 ? 235 : 16,
  }));
  const pcm = Buffer.alloc(7 * 48000 * 8);
  for (let frame = 0; frame < 7 * 48000; frame++) {
    const time = frame / 48000 - offset;
    for (let channel = 0; channel < 2; channel++) {
      const audible = time >= 0 && time % 1 < .1 && !(missing && Math.floor(time) === 3);
      pcm.writeFloatLE(audible ? .04 * Math.sin(2 * Math.PI * (channel ? 660 : 440) * time) : 0,
        frame * 8 + channel * 4);
    }
  }
  return { pictures, pcm };
}
test('accepts aligned flashes/tones and sub-frame quantization', () => {
  for (const offset of [-.03, -.015, 0, .015, .03]) {
    const { pictures, pcm } = fixture(offset);
    assert.equal(verifyFlashSync(pictures, pcm).length, 2);
  }
});
test('rejects added audio latency even when A/V durations are identical', () => {
  const { pictures, pcm } = fixture(.128);
  assert.throws(() => verifyFlashSync(pictures, pcm), /misaligned/);
});
test('rejects missing pulses instead of matching only surviving ones', () => {
  const { pictures, pcm } = fixture(0, true);
  assert.throws(() => verifyFlashSync(pictures, pcm), /Missing interior/);
});
