// Actual ScreenCaptureKit transitions against a disposable generated window.
// No user application/window selection, project edits, TCC changes or broadcast.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildWindowFixture, delay, ownedChild, reap, signedRuntimeTeam, until, visibleFixture } from './obs-window-test-fixture.mjs';

const [runtimeArg] = process.argv.slice(2);
assert(runtimeArg, 'usage: node scripts/verify-obs-source-lifecycle.mjs <signed-private-runtime>');
const runtime = resolve(runtimeArg);
const output = await mkdtemp('/private/tmp/sauce-obs-source-lifecycle-');
const runtimeTeam = await signedRuntimeTeam(runtime);
const { executable, application } = await buildWindowFixture(output);

const results = [];
for (const [action, event, invalidates] of [['M', 'moved', false], ['R', 'resized', true],
  ['H', 'hidden', true], ['C', 'closed', true], ['Q', 'exited', true]]) {
  const fixture = ownedChild(executable, []);
  let capture;
  let heartbeat;
  const hardStop = setTimeout(() => {
    fixture.child.kill('SIGKILL');
    capture?.child.kill('SIGKILL');
  }, 18000);
  try {
    await until(() => fixture.stdout.includes('"ready"') || fixture.exited || fixture.error, 3000, 'fixture launch');
    assert(!fixture.error && !fixture.exited, 'Disposable source failed to launch');
    const ready = JSON.parse(fixture.stdout.trim().split('\n')[0]);
    await visibleFixture(runtime, { application, window: ready });
    capture = ownedChild(join(runtime, 'MacOS/saucebunny-obs-capture-worker'),
      [runtime, application, String(ready.pid), String(ready.window)], false);
    heartbeat = setInterval(() => {
      if (!capture.exited && !capture.child.stdin.destroyed) capture.child.stdin.write('P');
    }, 200);
    await until(() => capture.bytes > 16384 || capture.exited || capture.error, 5000, 'encoded capture startup');
    assert(!capture.error && !capture.exited, `Capture failed before transition:\n${capture.stderr}`);
    const began = performance.now();
    fixture.child.stdin.write(action);
    await until(() => event === 'exited' ? fixture.exited : fixture.stdout.includes(`"${event}"`),
      1500, `fixture ${event}`);
    if (invalidates) {
      await until(() => capture.exited, 4000, `capture stops after source ${event}`);
      assert.equal(capture.code, 5, `Expected exact-source loss, not timeout/crash:\n${capture.stderr}`);
      assert(capture.stderr.includes('"sourceValid":false'), 'Missing explicit invalid source report');
    } else {
      const previousBytes = capture.bytes;
      await delay(1200);
      assert(!capture.exited && capture.bytes > previousBytes, 'Moving the same visible source must preserve capture');
      capture.child.stdin.write('S');
      await until(() => capture.exited, 4000, 'normal stop');
      assert.equal(capture.code, 0, capture.stderr);
      assert(capture.stderr.includes('"sourceValid":true'));
    }
    assert.equal(capture.signal, null, 'Capture was killed rather than stopping');
    results.push({ event, invalidates, elapsedMs: performance.now() - began, bytes: capture.bytes, exitCode: capture.code });
    console.log(JSON.stringify(results.at(-1)));
  } finally {
    clearInterval(heartbeat);
    await reap(capture);
    await reap(fixture);
    clearTimeout(hardStop);
    if (capture) await writeFile(join(output, `${event}.log`), capture.stderr);
  }
}
await writeFile(join(output, 'results.json'), JSON.stringify({ results, capturedUserContent: false,
  broadcast: false, permissionChanges: false, runtimeTeam }, null, 2));
console.log(`Source lifecycle checks passed: ${output}`);
