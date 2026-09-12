// Interactive regression: one OBS engine, isolated programs, first source teardown.
// Captures only owned generated-window fixtures; no user media or broadcasting.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWindowFixture, launchAudioFixture, run, signedRuntimeTeam, visibleFixture }
  from './obs-window-test-fixture.mjs';
import { verifyIsolatedStereo }
  from './obs-audio-spectrum.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const [runtimeArg, ...extra] = process.argv.slice(2);
assert(runtimeArg && extra.length === 0, 'usage: node scripts/verify-obs-shared-capture.mjs <signed-private-runtime>');
const runtime = resolve(runtimeArg);
const output = await mkdtemp('/private/tmp/sauce-obs-shared-capture-');
const team = await signedRuntimeTeam(runtime);
const a = await buildWindowFixture(output, 'selected');
const b = await buildWindowFixture(output, 'competing', a.executable);
const fixtures = [];
const chunks = [0, 0];
const drains = [];
let bytesAtFirstStop;
let child, closed, code, signal, diagnostic = '', processError;
let expired = false;
const hardStop = setTimeout(() => { expired = true; child?.kill('SIGKILL'); }, 24000);
function args(f) { return [f.application, String(f.window.pid), String(f.window.window)]; }
try {
  fixtures.push(await launchAudioFixture(a, output, 'selected', '--tone-a'));
  fixtures.push(await launchAudioFixture(b, output, 'competing', '--tone-b'));
  for (const fixture of fixtures) await visibleFixture(runtime, fixture);
  child = spawn(join(runtime, 'MacOS/saucebunny-obs-capture-overlap-probe'),
    [runtime, ...args(fixtures[0]), ...args(fixtures[1])], { stdio: ['pipe', 'ignore', 'pipe', 'pipe', 'pipe'] });
  child.on('error', error => { processError = error; });
  child.stderr.on('data', data => {
    diagnostic = (diagnostic + data).slice(-65536);
    if (bytesAtFirstStop === undefined && diagnostic.includes('"event":"stopped","slot":0')) bytesAtFirstStop = chunks[1];
  });
  closed = new Promise(resolve => child.once('close', (c, s) => { code = c; signal = s; resolve(); }));
  for (let index = 0; index < 2; index++) {
    const stream = child.stdio[index + 3];
    stream.on('data', data => {
      chunks[index] += data.length;
      if (chunks[index] > 12 * 1024 * 1024) child.kill('SIGKILL');
    });
    drains.push(pipeline(stream, createWriteStream(join(output, `${index}.mp4`), { flags: 'wx' }))
      .catch(error => { processError = error; child.kill('SIGKILL'); }));
  }
  await closed;
} finally {
  clearTimeout(hardStop);
  if (child && code === undefined) { child.kill('SIGKILL'); await closed; }
  await Promise.all(drains);
  await Promise.all(fixtures.map(f => f.stop()));
  await writeFile(join(output, 'capture.log'), diagnostic);
}
assert(!expired && !processError && code === 0 && signal === null, `${output}\n${diagnostic}`);
const records = diagnostic.split('\n').filter(s => s.startsWith('{')).map(s => JSON.parse(s));
const firstStop = records.find(r => r.slot === 0 && r.event === 'stopped');
const surviving = records.filter(r => r.slot === 1 && r.event === 'sample' && r.time > firstStop?.time + .5);
assert(surviving.length > 8 && surviving.every(r => r.healthy));
assert(surviving.at(-1).frames - surviving[0].frames > 90, 'Second encoder must keep advancing after first teardown');
assert(bytesAtFirstStop !== undefined && chunks[1] - bytesAtFirstStop > 100000,
  'Encoded bytes must continue after first teardown, not just renderer frame counts');
const results = [];
for (let index = 0; index < 2; index++) {
  const metadata = JSON.parse((await run(join(root, 'src-tauri/binaries/ffprobe-aarch64-apple-darwin'),
    ['-v', 'error', '-show_streams', '-show_packets', '-of', 'json', join(output, `${index}.mp4`)],
    { maxBuffer: 4*1024*1024, timeout: 10000 })).stdout);
  const audio = metadata.streams.find(s => s.codec_name === 'aac');
  const video = metadata.streams.find(s => s.codec_name === 'h264');
  assert(audio?.channels === 2 && audio.sample_rate === '48000' && video?.has_b_frames === 0);
  assert(video.width >= 2 && video.height >= 2 && video.width <= 1920 && video.height <= 1080);
  const seconds = Math.floor(Number(audio.duration)) - 1;
  assert(seconds >= 5 && seconds <= 12);
  for (const stream of [audio, video]) {
    const packets = metadata.packets.filter(p => p.stream_index === stream.index);
    assert(packets.length > 150);
    for (let p = 1; p < packets.length; p++) {
      const gap = Number(packets[p].dts_time) - Number(packets[p - 1].dts_time);
      assert(gap > 0 && gap < .1 && Math.abs(gap - Number(packets[p-1].duration_time)) < .00015,
        `Non-contiguous ${stream.codec_name} after concurrent capture/teardown`);
    }
  }
  const pcm = (await run(join(root, 'src-tauri/binaries/ffmpeg-aarch64-apple-darwin'),
    ['-v', 'error', '-ss', '1', '-i', join(output, `${index}.mp4`), '-t', String(seconds), '-map', '0:a:0', '-f', 'f32le', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 8*1024*1024, timeout: 10000 })).stdout;
  results.push({ channels: verifyIsolatedStereo(pcm, index), measuredSeconds: seconds, bytes: chunks[index] });
}
await writeFile(join(output, 'results.json'), JSON.stringify({ output, team, results, firstStop, surviving, bytesAfterFirstStop: chunks[1] - bytesAtFirstStop }, null, 2));
console.log(JSON.stringify({ passed: true, output, team, results, firstStop, survivingFrames: surviving.at(-1).frames - surviving[0].frames }, null, 2));
