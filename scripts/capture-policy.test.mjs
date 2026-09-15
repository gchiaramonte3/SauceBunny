import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

test('capture bootstrap follows non-GUI help/version exits and precedes every mode', () => {
  const source = readFileSync(path.join(root, 'swift-sidecar/Sources/saucebunny-capture/main.swift'), 'utf8');
  const fastExit = source.indexOf('if argv.isEmpty || argv[0] == "--version" || argv[0] == "--help"');
  const exit = source.indexOf('exit(argv.isEmpty ? 2 : 0)', fastExit);
  const bootstrap = source.indexOf('initializeCaptureApplication()');
  const dispatch = source.indexOf('switch argv[0]');
  assert.ok(fastExit >= 0 && exit > fastExit, 'help/version must exit without AppKit');
  assert.ok(bootstrap > exit && dispatch > bootstrap, 'initialize WindowServer before dispatching capture modes');
  assert.equal(source.slice(0, bootstrap).includes('await '), false, 'bootstrap must happen before any async suspension');
});

test('app packaging rebuilds the first-party capture helper before invoking Tauri', () => {
  const source = readFileSync(path.join(root, 'scripts/build-app-with-ndi.sh'), 'utf8');
  const build = source.indexOf('bash scripts/build-capture.sh');
  const bundle = source.indexOf('npx tauri build');
  assert.ok(build >= 0 && bundle > build, 'do not bundle a stale capture sidecar');
});

test('bounded stream lifetime is opt-in and installed before capture startup', () => {
  const source = readFileSync(path.join(root, 'swift-sidecar/Sources/saucebunny-capture/main.swift'), 'utf8');
  const fastExit = source.indexOf('exit(argv.isEmpty ? 2 : 0)');
  const parse = source.indexOf('CaptureStreamLimit.parse(arguments: argv)');
  const watchdog = source.indexOf('let watchdog = try CaptureStreamWatchdog(limit: limit)');
  const bootstrap = source.indexOf('initializeCaptureApplication()');
  assert.ok(fastExit >= 0 && parse > fastExit && watchdog > parse && bootstrap > watchdog);
  assert.match(source, /if let limit = try CaptureStreamLimit\.parse\(arguments: argv\)/);
  assert.match(source, /else \{ streamLifetimeWatchdog = nil; streamRequiredWindowParent = nil \}/);
  assert.match(source, /streamRequiredWindowParent = watchdog\.requiredWindowParent/);
  const selection = source.indexOf('selectedWindowOwner = w.owningApplication?.processID');
  const firstOwnerCheck = source.indexOf('captureStreamWindowPermitted(requiredParentPID: streamRequiredWindowParent,', selection);
  const secondOwnerCheck = source.indexOf('captureStreamWindowPermitted(requiredParentPID: streamRequiredWindowParent,', firstOwnerCheck + 1);
  const start = source.indexOf('try await stream.startCapture()');
  assert.ok(selection >= 0 && firstOwnerCheck > selection && secondOwnerCheck > firstOwnerCheck && start > secondOwnerCheck);
});

test('bounded stream arguments, deadline and parent loss are checked without capture', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'sauce-capture-lifetime-'));
  const binary = path.join(directory, 'capture-lifetime-tests');
  const build = spawnSync('/usr/bin/swiftc', ['-parse-as-library', '-module-cache-path', path.join(directory, 'modules'),
    path.join(root, 'swift-sidecar/Sources/saucebunny-capture/CaptureStreamLifetime.swift'),
    path.join(root, 'swift-sidecar/Tests/CapturePolicyTests/CaptureStreamLifetimeTests.swift'), '-o', binary],
  { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.ifError(build.error);
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /parent-loss policies passed; no capture APIs called/);
});

test('capture audio copies generated planar stereo safely without capture', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'sauce-capture-audio-'));
  const binary = path.join(directory, 'capture-audio-tests');
  const build = spawnSync('/usr/bin/swiftc', ['-warnings-as-errors', '-parse-as-library', '-module-cache-path', path.join(directory, 'modules'),
    path.join(root, 'swift-sidecar/Sources/saucebunny-capture/CaptureAudio.swift'),
    path.join(root, 'swift-sidecar/Tests/CapturePolicyTests/CaptureAudioTests.swift'), '-o', binary],
  { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.ifError(build.error);
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /reproduces fixed AudioBufferList rejection: status -12737/);
  assert.match(run.stdout, /malformed-buffer tests passed; no capture or playback/);
  const source = readFileSync(path.join(root, 'swift-sidecar/Sources/saucebunny-capture/main.swift'), 'utf8');
  assert.match(source, /guard let fifo = audioFifo, let pcm = captureAudioPCM\(sample\)/);
  assert.doesNotMatch(source, /bufferListSize: MemoryLayout<AudioBufferList>\.size/);
});

test('optimized parked capture owns resources and survives closed post-metadata stderr', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'sauce-capture-parked-'));
  const binary = path.join(directory, 'capture-parked-tests');
  const build = spawnSync('/usr/bin/swiftc', ['-O', '-warnings-as-errors', '-parse-as-library', '-module-cache-path', path.join(directory, 'modules'),
    path.join(root, 'swift-sidecar/Sources/saucebunny-capture/CaptureStreamLifetime.swift'),
    path.join(root, 'swift-sidecar/Tests/CapturePolicyTests/CaptureParkedLifetimeTests.swift'), '-o', binary],
  { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.ifError(build.error); assert.equal(build.status, 0, build.stderr);
  const run = (legacy, closeStderr) => new Promise((resolve, reject) => {
    const child = spawn(binary, legacy ? ['--old-discarded-continuation'] : [], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('parked helper fixture exceeded its bound')); }, 3000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', data => { stdout = (stdout + String(data)).slice(-4096); });
    child.stderr.on('data', data => {
      stderr = (stderr + String(data)).slice(-4096);
      if (closeStderr && stderr.includes('meta:')) child.stderr.destroy();
    });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  const oldClosed = await run(true, true);
  assert.equal(oldClosed.signal, 'SIGPIPE', 'reproduce the real discarded-continuation / closed-pipe failure');
  const currentClosed = await run(false, true);
  assert.equal(currentClosed.code, 0); assert.match(currentClosed.stdout, /resources-alive/);
  const currentDrained = await run(false, false);
  assert.equal(currentDrained.code, 0); assert.match(currentDrained.stdout, /no capture APIs called/);
  assert.doesNotMatch(currentDrained.stderr, /CONTINUATION MISUSE/);
  const main = readFileSync(path.join(root, 'swift-sidecar/Sources/saucebunny-capture/main.swift'), 'utf8');
  assert.match(main, /await parkCaptureStream\(retaining: \(stream, output\)\)/);
});

test('Swift display identity uses the same backing-pixel API as OBS discovery', () => {
  const reader = readFileSync(path.join(root, 'swift-sidecar/Sources/saucebunny-capture/CaptureDisplayIdentity.swift'), 'utf8')
    .replace(/\/\/[^\n]*/g, '');
  const discovery = readFileSync(path.join(root, 'obs-sidecar/window-discovery.mm'), 'utf8');
  const main = readFileSync(path.join(root, 'swift-sidecar/Sources/saucebunny-capture/main.swift'), 'utf8');
  assert.match(reader, /CGDisplayCopyDisplayMode\(id\)/);
  assert.match(reader, /UInt32\(exactly: mode\.pixelWidth\)/);
  assert.match(reader, /UInt32\(exactly: mode\.pixelHeight\)/);
  assert.doesNotMatch(reader, /CGDisplayPixels(?:Wide|High)\s*\(/);
  assert.match(discovery, /CGDisplayModeGetPixelWidth\(mode\)/);
  assert.match(discovery, /CGDisplayModeGetPixelHeight\(mode\)/);
  assert.match(main, /identity: \{ captureDisplayIdentity\(\$0\.displayID\) \}/);
});

test('AppKit bootstrap establishes WindowServer access without capture', {
  skip: process.env.SAUCE_CAPTURE_BOOTSTRAP_TEST !== '1' ? 'requires a logged-in macOS WindowServer session' : false,
}, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'sauce-capture-startup-'));
  const binary = path.join(directory, 'capture-startup-tests');
  const build = spawnSync('/usr/bin/swiftc', ['-parse-as-library', '-module-cache-path', path.join(directory, 'modules'),
    path.join(root, 'swift-sidecar/Sources/saucebunny-capture/CaptureStartup.swift'),
    path.join(root, 'swift-sidecar/Sources/saucebunny-capture/CapturePolicy.swift'),
    path.join(root, 'swift-sidecar/Sources/saucebunny-capture/CaptureDisplayIdentity.swift'),
    path.join(root, 'swift-sidecar/Tests/CapturePolicyTests/CaptureStartupTests.swift'), '-o', binary],
  { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.ifError(build.error);
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /WindowServer query passed without capture/);
  assert.match(run.stdout, /display identities match OBS display-mode backing pixels/);
});

test('native capture selection policies never broaden a requested source', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'sauce-capture-policy-'));
  const binary = path.join(directory, 'capture-policy-tests');
  const build = spawnSync('/usr/bin/swiftc', ['-parse-as-library', '-module-cache-path', path.join(directory, 'modules'),
    path.join(root, 'swift-sidecar/Sources/saucebunny-capture/CapturePolicy.swift'),
    path.join(root, 'swift-sidecar/Tests/CapturePolicyTests/CapturePolicyTests.swift'), '-o', binary],
  { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.ifError(build.error);
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /no capture APIs called/);
});
