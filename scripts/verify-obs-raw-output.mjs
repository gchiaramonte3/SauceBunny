// Optional native gate. Generates its own media and uses private pipes only;
// no window discovery, capture permissions, audio monitoring or NDI sender.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyCoreBuild } from './obs-source-inputs.mjs';

const [runtimeArg, coreArg, ...extra] = process.argv.slice(2);
assert(runtimeArg && coreArg && !extra.length,
  'usage: node scripts/verify-obs-raw-output.mjs <private-runtime> <verified-core-build>');
const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = resolve(runtimeArg), core = resolve(coreArg);
verifyCoreBuild(core);
const output = await mkdtemp('/private/tmp/sauce-obs-raw-output-');
const run = promisify(execFile);
const executable = join(output, 'raw-output-tests');
const source = join(root, 'obs-sidecar');
await run('/usr/bin/xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-target', 'arm64-apple-macos14.0',
  '-I', join(source, 'include'), '-I', join(core, 'source/libobs'),
  '-I', join(core, 'source/.deps/obs-deps-2026-07-15-universal/include'),
  '-F', join(runtime, 'Frameworks'), '-framework', 'libobs', '-framework', 'AppKit', '-framework', 'ScreenCaptureKit',
  `-Wl,-rpath,${join(runtime, 'Frameworks')}`,
  ...['engine.mm', 'proof-output.mm', 'raw-output.mm', 'raw-output.test.mm'].map(file => join(source, file)),
  '-o', executable], { timeout: 120000, maxBuffer: 1024 * 1024 });
const ffmpeg = join(root, 'src-tauri/binaries/ffmpeg-aarch64-apple-darwin');
const fixture = join(output, 'generated.mp4');
const survivorFixture = join(output, 'survivor.mp4');
await run(ffmpeg, ['-v', 'error', '-n', '-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=30',
  '-f', 'lavfi', '-i', 'aevalsrc=0.18*sin(2*PI*440*t)|0.12*sin(2*PI*880*t):s=48000',
  '-t', '16', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', fixture],
{ timeout: 30000, maxBuffer: 1024 * 1024 });
await run(ffmpeg, ['-v', 'error', '-n', '-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=30',
  '-f', 'lavfi', '-i', 'aevalsrc=0.15*sin(2*PI*660*t)|0.10*sin(2*PI*1320*t):s=48000',
  '-t', '16', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', survivorFixture],
{ timeout: 30000, maxBuffer: 1024 * 1024 });
console.log(`Generated raw-output gate: ${output}`);
let result;
try {
  result = await run(executable, [runtime, fixture, survivorFixture, join(output, 'capture')],
    { timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
} catch (error) {
  await writeFile(join(output, 'native.log'), String(error.stderr ?? error));
  console.error(`Native raw-output gate failed; retained evidence at ${output}`);
  throw error;
}
await writeFile(join(output, 'native.log'), result.stderr);
const report = JSON.parse(result.stdout.trim());
assert.equal(report.passed, true);

// Independently parse the bytes, not the C++ reader's reported counters.
async function inspect(name, capture, broadcasts) {
  const bytes = await readFile(join(output, 'capture', name));
  assert(bytes.length > 64 && bytes.length < 64 * 1024 * 1024, 'Bounded populated raw recording required');
  let offset = 0;
  const tracks = new Map();
  while (offset < bytes.length) {
    assert(bytes.length - offset >= 64, 'No truncated header after stop');
    const header = bytes.subarray(offset, offset + 64);
    assert.equal(header.subarray(0, 4).toString(), 'SBR1');
    const kind = header[4];
    assert([1, 2].includes(kind));
    for (const index of [5, 6, 7, 58, 59, 60, 61, 62, 63]) assert.equal(header[index], 0);
    assert.equal(header.readBigUInt64BE(8), BigInt(capture));
    const generation = Number(header.readBigUInt64BE(16));
    assert(broadcasts.includes(generation), 'No stale broadcast generation');
    const timestamp = header.readBigUInt64BE(24);
    assert(timestamp > 0n);
    const size = header.readUInt32BE(32);
    if (kind === 1) {
      assert.deepEqual([header.readUInt32BE(36), header.readUInt32BE(40), header.readUInt32BE(44)], [320, 180, 1280]);
      assert.equal(size, 320 * 180 * 4);
      assert.equal(header.readUInt32BE(48), 0); assert.equal(header.readUInt32BE(52), 0); assert.equal(header.readUInt16BE(56), 0);
    } else {
      assert.deepEqual([header.readUInt32BE(36), header.readUInt32BE(40), header.readUInt32BE(44)], [0, 0, 0]);
      const frames = header.readUInt32BE(48);
      assert(frames > 0 && frames <= 4096);
      assert.equal(header.readUInt32BE(52), 48000); assert.equal(header.readUInt16BE(56), 2);
      assert.equal(size, frames * 8);
    }
    assert(offset + 64 + size <= bytes.length, 'No partial payload left on reusable channel');
    const key = `${generation}:${kind}`;
    const previous = tracks.get(key);
    if (previous) assert(timestamp > previous.last, 'Source timestamps must advance');
    if (kind === 2 && previous) {
      // Within one attempt, no dropped/duplicated audio is hidden by a simple
      // monotonic timestamp test. OBS timestamps round integer nanoseconds.
      const expected = previous.last + BigInt(Math.floor(previous.frames * 1e9 / 48000));
      assert(timestamp >= expected - 2n && timestamp <= expected + 2n, 'Audio timestamp discontinuity');
    }
    tracks.set(key, { count: (previous?.count ?? 0) + 1, first: previous?.first ?? timestamp, last: timestamp,
      frames: kind === 2 ? header.readUInt32BE(48) : 0 });
    offset += 64 + size;
  }
  for (const generation of broadcasts) for (const kind of [1, 2]) assert((tracks.get(`${generation}:${kind}`)?.count ?? 0) >= 5);
  if (broadcasts.length > 1) for (const kind of [1, 2]) {
    assert(tracks.get(`2:${kind}`).first > tracks.get(`1:${kind}`).last, 'Restart must not reset the source clock');
  }
  return [...tracks].map(([track, value]) => ({ track, ...value, first: String(value.first), last: String(value.last) }));
}
const raw = await inspect('raw.sbr', 11, [1, 2]);
const recovered = await inspect('fresh.sbr', 11, [4]);
const survivor = await inspect('survivor.sbr', 22, [1]);
const captured = await readFile(join(output, 'capture/first-frame.bgra'));
const expected = (await run(ffmpeg, ['-v', 'error', '-i', fixture, '-frames:v', '1',
  '-vf', 'crop=320:180:160:90,format=bgra', '-f', 'rawvideo', 'pipe:1'],
{ encoding: 'buffer', maxBuffer: 1024 * 1024, timeout: 10000 })).stdout;
assert.equal(captured.length, expected.length);
let difference = 0;
for (let index = 0; index < captured.length; index++) difference += Math.abs(captured[index] - expected[index]);
const imageError = difference / captured.length;
assert(imageError < 12, `Raw crop/color mismatch: ${imageError}`);
async function inspectAudio(file, wanted, unwanted) {
  const audio = await readFile(join(output, 'capture', file));
  assert(audio.length >= 48000 * 8 && audio.length < 4 * 1024 * 1024);
  const frequencies = [...wanted, ...unwanted];
  const amplitudes = [0, 1].map(channel => frequencies.map(frequency => {
    let sine = 0, cosine = 0;
    const frames = audio.length / 8;
    for (let frame = 0; frame < frames; frame++) {
      const sample = audio.readFloatLE(frame * 8 + channel * 4);
      assert(Number.isFinite(sample));
      const angle = 2 * Math.PI * frequency * frame / 48000;
      sine += sample * Math.sin(angle); cosine += sample * Math.cos(angle);
    }
    return 2 * Math.hypot(sine, cosine) / frames;
  }));
  assert(amplitudes[0][0] > 0.05 && amplitudes[1][1] > 0.03, 'Expected independent left/right tones');
  for (const channel of [0, 1]) for (let index = 0; index < frequencies.length; index++) {
    if (index !== channel) assert(amplitudes[channel][index] < 0.01, 'No channel or program crossover');
  }
  return amplitudes;
}
const amplitudes = await inspectAudio('audio.f32', [440, 880], [660, 1320]);
const survivorAmplitudes = await inspectAudio('survivor-samples/audio.f32', [660, 1320], [440, 880]);
await writeFile(join(output, 'results.json'), JSON.stringify({ report, raw, recovered, survivor, imageError, amplitudes, survivorAmplitudes,
  generatedMediaOnly: true, broadcast: false, capturedUserContent: false, output }, null, 2));
console.log(JSON.stringify({ passed: true, imageError, amplitudes, survivorAmplitudes, output }));
