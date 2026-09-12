// Shared setup for interactive, generated-window native tests, never production.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { copyFile, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inspectRuntime } from './inspect-obs-runtime.mjs';

export const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
export const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

export async function signedRuntimeTeam(runtime, { profile = 'diagnostic' } = {}) {
  const inventory = inspectRuntime(runtime, { profile });
  let runtimeTeam;
  for (const component of inventory.components) {
    const file = join(runtime, component.path);
    await run('codesign', ['--verify', '--strict', file], { timeout: 5000 });
    const signature = (await run('codesign', ['-dv', '--verbose=4', file], { timeout: 5000 })).stderr;
    const team = /^TeamIdentifier=([A-Z0-9]+)$/m.exec(signature)?.[1];
    assert(team && /flags=.*runtime/.test(signature) && (!runtimeTeam || team === runtimeTeam),
      `Expected one signing team and hardened runtime: ${component.path}`);
    runtimeTeam = team;
  }
  return runtimeTeam;
}

export async function buildWindowFixture(output, key = 'source', compiledFixture) {
  assert(/^[a-z]+$/.test(key), 'Invalid test fixture key');
  const identity = process.env.APPLE_SIGNING_IDENTITY;
  assert(identity && identity !== '-', 'Source scripts/stable-signing.sh first; no ad-hoc signing.');
  const app = join(output, `Capture Test ${key}.app`);
  const contents = join(app, 'Contents');
  const executable = join(contents, 'MacOS/capture-test-source');
  const application = `com.saucebunny.capture-test-${key}`;
  await mkdir(join(contents, 'MacOS'), { recursive: true });
  const plist = await readFile(join(root, 'obs-sidecar/window-fixture.plist'), 'utf8');
  await writeFile(join(contents, 'Info.plist'), plist.replace('com.saucebunny.capture-test-source', application));
  if (compiledFixture) await copyFile(compiledFixture, executable);
  else await run('xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-Wall', '-Wextra', '-Werror',
    '-mmacosx-version-min=14.0', '-arch', 'arm64', '-framework', 'AppKit', '-framework', 'AVFAudio',
    join(root, 'obs-sidecar/window-fixture.mm'), '-o', executable], { timeout: 30000 });
  await run('codesign', ['--force', '--sign', identity, '--options', 'runtime', '--timestamp=none', app], { timeout: 30000 });
  await run('codesign', ['--verify', '--strict', app], { timeout: 5000 });
  return { app, executable, application };
}

export async function until(predicate, timeout, description) {
  const deadline = performance.now() + timeout;
  while (!await predicate()) {
    assert(performance.now() < deadline, `Timed out: ${description}`);
    await delay(20);
  }
}

// NSWindow can report visible before WindowServer/SCK finishes registering its
// opening animation. Wait for this owned identity and two stable raster samples,
// never for an arbitrary window or a broader capture scope.
export async function visibleFixture(runtime, fixture) {
  let previous, observed;
  try {
    await until(async () => {
      const response = await run(join(runtime, 'MacOS/saucebunny-obs-window-probe'),
        [fixture.application, String(fixture.window.pid)], { timeout: 5000 });
      observed = JSON.parse(response.stdout);
      assert.equal(observed.error, '', 'Generated window discovery failed');
      const match = observed.windows.find(window => window.app === fixture.application &&
        window.pid === fixture.window.pid && window.id === fixture.window.window);
      if (match && previous?.width === match.width && previous?.height === match.height) return true;
      previous = match;
      await delay(100);
      return false;
    }, 4000, 'exact visible generated window with settled geometry');
  } catch (error) {
    throw new Error(`${error.message}; last fixture discovery: ${JSON.stringify(observed)}`, { cause: error });
  }
  return previous;
}

// Launch audio sources as real applications. Raw exec children share their
// launcher's macOS responsibility group; distinct window bundle IDs alone do
// not establish distinct application-audio attribution.
export async function launchAudioFixture(app, output, key, tone) {
  const fifo = join(output, `${key}.stdin`);
  const stdout = join(output, `${key}.stdout`);
  const stderr = join(output, `${key}.stderr`);
  await run('mkfifo', ['-m', '600', fifo]);
  const control = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
  await writeFile(stdout, '', { mode: 0o600 });
  await writeFile(stderr, '', { mode: 0o600 });
  const launcher = ownedChild('/usr/bin/open', ['-n', '-W', '--stdin', fifo, '--stdout', stdout,
    '--stderr', stderr, app.app, '--args', tone]);
  const source = { ...app, launcher, control, stdout, window: null };
  source.stop = async () => {
    try { await control.write('Q'); } catch (error) { if (error.code !== 'EPIPE') throw error; }
    const deadline = performance.now() + 1500;
    while (!launcher.exited && performance.now() < deadline) await delay(20);
    if (!launcher.exited && source.window) {
      // Only kill the exact process launched by this fixture, never by app name.
      const actual = await run('ps', ['-p', String(source.window.pid), '-o', 'comm=']).catch(() => null);
      if (actual?.stdout.trim() === app.executable) {
        try { process.kill(source.window.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    await reap(launcher);
    await control.close();
  };
  try {
    await until(async () => {
      const text = await readFile(stdout, 'utf8');
      const ready = text.split('\n').slice(0, -1).find(line => line.includes('"ready"'));
      if (ready) source.window = JSON.parse(ready);
      return source.window || launcher.exited || launcher.error;
    }, 5000, 'LaunchServices fixture launch');
    assert(source.window && !launcher.exited && !launcher.error, `Generated app failed: ${await readFile(stderr, 'utf8')}`);
    return source;
  } catch (error) { await source.stop(); throw error; }
}

export function ownedChild(file, args, textOutput = true) {
  const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { child, stdout: '', stderr: '', bytes: 0, exited: false, code: null, signal: null, error: null };
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') state.error = error; });
  child.stdout.on('data', chunk => {
    state.bytes += chunk.length;
    if (textOutput) state.stdout = (state.stdout + chunk).slice(-4096);
  });
  child.stderr.on('data', chunk => { state.stderr = (state.stderr + chunk).slice(-65536); });
  child.on('error', error => { state.error = error; });
  state.closed = new Promise(resolveClose => child.once('close', (code, signal) => {
    state.exited = true; state.code = code; state.signal = signal; resolveClose();
  }));
  return state;
}

export async function reap(state) {
  if (!state || state.exited) return;
  state.child.stdin.end();
  const kill = setTimeout(() => state.child.kill('SIGKILL'), 1500);
  try { await state.closed; } finally { clearTimeout(kill); }
}
