// Generated local PCM only. No library scan, model download, capture or playback.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

// Opt in to the actual mounted-DMG helper for packaged acceptance; ordinary
// development runs retain the debug helper. Fixtures stay generated/local.
const binary = resolve(process.env.AUDIO_TEST_HELPER || 'swift-sidecar/.build/debug/saucebunny-audio-analysis');
let directory;
before(async () => { directory = await mkdtemp(join(tmpdir(), 'sauce-audio-evidence-test-')); });
after(async () => { if (directory) await rm(directory, { recursive: true }); });

async function fixture(name, seconds, sampleAt) {
  const rate = 48_000;
  const frames = Math.round(seconds * rate);
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let frame = 0; frame < frames; frame++) bytes.writeInt16LE(Math.round(sampleAt(frame / rate) * 32767), 44 + frame * 2);
  const path = join(directory, name);
  await writeFile(path, bytes);
  return { path, source_sha256: createHash('sha256').update(bytes).digest('hex'),
    analysis_id: 'a'.repeat(64), origin_us: 0, duration_us: Math.round(seconds * 1e6), audio_track_index: 0 };
}

async function run(request, onPacket) {
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  // Test watchdog only: a missing native completion must fail the test and
  // reap its exact child, not hang the suite or leave inference running.
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const packets = [];
  let pending = '', stderr = '';
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  child.stdout.setEncoding('utf8').on('data', data => {
    pending += data;
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      const packet = JSON.parse(line); packets.push(packet); onPacket?.(packet, child);
    }
  });
  child.stdin.on('error', () => {}); // An intentionally killed worker may close first.
  child.stdin.end(JSON.stringify(request) + '\n');
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, packets, stderr, pending }));
    });
  } finally { clearTimeout(watchdog); }
}

test('native decoder skips digital silence and never labels it music', async () => {
  const request = await fixture('silence.wav', 7, () => 0);
  const result = await run(request);
  assert.equal(result.code, 0, result.stderr);
  const windows = result.packets.filter(p => p.type === 'window');
  assert.deepEqual(windows.map(p => [p.start_us, p.end_us]), [[0, 3e6], [3e6, 6e6], [6e6, 7e6]]);
  assert.ok(windows.every(p => p.status === 'digital-silence' && p.rms === 0 && p.peak === 0 && p.classifications.length === 0));
  assert.equal(result.packets.at(-1).maximum_retained_frames, 144_000);
  assert.equal(result.packets.at(-1).windows, 3);
});

test('native classifier emits scored evidence only for completely covered windows', async () => {
  const request = await fixture('signal.wav', 3.5, time => Math.sin(2 * Math.PI * 440 * time) * 0.1);
  const result = await run(request);
  assert.equal(result.code, 0, JSON.stringify(result.packets));
  const windows = result.packets.filter(p => p.type === 'window');
  assert.equal(windows.length, 2);
  assert.equal(windows[0].status, 'classified');
  assert.ok(windows[0].classifications.length > 0);
  assert.ok(windows[0].classifications.every(p => Number.isFinite(p.score) && p.score >= 0 && p.score <= 1));
  assert.equal(windows[1].status, 'insufficient-context');
  assert.deepEqual(windows[1].classifications, []);
  const terminal = result.packets.at(-1);
  assert.equal(terminal.type, 'complete');
  assert.equal(terminal.source_sha256, request.source_sha256);
  assert.equal(terminal.analysis_id, request.analysis_id);
});

test('changed source and unavailable tracks return errors, never a completed result', async () => {
  const request = await fixture('identity.wav', 1, () => 0);
  for (const changed of [{ ...request, source_sha256: '0'.repeat(64) }, { ...request, audio_track_index: 1 }]) {
    const result = await run(changed);
    assert.equal(result.code, 1);
    assert.equal(result.packets.at(-1).type, 'error');
    assert.ok(!result.packets.some(p => p.type === 'complete'));
  }
});

test('source mutation after streaming begins prevents adoption at EOF', async () => {
  const request = await fixture('mutated.wav', 30, time => Math.sin(2 * Math.PI * 330 * time) * 0.1);
  let mutated = false;
  const result = await run(request, packet => {
    if (packet.type === 'window' && !mutated) {
      // Appending changes content identity without invalidating already-open PCM.
      // Do it in this callback, not after another asynchronous read/write race.
      appendFileSync(request.path, 'changed');
      mutated = true;
    }
  });
  assert.ok(mutated);
  assert.equal(result.code, 1);
  assert.ok(result.packets.some(p => p.type === 'error' && /changed/i.test(p.message)));
  assert.ok(!result.packets.some(p => p.type === 'complete'));
});

test('terminating the isolated worker cannot publish a partial completion', async () => {
  const request = await fixture('cancel.wav', 120, time => Math.sin(2 * Math.PI * 330 * time) * 0.1);
  const result = await run(request, (packet, child) => { if (packet.type === 'window') child.kill('SIGKILL'); });
  assert.equal(result.signal, 'SIGKILL');
  assert.ok(result.packets.some(p => p.type === 'window'));
  assert.ok(!result.packets.some(p => p.type === 'complete'));
});

// Use an explicitly supplied real build, not CI's zero-byte FFmpeg stub.
test('edit-mapped nonzero origins remain accurate and collapsed AAC gaps fail', { skip: !process.env.AUDIO_TEST_FFMPEG }, async () => {
  for (const gap of [false, true]) {
    const path = join(directory, gap ? 'gap.mov' : 'offset.mov');
    const audio = gap ? 'aselect=between(t\\,0\\,2)+between(t\\,4\\,6),' : '';
    const encoded = spawnSync(process.env.AUDIO_TEST_FFMPEG, ['-nostdin', '-v', 'error',
      '-f', 'lavfi', '-i', 'color=s=64x64:r=24:d=8', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8',
      '-filter_complex', `[0:v]setpts=PTS+3/TB[v];[1:a]${audio}asetpts=PTS+3/TB[a]`,
      '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-threads:v', '1', '-c:a', 'aac', '-avoid_negative_ts', 'disabled', path],
    { encoding: 'utf8', timeout: 30_000 });
    assert.equal(encoded.status, 0, encoded.stderr);
    const request = { path, source_sha256: createHash('sha256').update(await readFile(path)).digest('hex'),
      analysis_id: 'a'.repeat(64), origin_us: 3_000_000, duration_us: 8_000_000, audio_track_index: 0 };
    const result = await run(request);
    if (gap) {
      assert.equal(result.code, 1);
      assert.match(result.packets.at(-1).message, /changed source timing/);
      assert.ok(!result.packets.some(p => p.type === 'complete'));
    } else {
      assert.equal(result.code, 0, JSON.stringify(result.packets.at(-1)));
      assert.equal(result.packets.find(p => p.type === 'window').start_us, 0);
      // MOV's millisecond edit-list timescale rounds the AAC priming trim.
      // Do not invent the missing tail to make the total exactly eight seconds.
      const end = result.packets.filter(p => p.type === 'window').at(-1).end_us;
      assert.ok(end <= 8_000_000 && end >= 7_999_000, `Actual decoded coverage ends at ${end}`);
    }
  }
});
