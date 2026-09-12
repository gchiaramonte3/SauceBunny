// Generated-media only. Exercise real libobs with owner cancellation/loss,
// including an undrained stdout pipe. No window/microphone capture or broadcast.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';

const [runtime, fixture] = process.argv.slice(2).map(path => resolve(path));
assert(runtime && fixture, 'usage: node scripts/verify-obs-owner.mjs <private-runtime> <generated-fixture>');
const binary = join(runtime, 'MacOS/saucebunny-obs-media-worker');
const sleep = ms => new Promise(done => setTimeout(done, ms));
const results = [];

for (const mode of ['stop', 'eof', 'heartbeat-expired', 'blocked-output']) {
  const child = spawn(binary, [runtime, fixture], { stdio: ['pipe', 'pipe', 'pipe'] });
  let bytes = 0;
  let stderr = '';
  if (mode !== 'blocked-output') child.stdout.on('data', data => { bytes += data.length; });
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8192); });
  child.stdin.on('error', () => {});
  const exit = new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({code, signal})); });
  const heartbeat = setInterval(() => child.stdin.write('P'), 200);
  const hardLimit = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    await sleep(3000);
    if (mode !== 'blocked-output') assert(bytes > 1024, `${mode}: no media: ${stderr}`);
    clearInterval(heartbeat);
    const stoppedAt = performance.now();
    if (mode === 'stop') child.stdin.end('S');
    else if (mode === 'eof') child.stdin.end();
    const status = await exit;
    const stopMs = performance.now() - stoppedAt;
    assert.equal(status.signal, null, `${mode}: required external hard kill`);
    assert([0, 6].includes(status.code), `${mode}: exit ${status.code}: ${stderr}`);
    assert(stopMs < (mode === 'stop' || mode === 'eof' ? 4500 : 6000), `${mode}: slow stop ${stopMs}`);
    results.push({mode, ...status, stopMs, mediaBytes:bytes});
  } finally { clearInterval(heartbeat); clearTimeout(hardLimit); child.kill('SIGKILL'); child.stdout.destroy(); }
}

// Parent dies while its child's pipes remain open in this test process. EOF
// alone therefore cannot pass this case: getppid/heartbeat must stop the worker.
const launcher = spawn(process.execPath, ['-e', `
  const {spawn} = require('node:child_process');
  const child = spawn(process.argv[1], process.argv.slice(2), {stdio:['pipe','inherit','inherit']});
  process.stderr.write('WORKER_PID=' + child.pid + '\\n');
  setInterval(() => child.stdin.write('P'), 200);
`, binary, runtime, fixture], { stdio:['ignore','pipe','pipe'] });
let workerPid;
launcher.stdout.resume();
launcher.stderr.on('data', data => {
  const match = data.toString().match(/WORKER_PID=(\d+)/);
  if (match) workerPid = Number(match[1]);
});
const launcherExit = new Promise(done => launcher.once('exit', done));
try {
  await sleep(3000); assert(workerPid > 1);
  launcher.kill('SIGKILL'); await launcherExit;
  const began = performance.now();
  let gone = false;
  while (performance.now() - began < 6000) {
    try { process.kill(workerPid, 0); } catch (error) {
      if (error.code === 'ESRCH') { gone = true; workerPid = undefined; break; }
      throw error;
    }
    await sleep(100);
  }
  assert(gone, 'orphaned OBS worker survived owner death');
  results.push({mode:'owner-death', stopMs:performance.now() - began});
} finally {
  launcher.kill('SIGKILL');
  if (workerPid) { try { process.kill(workerPid, 'SIGKILL'); } catch {} }
}
console.log(JSON.stringify({passed:true, capturedUserContent:false, results}, null, 2));
