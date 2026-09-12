// Oracle for the generated 1 Hz white flash + stereo tone-burst fixture.
// Packet continuity alone cannot prove that the picture matches the sound.
import assert from 'node:assert/strict';

export function verifyFlashSync(pictures, pcm, audioStart = 0) {
  assert(pictures.length >= 150 && pcm.length >= 5 * 48000 * 8 && pcm.length % 8 === 0,
    'Need at least five seconds of generated picture and stereo PCM');
  const flashes = [];
  let wasBright = false, previousTime = -Infinity;
  for (const { time, brightness } of pictures) {
    assert(Number.isFinite(time) && time > previousTime && Number.isFinite(brightness));
    previousTime = time;
    const bright = brightness > 160;
    if (bright && !wasBright) flashes.push(time);
    wasBright = bright;
  }
  const results = [];
  for (let channel = 0; channel < 2; channel++) {
    const bursts = [];
    let wasAudible = false;
    for (let start = 0; start + 240 <= pcm.length / 8; start += 240) {
      let energy = 0;
      for (let frame = start; frame < start + 240; frame++) {
        const value = pcm.readFloatLE(frame * 8 + channel * 4);
        assert(Number.isFinite(value), 'Non-finite decoded audio');
        energy += value * value;
      }
      const audible = Math.sqrt(energy / 240) > .008;
      if (audible && !wasAudible) bursts.push(audioStart + start / 48000);
      wasAudible = audible;
    }
    // Ignore start-up/last partial pulses, not any complete interior pulse.
    const interior = times => times.filter(time => time >= 1 && time < 6);
    const pictureTimes = interior(flashes), audioTimes = interior(bursts);
    assert(pictureTimes.length >= 5 && audioTimes.length >= 5,
      `Missing interior A/V pulses: ${pictureTimes.length} picture, ${audioTimes.length} audio`);
    // Match against the complete other track. A small valid negative offset
    // can put its corresponding pulse just before the interior start boundary.
    const match = (times, candidates) => {
      const indices = times.map(time => {
        let nearest = -1;
        for (let index = 0; index < candidates.length; index++) {
          if (nearest < 0 || Math.abs(candidates[index] - time) < Math.abs(candidates[nearest] - time)) nearest = index;
        }
        assert(nearest >= 0 && Math.abs(candidates[nearest] - time) < .5, 'Missing interior A/V pulse');
        return nearest;
      });
      assert.equal(new Set(indices).size, indices.length, 'Duplicate A/V pulse match');
      return times.map((time, index) => (candidates[indices[index]] - time) * 1000);
    };
    const offsets = [...match(pictureTimes, bursts), ...match(audioTimes, flashes).map(offset => -offset)];
    const worstMs = Math.max(...offsets.map(Math.abs));
    assert(worstMs <= 2000 / 30, `Picture/audio misaligned in channel ${channel}: ${worstMs.toFixed(1)} ms`);
    results.push({ channel, offsetsMs: offsets, worstMs });
  }
  return results;
}
