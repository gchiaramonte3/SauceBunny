// Run only with generated test media (440 Hz left / 660 Hz right). This is a
// native integration gate, not a screen-capture test or a release build.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, stat, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { performance } from 'node:perf_hooks';
import { inspectRuntime } from './inspect-obs-runtime.mjs';

const run = promisify(execFile);
const [runtime, fixture] = process.argv.slice(2);
assert(runtime && fixture, 'usage: node scripts/verify-obs-probe.mjs <private-runtime> <generated-test-media>');
const root = fileURLToPath(new URL('../', import.meta.url));
const ffmpeg = join(root, 'src-tauri/binaries/ffmpeg-aarch64-apple-darwin');
const ffprobe = join(root, 'src-tauri/binaries/ffprobe-aarch64-apple-darwin');
const bundle = resolve(runtime);
const resultDir = await mkdtemp(join(tmpdir(), 'sauce-obs-proof-'));
const mediaFile = join(resultDir, 'output.mp4');
await stat(fixture);

// The private build must remain independent of the installed OBS UI and user
// plugins. Check all load commands, not merely the helper's direct dependencies.
const machOBinaries = inspectRuntime(bundle).components.length;
const health = await run(join(bundle, 'MacOS/saucebunny-obs-capture-health-tests'), [bundle], { timeout: 15000 });
assert(health.stdout.includes('Capture-health tests passed'), 'Native source-failure gate did not pass');
const exclusions = await run(join(bundle, 'MacOS/saucebunny-obs-region-exclusion-tests'), [bundle], { timeout: 15000 });
assert(exclusions.stdout.includes('parent-audio exclusion resolvers passed'), 'Native parent/overlay exclusion gate did not pass');
for (const [name, args] of [
  ['probe', [join(resultDir, 'missing-runtime')]],
  ['media-probe', [bundle, join(resultDir, 'missing-fixture')]],
  ['capture-probe', [bundle, 'com.avid.mediacomposer', '-1', '0']],
  ['capture-probe', [bundle, 'com.avid.mediacomposer', '1', '1', '0.9', '0', '1', '1']],
  ['capture-probe', [bundle, 'com.avid.mediacomposer', '1', '1', 'NaN', '0', '1', '1']],
  ['window-probe', ['com.avid.mediacomposer', 'not-a-pid']],
]) {
  await assert.rejects(run(join(bundle, `MacOS/saucebunny-obs-${name}`), args, { timeout: 5000 }),
    error => error.code === 2 && error.stdout === '', `${name} must reject invalid input without media output`);
}
const core = JSON.parse((await run(join(bundle, 'MacOS/saucebunny-obs-probe'), [bundle], { timeout: 15000 })).stdout);
assert.equal(core.engine, 'OBS');
assert.equal(core.version, '32.2.2-sauce-capture1');
assert.equal(core.capturedUserContent, false);
assert.equal(core.nv12Conversion, true);
assert(core.captureRegistered && core.outputRegistered && core.renderedFrames >= 15);

const startedAt = performance.now();
const child = spawn(join(bundle, 'MacOS/saucebunny-obs-media-probe'), [bundle, resolve(fixture)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let firstByteMs = null;
let diagnostics = '';
child.stdout.once('data', () => { firstByteMs = performance.now() - startedAt; });
child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-65536); });
const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
let exitCode;
try {
  await Promise.all([
    pipeline(child.stdout, createWriteStream(mediaFile, { flags: 'wx' })),
    new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => { exitCode = code; resolveExit(signal); });
    }),
  ]);
} catch (error) {
  child.kill('SIGKILL');
  throw error;
} finally { clearTimeout(timer); }
assert.equal(exitCode, 0, `media helper failed:\n${diagnostics}`);
assert(firstByteMs !== null && firstByteMs < 3000, `first bytes delayed: ${firstByteMs}`);
assert(!diagnostics.includes('Failed to set'), `unsupported encoder option:\n${diagnostics}`);
assert(diagnostics.includes('"started":true,"stopped":true,"code":0,"sourceValid":true'), diagnostics);

const metadata = JSON.parse((await run(ffprobe, ['-v', 'error', '-show_streams', '-show_packets',
  '-show_entries', 'stream=index,codec_name,profile,level,width,height,sample_rate,channels,has_b_frames,duration:packet=stream_index,pts_time,dts_time,duration_time,pos,flags',
  '-of', 'json', mediaFile], { maxBuffer: 4 * 1024 * 1024, timeout: 15000 })).stdout);
const video = metadata.streams.find(stream => stream.codec_name === 'h264');
const audio = metadata.streams.find(stream => stream.codec_name === 'aac');
assert(video && audio, 'missing encoded video or audio');
assert.equal(video.width, 1280); assert.equal(video.height, 720); assert.equal(video.has_b_frames, 0);
assert.equal(video.profile, 'Main'); assert.equal(video.level, 40);
assert.equal(audio.channels, 2); assert.equal(audio.sample_rate, '48000');
assert(Number(video.duration) >= 7 && Number(video.duration) <= 12);
const tailSkew = Math.abs(Number(video.duration) - Number(audio.duration));
assert(tailSkew < 0.1, `A/V tail skew ${tailSkew}s`);
for (const stream of [video, audio]) {
  const packets = metadata.packets.filter(packet => packet.stream_index === stream.index);
  assert(packets.length > 150, 'too few A/V packets');
  for (let i = 1; i < packets.length; i++) {
    const gap = Number(packets[i].dts_time) - Number(packets[i - 1].dts_time);
    // Empty-moov MP4 includes AAC encoder priming in the first video sample
    // (33.3 ms picture + 21.3 ms priming). Subsequent cadence stays 30 fps.
    const maxGap = stream === video && i === 1 ? 0.06 : 0.05;
    assert(gap > 0 && gap < maxGap, `non-contiguous ${stream.codec_name}: ${gap}s`);
    assert(Math.abs(gap - Number(packets[i - 1].duration_time)) < 0.00015,
      `packet gap/overlap in ${stream.codec_name}`);
  }
}
// The existing live-program queue drops only complete independent fragments.
// Prove every mdat containing picture starts with a keyframe before reusing it.
const file = await readFile(mediaFile);
let offset = 0;
let independentFragments = 0;
while (offset < file.length) {
  assert(offset + 8 <= file.length, 'truncated MP4 box header');
  const shortSize = file.readUInt32BE(offset);
  const size = shortSize === 1 ? Number(file.readBigUInt64BE(offset + 8)) : shortSize;
  const type = file.toString('ascii', offset + 4, offset + 8);
  assert(Number.isSafeInteger(size) && size >= 8 && offset + size <= file.length, 'invalid MP4 box extent');
  if (type === 'mdat') {
    assert(size <= 2 * 1024 * 1024, 'fragment exceeds the existing program queue limit');
    const firstPicture = metadata.packets.find(packet => packet.stream_index === video.index &&
      Number(packet.pos) >= offset && Number(packet.pos) < offset + size);
    if (firstPicture) {
      assert(firstPicture.flags.includes('K'), 'fragment starts with a dependent video frame');
      independentFragments++;
    }
  }
  offset += size;
}
assert(independentFragments >= 60, 'fewer than 60 independent short fragments');
const pcm = (await run(ffmpeg, ['-v', 'error', '-ss', '1', '-i', mediaFile, '-t', '5',
  '-map', '0:a:0', '-ac', '2', '-ar', '48000', '-f', 'f32le', 'pipe:1'],
{ encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, timeout: 15000 })).stdout;
assert(pcm.length >= 5 * 48000 * 2 * 4, 'not enough decoded stereo audio');
const amplitudes = [];
for (let channel = 0; channel < 2; channel++) {
  let minRms = Infinity;
  const samples = pcm.length / 8;
  for (let start = 0; start + 4800 <= samples; start += 4800) {
    let power = 0;
    for (let n = start; n < start + 4800; n++) power += pcm.readFloatLE(n * 8 + channel * 4) ** 2;
    minRms = Math.min(minRms, Math.sqrt(power / 4800));
  }
  assert(minRms > 0.01, `audio dropout/silence in channel ${channel}: ${minRms}`);
  const tones = [440, 660].map(frequency => {
    let real = 0, imaginary = 0;
    for (let n = 0; n < 48000; n++) {
      const value = pcm.readFloatLE(n * 8 + channel * 4);
      const phase = 2 * Math.PI * frequency * n / 48000;
      real += value * Math.cos(phase); imaginary += value * Math.sin(phase);
    }
    return 2 * Math.hypot(real, imaginary) / 48000;
  });
  assert(tones[channel] > 0.025 && tones[1 - channel] < 0.002, `stereo mismatch: ${tones}`);
  amplitudes.push({ channel, minRms, tones });
}
const picture = (await run(ffmpeg, ['-v', 'error', '-ss', '2', '-i', mediaFile, '-frames:v', '1',
  '-vf', 'scale=64:36', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
{ encoding: 'buffer', maxBuffer: 65536, timeout: 15000 })).stdout;
const mean = picture.reduce((sum, value) => sum + value, 0) / picture.length;
const variance = picture.reduce((sum, value) => sum + (value - mean) ** 2, 0) / picture.length;
assert(picture.length === 64 * 36 * 3 && mean > 8 && variance > 100, 'missing/blank decoded picture');
// Nonblank is insufficient: RGB bytes mislabeled as NV12 still produce a
// detailed, but green/striped, picture. Compare against decoded source frames.
// Allow the small asynchronous source-start offset, not a different image.
const reference = (await run(ffmpeg, ['-v', 'error', '-i', resolve(fixture), '-t', '5',
  '-an', '-vf', 'scale=64:36', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
{ encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, timeout: 15000 })).stdout;
// Keep every frame of this bounded five-second generated reference. Sampling
// at 4 fps drops valid matches and makes the image test depend on startup phase.
let imageMeanAbsoluteError = Infinity;
for (let start = 0; start + picture.length <= reference.length; start += picture.length) {
  let error = 0;
  for (let n = 0; n < picture.length; n++) error += Math.abs(picture[n] - reference[start + n]);
  imageMeanAbsoluteError = Math.min(imageMeanAbsoluteError, error / picture.length);
}
assert(imageMeanAbsoluteError < 12, `decoded picture differs from source: MAE ${imageMeanAbsoluteError}`);
console.log(JSON.stringify({ passed: true, engine: core.version, machOBinaries, independentFragments, firstByteMs,
  tailSkewMs: tailSkew * 1000, imageMeanAbsoluteError, audio: amplitudes, resultDir, capturedUserContent: false }, null, 2));
