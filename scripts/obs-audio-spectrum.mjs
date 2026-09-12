// Oracle for generated 48 kHz stereo fixtures, not arbitrary user audio.
import assert from 'node:assert/strict';

export const tonePairs = [[440, 660], [880, 1320]];
const sampleRate = 48000;
const blockFrames = 4800; // 100 ms; all test frequencies have whole cycles.

export function verifyIsolatedStereo(pcm, pair) {
  assert(pair === 0 || pair === 1, 'Unknown generated tone pair');
  assert(pcm.length >= 5 * sampleRate * 8 && pcm.length % 8 === 0, 'Need five seconds of stereo float PCM');
  const frequencies = tonePairs.flat();
  const channels = [];
  for (let channel = 0; channel < 2; channel++) {
    // A 21 ms inserted silent block can still pass a 100 ms frequency test,
    // depending on its phase. Generated tones never contain sustained silence;
    // check decoded samples as well as frequency/channel identity.
    let quietFrames = 0, longestQuiet = 0, quietEndsAt = 0;
    for (let frame = 0; frame < pcm.length / 8; frame++) {
      const value = pcm.readFloatLE(frame * 8 + channel * 4);
      assert(Number.isFinite(value), 'Non-finite decoded audio');
      quietFrames = Math.abs(value) < 0.0001 ? quietFrames + 1 : 0;
      if (quietFrames > longestQuiet) { longestQuiet = quietFrames; quietEndsAt = frame + 1; }
    }
    const quietMs = longestQuiet * 1000 / sampleRate;
    const quietStart = (quietEndsAt - longestQuiet) / sampleRate;
    assert(longestQuiet < 240,
      `Selected tone interrupted in channel ${channel}: ${quietMs.toFixed(2)} ms near-silence at ${quietStart.toFixed(3)}s`);
    const wanted = pair * 2 + channel;
    let minimumWanted = Infinity;
    let maximumUnwanted = 0;
    for (let start = 0; start + blockFrames <= pcm.length / 8; start += blockFrames) {
      const magnitudes = frequencies.map(frequency => {
        let real = 0, imaginary = 0;
        for (let n = 0; n < blockFrames; n++) {
          const value = pcm.readFloatLE((start + n) * 8 + channel * 4);
          assert(Number.isFinite(value), 'Non-finite decoded audio');
          const phase = 2 * Math.PI * frequency * n / sampleRate;
          real += value * Math.cos(phase); imaginary += value * Math.sin(phase);
        }
        return 2 * Math.hypot(real, imaginary) / blockFrames;
      });
      minimumWanted = Math.min(minimumWanted, magnitudes[wanted]);
      maximumUnwanted = Math.max(maximumUnwanted, ...magnitudes.filter((_, index) => index !== wanted));
    }
    assert(minimumWanted > 0.004, `Selected tone missing, swapped or interrupted in channel ${channel}: ${minimumWanted}`);
    // Under 3% of the generated 0.01 amplitude, across every 100 ms block.
    assert(maximumUnwanted < 0.0003, `Other app/channel leaked into channel ${channel}: ${maximumUnwanted}`);
    channels.push({ channel, minimumWanted, maximumUnwanted, longestQuietMs: quietMs });
  }
  return channels;
}
