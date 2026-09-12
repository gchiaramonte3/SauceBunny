// Interactive native gate: two OWNED visible apps, fixed quiet test tones.
// No user window/media selection, mic capture, permission changes or broadcast.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { buildWindowFixture, delay, launchAudioFixture, ownedChild, reap, run, signedRuntimeTeam, until, visibleFixture } from './obs-window-test-fixture.mjs';
import { tonePairs, verifyIsolatedStereo } from './obs-audio-spectrum.mjs';

const [runtimeArg, mode, ...extra] = process.argv.slice(2);
assert(runtimeArg && (mode === undefined || mode === '--overlap') && extra.length === 0,
  'usage: node scripts/verify-obs-audio-isolation.mjs <signed-private-runtime> [--overlap]');
const overlap = mode === '--overlap';
const runtime = resolve(runtimeArg);
const output = await mkdtemp('/private/tmp/sauce-obs-audio-isolation-');
const root = fileURLToPath(new URL('../', import.meta.url));
const runtimeTeam = await signedRuntimeTeam(runtime);
const a = await buildWindowFixture(output, 'selected');
const b = await buildWindowFixture(output, 'competing', a.executable);
const fixtures = [];
const captures = [];
const sourceClocks = [];
async function audioClocks() {
  return Promise.all(fixtures.map(async fixture => {
    const records = (await readFile(fixture.stdout, 'utf8')).split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
    return records.filter(record => record.event === 'audio-clock').at(-1)?.frames ?? 0;
  }));
}
function checkCapture(capture) {
  assert(!capture.error, String(capture.error));
  assert.equal(capture.signal, null, 'Capture hit its safety timeout');
  assert.equal(capture.code, 0, capture.stderr);
  assert(capture.stderr.includes('"sourceValid":true'), capture.stderr);
}
async function completeCapture(capture) {
  await capture.closed;
  await capture.drained;
  checkCapture(capture);
  if (overlap && capture === captures[0]) {
    const survivor = captures[1];
    const beforeBytes = survivor.bytes;
    await delay(500);
    assert(!survivor.exited && survivor.bytes > beforeBytes,
      `The second capture must keep delivering media after the first exits:\n${survivor.stderr}`);
  }
  const after = await audioClocks();
  assert(after.every((frames, app) => frames - capture.before[app] >= 5 * 48000),
    'Both generated audio engines must advance throughout each capture');
  sourceClocks.push({ before: capture.before, after });
}
let emergencyCleanup;
const hardStop = setTimeout(() => {
  for (const item of captures) item.child.kill('SIGKILL');
  emergencyCleanup = Promise.all(fixtures.map(f => f.stop()));
}, 28000); // Two finite eight-second samples plus bounded discovery/startup.
console.log(`Generated tones only; two visible test apps. Results: ${output}`);
try {
  fixtures.push(await launchAudioFixture(a, output, 'selected', '--tone-a'));
  fixtures.push(await launchAudioFixture(b, output, 'competing', '--tone-b'));
  for (const fixture of fixtures) await visibleFixture(runtime, fixture);
  assert.notEqual(fixtures[0].window.pid, fixtures[1].window.pid);
  // Both audio sources run throughout. Capture them sequentially so this gate
  // measures isolation separately from multiple-helper teardown behavior.
  // Each selected capture is a positive control for the other's excluded tones.
  for (const [index, fixture] of fixtures.entries()) {
    const before = await audioClocks();
    const capture = ownedChild(join(runtime, 'MacOS/saucebunny-obs-capture-probe'),
      [runtime, fixture.application, String(fixture.window.pid), String(fixture.window.window)], false);
    capture.before = before;
    capture.media = join(output, `source-${index}.mp4`);
    capture.child.stdout.on('data', () => {
      if (capture.bytes > 8 * 1024 * 1024) {
        capture.error = new Error('Generated capture exceeded 8 MiB bound'); capture.child.kill('SIGKILL');
      }
    });
    capture.drained = pipeline(capture.child.stdout, createWriteStream(capture.media, { flags: 'wx' }))
      .catch(error => { capture.error = error; capture.child.kill('SIGKILL'); });
    captures.push(capture);
    await until(() => capture.bytes > 16384 || capture.exited || capture.error, 5000, 'encoded capture startup');
    assert(!capture.error && !capture.exited, `Capture failed before audio measurement:\n${capture.stderr}`);
    if (!overlap) await completeCapture(capture);
    else if (index === 0) await delay(1500); // Ensure a real post-exit observation window.
  }
  if (overlap) await Promise.all(captures.map(completeCapture));
  assert(fixtures.every(f => !f.launcher.exited && !f.launcher.error), 'Both tone apps must survive the entire capture');
} finally {
  clearTimeout(hardStop);
  await Promise.all(captures.map(reap));
  await (emergencyCleanup || Promise.all(fixtures.map(f => f.stop())));
  await Promise.all(captures.map(c => c.drained));
  await Promise.all(captures.map((capture, index) => writeFile(join(output, `source-${index}.log`), capture.stderr)));
}

const results = [];
for (const [index, capture] of captures.entries()) {
  const metadata = JSON.parse((await run(join(root, 'src-tauri/binaries/ffprobe-aarch64-apple-darwin'),
    ['-v', 'error', '-show_streams', '-of', 'json', capture.media], { timeout: 10000 })).stdout);
  const audio = metadata.streams.find(stream => stream.codec_type === 'audio');
  assert(audio?.codec_name === 'aac' && audio.channels === 2 && audio.sample_rate === '48000', 'Native stereo AAC required');
  const pcm = (await run(join(root, 'src-tauri/binaries/ffmpeg-aarch64-apple-darwin'),
    ['-v', 'error', '-ss', '1', '-i', capture.media, '-t', '5', '-map', '0:a:0', '-f', 'f32le', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, timeout: 10000 })).stdout;
  results.push({ tones: tonePairs[index], channels: verifyIsolatedStereo(pcm, index), bytes: capture.bytes });
}
await writeFile(join(output, 'results.json'), JSON.stringify({ results, runtimeTeam, sourceClocks, overlap,
  capturedUserContent: false, broadcast: false, permissionChanges: false }, null, 2));
console.log(JSON.stringify({ passed: true, results, output }, null, 2));
