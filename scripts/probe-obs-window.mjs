// Finite, local-only test of an explicitly authorized visible window. This
// script never selects a window by title, requests permission, or broadcasts.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';

const [runtime, application, pid, windowId, ...crop] = process.argv.slice(2);
assert(runtime && application && /^[1-9]\d*$/.test(pid ?? '') && /^[1-9]\d*$/.test(windowId ?? ''),
  'usage: node scripts/probe-obs-window.mjs <private-runtime> <bundle-id> <pid> <window-id> [crop-x crop-y crop-width crop-height]');
assert(crop.length === 0 || crop.length === 4 && crop.every(value => value !== '' &&
  Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1), 'Invalid normalized crop');
const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = resolve(runtime);
const discovery = JSON.parse((await run(join(bundle, 'MacOS/saucebunny-obs-window-probe'),
  [application, pid], { timeout: 5000 })).stdout);
assert(discovery.error === '' && discovery.windows.some(window =>
  window.id === Number(windowId) && window.pid === Number(pid) && window.app === application),
'The exact authorized window must be visible before capture.');
const resultDir = await mkdtemp('/private/tmp/sauce-obs-window-proof-');
const media = join(resultDir, 'window.mp4');
const child = spawn(join(bundle, 'MacOS/saucebunny-obs-capture-probe'),
  [bundle, application, pid, windowId, ...crop], { stdio: ['ignore', 'pipe', 'pipe'] });
let diagnostics = '';
child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-65536); });
const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
try {
  const [, exit] = await Promise.all([
    pipeline(child.stdout, createWriteStream(media, { flags: 'wx' })),
    new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    }),
  ]);
  assert.equal(exit.code, 0, `Capture failed (${exit.signal ?? exit.code}):\n${diagnostics}`);
} finally {
  clearTimeout(timeout);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
const ffmpeg = join(root, 'src-tauri/binaries/ffmpeg-aarch64-apple-darwin');
const ffprobe = join(root, 'src-tauri/binaries/ffprobe-aarch64-apple-darwin');
const metadata = JSON.parse((await run(ffprobe, ['-v', 'error', '-show_entries',
  'stream=codec_name,width,height,sample_rate,channels,duration', '-of', 'json', media],
{ timeout: 10000 })).stdout);
const frame = join(resultDir, 'frame.png');
await run(ffmpeg, ['-v', 'error', '-n', '-ss', '2', '-i', media, '-frames:v', '1', frame], { timeout: 10000 });
const pcm = (await run(ffmpeg, ['-v', 'error', '-ss', '1', '-i', media, '-t', '5',
  '-map', '0:a:0', '-ac', '2', '-ar', '48000', '-f', 'f32le', 'pipe:1'],
{ encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, timeout: 10000 })).stdout;
const audio = [0, 1].map(channel => {
  let power = 0, peak = 0;
  for (let n = 0; n < pcm.length / 8; n++) {
    const sample = pcm.readFloatLE(n * 8 + channel * 4);
    power += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  return { channel, rms: Math.sqrt(power / (pcm.length / 8)), peak };
});
console.log(JSON.stringify({ resultDir, frame, streams: metadata.streams, audio,
  capturedUserContent: true, broadcast: false,
  note: 'Inspect the decoded frame. Successful encoding alone does not establish correct capture.' }, null, 2));
