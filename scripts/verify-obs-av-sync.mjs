// Signed native output of a generated flash/tone-burst file. No app capture.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { run, signedRuntimeTeam } from './obs-window-test-fixture.mjs';
import { verifyFlashSync } from './obs-av-sync.mjs';

assert(process.argv.length === 3, 'usage: node scripts/verify-obs-av-sync.mjs <signed-runtime>');
const runtime = resolve(process.argv[2]);
const team = await signedRuntimeTeam(runtime);
const root = fileURLToPath(new URL('../', import.meta.url));
const ffmpeg = join(root, 'src-tauri/binaries/ffmpeg-aarch64-apple-darwin');
const ffprobe = join(root, 'src-tauri/binaries/ffprobe-aarch64-apple-darwin');
const directory = await mkdtemp('/private/tmp/sauce-obs-sync-');
const source = join(directory, 'generated-sync.mp4'), output = join(directory, 'output.mp4');
await run(ffmpeg, ['-v', 'error', '-n', '-f', 'lavfi', '-i',
  "color=c=black:s=640x360:r=30:d=10,drawbox=color=white:t=fill:enable='lt(mod(t,1),0.1)'",
  '-f', 'lavfi', '-i', "aevalsrc=0.04*sin(2*PI*440*t)*lt(mod(t\\,1)\\,0.1)|0.04*sin(2*PI*660*t)*lt(mod(t\\,1)\\,0.1):s=48000:d=10:c=stereo",
  '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
  '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', source], { timeout: 30000 });

const child = spawn(join(runtime, 'MacOS/saucebunny-obs-media-probe'), [runtime, source], { stdio: ['ignore', 'pipe', 'pipe'] });
let diagnostics = '';
child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-65536); });
const closed = new Promise((resolveExit, reject) => {
  child.once('error', reject); child.once('close', code => resolveExit(code));
});
const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
let code;
try {
  [code] = await Promise.all([closed, pipeline(child.stdout, createWriteStream(output, { flags: 'wx' }))]);
} catch (error) { child.kill('SIGKILL'); await closed.catch(() => {}); throw error; }
finally { clearTimeout(timer); await writeFile(join(directory, 'native.log'), diagnostics); }
assert.equal(code, 0, `Native output failed: ${diagnostics}`);

async function measure(file) {
  const metadata = JSON.parse((await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_frames',
    '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', file], { maxBuffer: 1024 * 1024 })).stdout);
  const pixels = (await run(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:v:0', '-vf', 'scale=1:1',
    '-fps_mode', 'passthrough', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', maxBuffer: 8192 })).stdout;
  assert.equal(pixels.length, metadata.frames.length, 'Decoded frame/timestamp count mismatch');
  const pictures = metadata.frames.map((frame, index) => ({ time: Number(frame.best_effort_timestamp_time), brightness: pixels[index] }));
  const pcm = (await run(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'f32le', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 })).stdout;
  return verifyFlashSync(pictures, pcm);
}
// Validate the actual generated reference as well as the native result.
const reference = await measure(source), actual = await measure(output);
const result = { passed: true, directory, team, reference, actual };
await writeFile(join(directory, 'results.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
