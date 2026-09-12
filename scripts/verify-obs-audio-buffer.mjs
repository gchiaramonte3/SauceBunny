// Real libobs mixer under bounded synthetic delivery jitter, no user capture.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { signedRuntimeTeam } from './obs-window-test-fixture.mjs';

assert(process.argv.length === 3, 'usage: node scripts/verify-obs-audio-buffer.mjs <signed-runtime>');
const runtime = resolve(process.argv[2]), team = await signedRuntimeTeam(runtime);
const binary = join(runtime, 'MacOS/saucebunny-obs-audio-buffer-tests');
const control = spawnSync(binary, [runtime, '--dynamic-control'], { encoding: 'utf8', timeout: 15000 });
assert.equal(control.status, 5, `Old dynamic buffering did not reproduce the fault: ${control.stderr}`);
const negative = JSON.parse(control.stdout);
assert(!negative.fixed && !negative.passed && negative.quietFrames.every(frames => frames >= 1024),
  'Negative control failed for a reason other than the reported mixer dropout');
const runs = [];
for (let index = 0; index < 3; index++) {
  const result = JSON.parse(execFileSync(binary, [runtime], { encoding: 'utf8', timeout: 15000 }));
  assert(result.passed && result.fixed && result.bufferMs === 128 && result.quietFrames.every(frames => frames < 240));
  runs.push(result);
}
console.log(JSON.stringify({ passed: true, team, negative, runs }, null, 2));
