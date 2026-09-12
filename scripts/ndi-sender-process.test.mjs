// SPDX-License-Identifier: MIT
// Run against main + reader + TEST fake SDK, never a real NDI runtime.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { accessSync, closeSync, constants, mkdtempSync, openSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const binary = process.env.SAUCE_NDI_SENDER_TEST_BINARY;
const capture = 11n;
const broadcast = 21n;
const videoTime = 1_000_000_000_000n;
const audioTime = videoTime + 500_000_000n;
const headerSize = 64;
const maximumOutput = 64 * 1024;

before(() => {
  assert.ok(binary && isAbsolute(binary), 'Set SAUCE_NDI_SENDER_TEST_BINARY to the compiled fake-SDK sender');
  assert.ok(statSync(binary).isFile());
  accessSync(binary, constants.X_OK);
});

function video(timestamp = videoTime, width = 2, height = 2) {
  const payload = Buffer.from(Array.from({ length: width * height * 4 }, (_, index) => (index * 17 + 3) & 255));
  return packet({ kind: 1, timestamp, width, height, stride: width * 4 }, payload);
}
function audio(timestamp = audioTime) {
  const payload = Buffer.alloc(16);
  [0.25, 0.5, -0.25, -0.5].forEach((value, index) => payload.writeFloatLE(value, index * 4));
  return packet({ kind: 2, timestamp, frames: 2, sampleRate: 48000, channels: 2 }, payload);
}
function packet(info, payload) {
  const header = Buffer.alloc(headerSize);
  header.write('SBR1');
  header[4] = info.kind;
  header.writeBigUInt64BE(capture, 8);
  header.writeBigUInt64BE(broadcast, 16);
  header.writeBigUInt64BE(info.timestamp, 24);
  header.writeUInt32BE(payload.length, 32);
  for (const [name, offset] of [['width', 36], ['height', 40], ['stride', 44], ['frames', 48], ['sampleRate', 52]]) {
    header.writeUInt32BE(info[name] ?? 0, offset);
  }
  header.writeUInt16BE(info.channels ?? 0, 56);
  return Buffer.concat([header, payload]);
}
function changed(bytes, mutate) { const result = Buffer.from(bytes); mutate(result); return result; }
function checksum(bytes) {
  let value = 2166136261;
  for (const byte of bytes) value = Math.imul(value ^ byte, 16777619) >>> 0;
  return value;
}
function args() { return ['--broadcast', '--runtime', binary, '--capture', `${capture}`, '--attempt', `${broadcast}`]; }

function launch(t, { mode = 'normal', arguments: arguments_ = args(), input = 'fifo', closedStatus = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'sauce-ndi-sender-process-'));
  let writer;
  let child;
  let closed;
  let failure;
  let stdout = '';
  let stderr = '';
  let stdoutPending = '';
  let stderrPending = '';
  const statuses = [];
  const fake = [];
  const changedState = new EventEmitter();
  const descriptors = new Set();
  const own = fd => { descriptors.add(fd); return fd; };
  const release = fd => { if (descriptors.delete(fd)) closeSync(fd); };
  const end = () => { if (writer !== undefined) { release(writer); writer = undefined; } };
  const notify = () => changedState.emit('change');
  const waitFor = (predicate, label, milliseconds = 1500) => new Promise((resolve, reject) => {
    let timer;
    const finish = () => {
      let value;
      try {
        if (failure) throw failure;
        value = predicate();
      } catch (error) { clearTimeout(timer); changedState.off('change', finish); reject(error); return; }
      if (value) { clearTimeout(timer); changedState.off('change', finish); resolve(value); }
      else if (closed) {
        clearTimeout(timer); changedState.off('change', finish);
        reject(new Error(`${label}: exited ${JSON.stringify(closed)}\nstdout=${stdout}\nstderr=${stderr}`));
      }
    };
    timer = setTimeout(() => {
      changedState.off('change', finish);
      reject(new Error(`${label}: timeout after ${milliseconds}ms\nstdout=${stdout}\nstderr=${stderr}`));
    }, milliseconds);
    changedState.on('change', finish);
    finish();
  });
  t.after(async () => {
    end();
    if (child && !closed) {
      child.kill('SIGKILL');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Failed to reap owned sender during cleanup')), 2000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
        if (closed) { clearTimeout(timer); resolve(); }
      });
    }
    for (const fd of [...descriptors]) release(fd);
    rmSync(directory, { recursive: true, force: true });
  });

  // libuv's stdio:'pipe' can be a Unix socketpair on macOS. The production CLI
  // deliberately accepts only a read-only FIFO, so give it an actual FIFO.
  const fifo = join(directory, 'input.fifo');
  const created = spawnSync('/usr/bin/mkfifo', ['-m', '600', fifo], { encoding: 'utf8', timeout: 2000 });
  assert.ifError(created.error);
  assert.equal(created.status, 0, created.stderr);
  const anchor = own(openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK));
  const reader = own(openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK));
  writer = own(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
  release(anchor);
  let inherited = reader;
  if (input === 'regular') inherited = own(openSync(binary, constants.O_RDONLY));
  else if (input === 'write-only') inherited = writer;
  let statusWriter = 'pipe';
  if (closedStatus) {
    // The only read descriptor is closed BEFORE spawn. Unlike racing a
    // destroy() against startup, the first status write must see EPIPE.
    const statusFifo = join(directory, 'status.fifo');
    const made = spawnSync('/usr/bin/mkfifo', ['-m', '600', statusFifo], { encoding: 'utf8', timeout: 2000 });
    assert.ifError(made.error); assert.equal(made.status, 0, made.stderr);
    const statusReader = own(openSync(statusFifo, constants.O_RDONLY | constants.O_NONBLOCK));
    statusWriter = own(openSync(statusFifo, constants.O_WRONLY | constants.O_NONBLOCK));
    release(statusReader);
  }
  child = spawn(binary, arguments_, {
    cwd: directory,
    env: { PATH: '/usr/bin:/bin', SAUCE_NDI_FAKE_MODE: mode },
    stdio: [inherited, statusWriter, 'pipe'],
  });
  if (closedStatus) release(statusWriter);
  release(reader);
  if (input === 'regular') release(inherited);
  child.once('error', error => { failure = error; notify(); });
  child.once('close', (code, signal) => { closed = { code, signal }; notify(); });
  function collect(chunk, diagnostic) {
    const text = chunk.toString('utf8');
    if (diagnostic) { stderr += text; stderrPending += text; }
    else { stdout += text; stdoutPending += text; }
    if (stdout.length + stderr.length > maximumOutput) {
      failure = new Error('Sender exceeded bounded status output'); child.kill('SIGKILL'); notify(); return;
    }
    let pending = diagnostic ? stderrPending : stdoutPending;
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      try {
        const record = JSON.parse(line);
        (diagnostic ? fake : statuses).push(record);
      } catch { failure = new Error(`Non-JSON ${diagnostic ? 'fake diagnostic' : 'status'}: ${line}`); }
    }
    if (diagnostic) stderrPending = pending; else stdoutPending = pending;
    notify();
  }
  child.stdout?.on('data', chunk => collect(chunk, false));
  child.stderr.on('data', chunk => collect(chunk, true));
  return {
    child, statuses, fake, end,
    write(bytes) {
      assert.notEqual(writer, undefined, 'writer is still owned');
      // Fixtures are intentionally smaller than PIPE_BUF; no unbounded queue.
      assert.ok(bytes.length <= 4096);
      assert.equal(writeSync(writer, bytes), bytes.length);
    },
    status(state, milliseconds) { return waitFor(() => statuses.find(record => record.state === state), `status ${state}`, milliseconds); },
    event(name, milliseconds) { return waitFor(() => fake.find(record => record.fake === name), `fake ${name}`, milliseconds); },
    async closeStatusReader() {
      assert.ok(child.stdout && !child.stdout.destroyed, 'status reader is open');
      const stream = child.stdout;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Status reader descriptor did not close')), 1500);
        stream.once('close', () => { clearTimeout(timer); resolve(); });
        stream.destroy();
      });
    },
    get closed() { return closed; },
    async exit(milliseconds = 3500) {
      const result = await waitFor(() => closed, 'process close/reap', milliseconds);
      assert.equal(stdoutPending, '', 'no partial status line at exit');
      assert.equal(stderrPending, '', 'no partial fake diagnostic at exit');
      for (const status of statuses) {
        assert.ok(['ready', 'live', 'stopping', 'failed'].includes(status.state), 'never claim stopped before reap');
        assert.deepEqual(Object.keys(status).sort(), status.state === 'failed' ? ['reason', 'state'] : ['state']);
      }
      return result;
    },
  };
}

function successful(result) { assert.deepEqual(result, { code: 0, signal: null }); }
function rejected(sender, result, reason, code = 4) {
  assert.deepEqual(result, { code, signal: null });
  assert.ok(sender.statuses.some(status => status.state === 'failed' && status.reason === reason), `failure ${reason}`);
  assert.equal(sender.statuses.some(status => status.state === 'stopped' || status.state === 'complete'), false);
}
function frames(sender, kind) { return sender.fake.filter(event => event.fake === kind); }

test('no sender is created without explicit, valid broadcast arguments', { timeout: 30000 }, async t => {
  const cases = [
    ['no arguments', []], ['missing broadcast', args().slice(1)], ['duplicate broadcast', [...args(), '--broadcast']],
    ['unknown flag', [...args(), '--automatic']], ['relative runtime', ['--broadcast', '--runtime', 'relative.dylib', '--capture', '11', '--attempt', '21']],
    ...['0', '-1', '+1', '01', '1e0', '9007199254740992'].map(value => [`bad capture ${value}`, ['--broadcast', '--runtime', binary, '--capture', value, '--attempt', '21']]),
    ['zero attempt', ['--broadcast', '--runtime', binary, '--capture', '11', '--attempt', '0']],
    ['duplicate attempt', [...args(), '--attempt', '22']],
  ];
  for (const [name, arguments_] of cases) await t.test(name, async sub => {
    const sender = launch(sub, { arguments: arguments_ }); sender.end();
    rejected(sender, await sender.exit(), 'usage', 2);
    assert.deepEqual(sender.fake, []);
  });
});

test('regular-file and write-only stdin are rejected before the SDK factory', async t => {
  for (const input of ['regular', 'write-only']) await t.test(input, async sub => {
    const sender = launch(sub, { input }); sender.end();
    rejected(sender, await sender.exit(), 'invalid_input', 2);
    assert.deepEqual(sender.fake, []);
  });
});

test('exact BGRA and planar float payloads survive fragmented input with independent track clocks', async t => {
  const sender = launch(t);
  await sender.status('ready');
  const first = video();
  for (const [start, end] of [[0, 3], [3, 17], [17, 63], [63, 67], [67, first.length]]) {
    sender.write(first.subarray(start, end)); await delay(5);
  }
  await sender.event('video');
  await delay(50);
  assert.equal(sender.statuses.some(status => status.state === 'live'), false, 'video alone is not Live');
  sender.write(audio());
  await sender.status('live');
  // The second video timestamp is earlier than the audio clock, but within
  // the accepted one-second A/V skew. Neither track may be rebased.
  sender.write(Buffer.concat([audio(audioTime + 41_666n), video(videoTime + 33_333_333n)]));
  sender.end(); successful(await sender.exit());
  assert.deepEqual(sender.statuses, [{ state: 'ready' }, { state: 'live' }]);
  assert.deepEqual(sender.fake.map(event => event.fake), ['factory', 'video', 'audio', 'audio', 'video', 'destroy_enter', 'destroy_done']);
  assert.deepEqual(frames(sender, 'video')[0], { fake: 'video', capture: 11, broadcast: 21, timestamp: `${videoTime}`,
    width: 2, height: 2, stride: 8, bytes: 16, checksum: checksum(first.subarray(headerSize)) });
  assert.deepEqual(frames(sender, 'audio')[0], { fake: 'audio', capture: 11, broadcast: 21, timestamp: `${audioTime}`,
    frames: 2, sampleRate: 48000, channels: 2, leftFirst: 0.25, leftLast: 0.5, rightFirst: -0.25, rightLast: -0.5 });
  assert.equal(frames(sender, 'video')[1].timestamp, `${videoTime + 33_333_333n}`);
  assert.equal(frames(sender, 'audio')[1].timestamp, `${audioTime + 41_666n}`);
});

test('EOF at a record boundary is clean but zero or one track never becomes Live', async t => {
  for (const [name, bytes] of [['empty', Buffer.alloc(0)], ['video-only', video()], ['audio-only', audio()]]) {
    await t.test(name, async sub => {
      const sender = launch(sub); await sender.status('ready');
      if (bytes.length) sender.write(bytes);
      sender.end(); successful(await sender.exit());
      assert.deepEqual(sender.statuses, [{ state: 'ready' }]);
      assert.equal(sender.fake.at(-1).fake, 'destroy_done');
    });
  }
});

test('hostile headers fail without allocating their sizes or resynchronizing on later valid records', { timeout: 30000 }, async t => {
  const cases = [
    ['magic', video(), bytes => { bytes[0] = 0; }], ['version', video(), bytes => { bytes[3] = 50; }],
    ['unknown kind', video(), bytes => { bytes[4] = 3; }],
    ...[5, 6, 7, 58, 59, 60, 61, 62, 63].map(offset => [`reserved ${offset}`, video(), bytes => { bytes[offset] = 1; }]),
    ['wrong capture', video(), bytes => bytes.writeBigUInt64BE(12n, 8)],
    ['wrong attempt', video(), bytes => bytes.writeBigUInt64BE(22n, 16)],
    ['zero capture', video(), bytes => bytes.writeBigUInt64BE(0n, 8)],
    ['unsafe generation', video(), bytes => bytes.writeBigUInt64BE(9_007_199_254_740_992n, 16)],
    ['zero timestamp', video(), bytes => bytes.writeBigUInt64BE(0n, 24)],
    ['hostile payload', video(), bytes => bytes.writeUInt32BE(0xffffffff, 32)],
    ['hostile width', video(), bytes => bytes.writeUInt32BE(0xffffffff, 36)],
    ['odd height', video(), bytes => bytes.writeUInt32BE(3, 40)],
    ['wrong stride', video(), bytes => bytes.writeUInt32BE(12, 44)],
    ['audio fields on video', video(), bytes => bytes.writeUInt32BE(1, 48)],
    ['hostile audio frames', audio(), bytes => bytes.writeUInt32BE(0xffffffff, 48)],
    ['audio rate', audio(), bytes => bytes.writeUInt32BE(44100, 52)],
    ['audio channels', audio(), bytes => bytes.writeUInt16BE(1, 56)],
    ['video fields on audio', audio(), bytes => bytes.writeUInt32BE(2, 36)],
  ];
  for (const [name, bytes, mutate] of cases) await t.test(name, async sub => {
    const sender = launch(sub);
    sender.write(Buffer.concat([changed(bytes, mutate), video(), audio()])); sender.end();
    rejected(sender, await sender.exit(), 'invalid_input');
    assert.equal(frames(sender, 'video').length + frames(sender, 'audio').length, 0);
    assert.equal(sender.statuses.some(status => status.state === 'live'), false);
    assert.equal(sender.fake.at(-1).fake, 'destroy_done');
  });
});

test('EOF inside any header or payload fails instead of submitting a partial frame', async t => {
  for (const length of [1, 4, 17, 63, 64, 65, 79]) await t.test(`${length} bytes`, async sub => {
    const sender = launch(sub); sender.write(video().subarray(0, length)); sender.end();
    rejected(sender, await sender.exit(), 'truncated_input');
    assert.equal(frames(sender, 'video').length + frames(sender, 'audio').length, 0);
  });
});

test('a later generation mismatch is terminal even after both tracks reached Live', async t => {
  const sender = launch(t);
  sender.write(Buffer.concat([video(), audio()])); await sender.status('live');
  sender.write(Buffer.concat([changed(video(videoTime + 1n), bytes => bytes.writeBigUInt64BE(22n, 16)), audio(audioTime + 41_666n)]));
  sender.end(); rejected(sender, await sender.exit(), 'invalid_input');
  assert.equal(frames(sender, 'video').length, 1); assert.equal(frames(sender, 'audio').length, 1);
});

test('nonfinite planar PCM is rejected before reaching the SDK', async t => {
  for (const value of [NaN, Infinity, -Infinity]) await t.test(String(value), async sub => {
    const sender = launch(sub);
    sender.write(Buffer.concat([video(), changed(audio(), bytes => bytes.writeFloatLE(value, bytes.length - 4))])); sender.end();
    rejected(sender, await sender.exit(), 'invalid_input');
    assert.equal(frames(sender, 'video').length, 1); assert.equal(frames(sender, 'audio').length, 0);
    assert.equal(sender.statuses.some(status => status.state === 'live'), false);
  });
});

test('timestamp regression, audio discontinuity, overflow, and changing raster fail closed', async t => {
  const maximumTimestamp = (1n << 64n) - 1n;
  const cases = [
    ['duplicate video', video(), video()], ['regressed video', video(), video(videoTime - 1n)],
    ['duplicate audio', audio(), audio()], ['regressed audio', audio(), audio(audioTime - 1n)],
    ['audio gap', audio(), audio(audioTime + 41_669n)],
    ['audio overlap', audio(), audio(audioTime + 41_663n)],
    ['audio overflow', audio(maximumTimestamp - 10n), audio(maximumTimestamp - 5n)],
    ['excess A/V skew', video(), audio(videoTime + 1_000_000_001n)],
    ['changed raster', video(), video(videoTime + 1n, 4, 2)],
  ];
  for (const [name, first, next] of cases) await t.test(name, async sub => {
    const sender = launch(sub); sender.write(Buffer.concat([first, next])); sender.end();
    rejected(sender, await sender.exit(), 'invalid_input');
    assert.equal(frames(sender, 'video').length + frames(sender, 'audio').length, 1);
  });
});

test('SDK unavailable and send failures are failures, never Live or a stopped claim', async t => {
  for (const mode of ['unavailable', 'fail_video', 'fail_audio']) await t.test(mode, async sub => {
    const sender = launch(sub, { mode });
    if (mode !== 'unavailable') sender.write(Buffer.concat([video(), audio()]));
    sender.end();
    rejected(sender, await sender.exit(), mode === 'unavailable' ? 'sdk_unavailable' : 'sink_failed', mode === 'unavailable' ? 3 : 4);
    assert.equal(sender.fake[0].fake, 'factory', 'tripwire was actually exercised');
    assert.equal(sender.statuses.some(status => status.state === 'live'), false);
    if (mode !== 'unavailable') assert.equal(sender.fake.at(-1).fake, 'destroy_done');
  });
});

test('a closed status reader at startup prevents every SDK frame submission and is reaped as a failure', async t => {
  const sender = launch(t, { closedStatus: true });
  sender.write(Buffer.concat([video(), audio()])); sender.end();
  assert.deepEqual(await sender.exit(), { code: 6, signal: null }, 'EPIPE is a handled status failure, not SIGPIPE or success');
  assert.deepEqual(sender.statuses, []);
  assert.deepEqual(sender.fake.map(event => event.fake), ['factory', 'destroy_enter', 'destroy_done']);
});

test('losing the status reader after Ready stops all submissions after the failed Live write', async t => {
  const sender = launch(t); await sender.status('ready');
  await sender.closeStatusReader(); // Actual fd-close event, not a sleep.
  sender.write(Buffer.concat([video(), audio(), video(videoTime + 1n), audio(audioTime + 41_666n)]));
  sender.end();
  assert.deepEqual(await sender.exit(), { code: 6, signal: null });
  assert.deepEqual(sender.statuses, [{ state: 'ready' }], 'no invented terminal success on an unavailable status channel');
  assert.deepEqual(sender.fake.map(event => event.fake), ['factory', 'video', 'audio', 'destroy_enter', 'destroy_done']);
  assert.equal(frames(sender, 'video')[0].timestamp, `${videoTime}`);
  assert.equal(frames(sender, 'audio')[0].timestamp, `${audioTime}`);
});

test('SIGTERM or SIGINT during a header/payload discards remaining bytes and exits only after EOF', async t => {
  for (const [length, signal] of [[0, 'SIGTERM'], [17, 'SIGINT'], [72, 'SIGTERM']]) await t.test(`${signal} after ${length} bytes`, async sub => {
    const sender = launch(sub); await sender.status('ready');
    if (length) sender.write(video().subarray(0, length));
    sender.child.kill(signal); await sender.status('stopping', 1000);
    assert.equal(sender.closed, undefined, 'open FIFO is not an EOF/stop barrier');
    sender.write(Buffer.concat([video(), audio()])); sender.end();
    successful(await sender.exit());
    assert.equal(frames(sender, 'video').length + frames(sender, 'audio').length, 0, 'cancelled bytes never reach SDK');
    assert.equal(sender.statuses.some(status => status.state === 'live'), false);
    assert.equal(sender.fake.at(-1).fake, 'destroy_done');
  });
});

test('cancellation after Live forbids all later SDK submissions while draining', async t => {
  const sender = launch(t); sender.write(Buffer.concat([video(), audio()])); await sender.status('live');
  sender.child.kill('SIGTERM'); await sender.status('stopping', 1000);
  sender.write(Buffer.concat([video(videoTime + 1n), audio(audioTime + 41_666n)])); sender.end();
  successful(await sender.exit());
  assert.equal(frames(sender, 'video').length, 1); assert.equal(frames(sender, 'audio').length, 1);
});

test('an unclosed producer cannot make graceful cancellation hang indefinitely', { timeout: 6000 }, async t => {
  const sender = launch(t); await sender.status('ready'); sender.child.kill('SIGTERM');
  await sender.status('stopping', 1000);
  rejected(sender, await sender.exit(3500), 'drain_timeout', 5);
  assert.equal(sender.statuses.some(status => status.state === 'live'), false);
});

test('partial record progress has a deadline, not a hanging read', { timeout: 5000 }, async t => {
  const sender = launch(t); await sender.status('ready'); sender.write(video().subarray(0, 17));
  const failure = await sender.status('failed', 1800);
  assert.equal(failure.reason, 'read_timeout');
  sender.end(); rejected(sender, await sender.exit(), 'read_timeout');
  assert.equal(frames(sender, 'video').length, 0);
});

test('blocked foreign create/send/destroy calls are killable and reaped without a false terminal status', { timeout: 15000 }, async t => {
  for (const [mode, entered] of [['block_create', 'factory'], ['block_video', 'video'], ['block_audio', 'audio'], ['block_destroy', 'destroy_enter']]) {
    await t.test(mode, async sub => {
      const sender = launch(sub, { mode });
      if (mode !== 'block_create') {
        await sender.status('ready'); sender.write(Buffer.concat([video(), audio()]));
        if (mode === 'block_destroy') sender.end();
      }
      await sender.event(entered);
      if (mode === 'block_destroy') await sender.status('live');
      const beforeSignal = structuredClone(sender.statuses);
      sender.child.kill('SIGTERM'); await delay(100);
      assert.equal(sender.closed, undefined, 'fake foreign call must really stay blocked');
      assert.deepEqual(sender.statuses, beforeSignal, 'no status is invented while foreign code owns the thread');
      const began = performance.now();
      assert.equal(sender.child.kill('SIGKILL'), true);
      assert.deepEqual(await sender.exit(1500), { code: null, signal: 'SIGKILL' });
      assert.ok(performance.now() - began < 2000, 'hard-kill and reap are bounded');
      assert.equal(sender.fake.some(event => event.fake === 'destroy_done'), false);
      const afterReap = structuredClone(sender.statuses);
      await delay(30); assert.deepEqual(sender.statuses, afterReap, 'no later statuses after reap');
    });
  }
});
