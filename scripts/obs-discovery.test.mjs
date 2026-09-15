import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { before, test } from 'node:test';

const project = fileURLToPath(new URL('../', import.meta.url));
let probe;
before(() => {
  const directory = mkdtempSync(path.join(tmpdir(), 'sauce-obs-discovery-test-'));
  const policy = path.join(directory, 'window-policy');
  const policyBuild = spawnSync('/usr/bin/clang++', ['-std=c++17', '-Wall', '-Wextra', '-Werror',
    path.join(project, 'obs-sidecar/window-discovery.test.cpp'), '-o', policy], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(policyBuild.status, 0, policyBuild.stderr);
  const checked = spawnSync(policy, [], { encoding: 'utf8', timeout: 5_000 });
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /Window metadata geometry tests passed/);
  probe = path.join(directory, 'window-probe');
  // Production app enumeration and CLI, deliberately without libobs or
  // ScreenCaptureKit. A window-discovery call exits 90, never touches the OS.
  const built = spawnSync('/usr/bin/clang++', ['-std=c++17', '-fobjc-arc', '-Wall', '-Wextra', '-Werror',
    '-framework', 'AppKit', '-framework', 'Foundation',
    path.join(project, 'obs-sidecar/window-probe.mm'),
    path.join(project, 'obs-sidecar/application-discovery.mm'),
    path.join(project, 'obs-sidecar/window-discovery-unavailable.test.cpp'), '-o', probe],
  { encoding: 'utf8', timeout: 30_000 });
  assert.equal(built.status, 0, built.stderr);
});

function run(args) {
  const result = spawnSync(probe, args, { encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024 + 1 });
  assert.ifError(result.error);
  return result;
}

test('production app enumeration returns only bounded identities without entering window discovery', () => {
  const result = run(['--applications']);
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(response).sort(), ['applications', 'capturedUserContent', 'error']);
  assert.equal(response.error, '');
  assert.equal(response.capturedUserContent, false);
  assert.ok(response.applications.length <= 1024);
  const processes = new Set();
  for (const app of response.applications) {
    assert.deepEqual(Object.keys(app).sort(), ['app', 'name', 'pid']);
    assert.match(app.app, /^[a-zA-Z0-9._-]{3,256}$/);
    assert.ok(app.app.includes('.'));
    assert.ok(Number.isInteger(app.pid) && app.pid > 0 && !processes.has(app.pid));
    processes.add(app.pid);
    assert.ok(app.name.length > 0 && Buffer.byteLength(app.name) <= 4096);
  }
});

test('malformed application flags/identities fail without selecting an implicit window source', () => {
  for (const args of [[], ['--all'], ['--applications', '123'], ['--applications', '--all'],
    ['--all-windows', '123'], ['/Applications/Editor.app'], ['com.editor\n'], ['com.example.editor', '-1']]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
  }
});

test('window-discovery tripwire is reachable for an explicit application only', () => {
  assert.equal(run(['com.example.editor']).status, 90);
  assert.equal(run(['com.example.editor', '123']).status, 90);
});

test('all-windows mode reaches only its separate metadata discovery seam', () => {
  assert.equal(run(['--all-windows']).status, 91);
});
test('displays mode reaches only its passive metadata discovery seam', () => {
  assert.equal(run(['--displays']).status, 92);
  assert.equal(run(['--displays', '123']).status, 2);
});

test('normal-window eligibility is wired only to the cross-application chooser', () => {
  const source = readFileSync(path.join(project, 'obs-sidecar/window-discovery.mm'), 'utf8');
  // The pure native policy above covers geometry/layer boundaries; this pins
  // the scope so applying it globally cannot narrow exact-window capture.
  const calls = source.match(/eligibleWindowForChooser\(/g) ?? [];
  assert.equal(calls.length, 1);
  assert.match(source, /\(requestedApplication\.empty\(\) && !eligibleWindowForChooser\(window\.windowLayer, window\.frame\.size\.width, window\.frame\.size\.height\)\)/);
  assert.match(source, /return discoverWindows\(application, diagnosticProcess, 0\)/);
  assert.match(source, /return discoverWindows\("", 0, excludedProcess\)/);
});
