import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applicationRequiredCode, runtimeResourcePath } from './inspect-obs-runtime.mjs';
import { expectedBuildId, inspectSignature, verifyObsApp } from './verify-obs-app.mjs';

const team = 'ABCDEF1234';
const uuid = '12345678-1234-1234-1234-123456789ABC';
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const json = (file, value) => writeFileSync(file, JSON.stringify(value) + '\n');

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sauce-obs-app-verifier-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'Internal.app');
  const runtimeBundle = path.join(app, 'Contents/Helpers/OBS.bundle');
  const runtime = path.join(runtimeBundle, 'Contents');
  const executable = path.join(app, 'Contents/MacOS/sauce-bunny');
  const resources = path.join(app, 'Contents/Resources');
  mkdirSync(path.dirname(executable), { recursive: true });
  mkdirSync(resources, { recursive: true });
  const buildId = expectedBuildId();
  writeFileSync(executable, `fixture executable\n${buildId}\n`);
  const info = { CFBundleExecutable: 'sauce-bunny', CFBundleIdentifier: 'com.saucebunny.internal-test',
    CFBundleShortVersionString: '0.5.0', CFBundleVersion: '19' };
  json(path.join(app, 'Contents/Info.plist'), info);
  mkdirSync(path.join(runtime, 'Resources'), { recursive: true });
  const runtimeInfo = { CFBundlePackageType: 'BNDL', CFBundleIdentifier: 'com.saucebunny.obs-runtime',
    CFBundleVersion: '1', CFBundleShortVersionString: '1.0' };
  const runtimePlist = path.join(runtime, 'Info.plist');
  json(runtimePlist, runtimeInfo);
  const components = applicationRequiredCode.map(relative => {
    const file = path.join(runtime, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `fixture code: ${relative}`);
    return { path: relative, architectures: ['arm64'], dependencies: ['/usr/lib/libSystem.B.dylib'],
      rpaths: [], sha256: hash(file) };
  });
  const inventory = { schema: 1, profile: 'application', internalOnly: true, distributionReady: false,
    signingTeam: team, components };
  const inventoryPath = path.join(runtime, runtimeResourcePath('application'));
  json(inventoryPath, inventory);
  const record = { schema: 1, internalOnly: true, distributionReady: false, buildId, signingTeam: team,
    runtimeInventorySha256: hash(inventoryPath), sourceExecutableSha256: hash(executable), executableUuid: uuid };
  const recordPath = path.join(resources, 'obs-internal-build.json');
  json(recordPath, record);
  const calls = [];
  const teams = new Map();
  const invalidSignatures = new Set();
  const state = { architecture: 'arm64', dependencies: '/usr/lib/libSystem.B.dylib', uuid,
    signature: 'Signature size=9000\nCodeDirectory flags=0x10000(runtime)\n', signatureStatus: 0,
    observed: structuredClone(inventory) };
  const run = (command, args) => {
    calls.push([command, args]);
    if (command === '/usr/bin/plutil') return readFileSync(args.at(-1), 'utf8');
    if (command === '/usr/bin/lipo') return state.architecture;
    if (command === '/usr/bin/dwarfdump') return `UUID: ${state.uuid} (arm64) ${executable}\n`;
    if (command === '/usr/bin/otool') return `${executable}:\n\t${state.dependencies} (compatibility version 1.0.0, current version 1.0.0)\n`;
    if (command === '/usr/bin/strings') return readFileSync(args.at(-1), 'utf8');
    if (command === process.execPath) {
      assert.ok(args[0].endsWith('/verify-ndi-package.mjs'));
      assert.equal(args[1], app);
      if (state.ndiFailure) throw new Error('NDI package verification failed');
      return 'NDI package verified (mock)';
    }
    assert.equal(command, '/usr/bin/codesign');
    assert.ok(args.includes('--verify') && args.includes('--strict'), 'the verifier may only verify signatures');
    if (invalidSignatures.has(args.at(-1))) throw new Error('Invalid code signature');
    return '';
  };
  const spawn = (command, args) => {
    calls.push([command, args]);
    assert.equal(command, '/usr/bin/codesign');
    assert.deepEqual(args.slice(0, 2), ['-dv', '--verbose=4']);
    return { status: state.signatureStatus, stdout: '',
      stderr: `TeamIdentifier=${teams.get(args.at(-1)) ?? team}\n${state.signature}` };
  };
  const inspect = (directory, options) => {
    assert.equal(directory, runtime);
    assert.deepEqual(options, { profile: 'application' });
    return structuredClone(state.observed);
  };
  return { root, app, runtimeBundle, runtime, runtimeInfo, runtimePlist, executable, inventory, inventoryPath, record, recordPath,
    info, buildId, calls, teams, invalidSignatures, state, run, spawn,
    verify: options => verifyObsApp(app, { inspect, run, spawn, ...options }),
    saveRecord: () => json(recordPath, record),
    saveInventory: () => {
      json(inventoryPath, inventory);
      record.runtimeInventorySha256 = hash(inventoryPath);
      json(recordPath, record);
    } };
}

test('verifies the staged application and every nested signature without claiming UI or distribution readiness', t => {
  const f = fixture(t);
  const result = f.verify();
  assert.deepEqual(result, { schema: 1, app: f.app, bundleId: f.info.CFBundleIdentifier,
    version: '0.5.0', bundleBuild: '19', buildId: f.buildId, executableUuid: uuid,
    signingTeam: team, componentCount: applicationRequiredCode.length,
    profile: 'application', internalOnly: true, distributionReady: false,
    buildIdEvidence: 'embedded-string-presence-only' });
  const verified = f.calls.filter(([command, args]) => command === '/usr/bin/codesign' && args.includes('--verify'));
  assert.ok(verified.some(([, args]) => args.includes('--deep') && args.at(-1) === f.app));
  for (const file of [f.runtimeBundle, f.executable, ...applicationRequiredCode.map(relative => path.join(f.runtime, relative)),
    ...['Frameworks/libobs.framework', 'PlugIns/obs-ffmpeg.plugin', 'PlugIns/sauce-obs-capture.plugin']
      .map(relative => path.join(f.runtime, relative))]) {
    assert.ok(verified.some(([, args]) => args.at(-1) === file), `missing strict signature verification: ${file}`);
  }
  assert.ok(f.calls.every(([, args]) => !args.includes('--sign') && !args.includes('--force')));
});

test('real inventory and component hashes reject tampering even with injected native inspection', t => {
  const f = fixture(t);
  appendFileSync(f.inventoryPath, ' ');
  assert.throws(() => f.verify(), /inventory was modified/);
  f.saveInventory();
  appendFileSync(path.join(f.runtime, applicationRequiredCode[0]), 'tampered');
  assert.throws(() => f.verify(), /Runtime component was modified/);
});

test('a refreshed inventory must still match independent reinspection', t => {
  const f = fixture(t);
  f.inventory.components[0].rpaths = ['@loader_path/../Frameworks'];
  f.saveInventory();
  assert.throws(() => f.verify(), /does not match reinspection/);
});

test('diagnostic profiles and diagnostic executables cannot enter the application runtime', t => {
  const f = fixture(t);
  f.inventory.profile = 'diagnostic';
  f.saveInventory();
  assert.throws(() => f.verify(), /application runtime inventory/);
  f.inventory.profile = 'application';
  const file = path.join(f.runtime, 'MacOS/saucebunny-obs-capture-probe');
  writeFileSync(file, 'diagnostic fixture');
  f.inventory.components.push({ path: path.relative(f.runtime, file), architectures: ['arm64'],
    dependencies: [], rpaths: [], sha256: hash(file) });
  f.state.observed = structuredClone(f.inventory);
  f.saveInventory();
  assert.throws(() => f.verify(), /Diagnostic executable/);
});

test('runtime directory and component links cannot escape the application', t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside-runtime');
  renameSync(f.runtime, outside);
  symlinkSync(outside, f.runtime);
  assert.throws(() => f.verify(), /escapes|real directory/);
  rmSync(f.runtime);
  renameSync(outside, f.runtime);
  const component = path.join(f.runtime, applicationRequiredCode[0]);
  const target = path.join(f.root, 'outside-code');
  renameSync(component, target);
  symlinkSync(target, component);
  assert.throws(() => f.verify(), /escapes/);
});

test('an internal runtime directory alias is also rejected', t => {
  const f = fixture(t);
  const moved = path.join(f.app, 'Contents/Helpers/MovedOBS');
  renameSync(f.runtime, moved);
  symlinkSync(moved, f.runtime);
  assert.throws(() => f.verify(), /real directory/);
});

test('legacy Helpers/OBS layout is rejected even beside a valid runtime bundle', t => {
  const f = fixture(t);
  const legacy = path.join(f.app, 'Contents/Helpers/OBS');
  mkdirSync(legacy);
  assert.throws(() => f.verify(), /Legacy Helpers\/OBS runtime layout/);
  rmSync(legacy, { recursive: true });
  renameSync(f.runtime, legacy);
  rmSync(f.runtimeBundle, { recursive: true });
  assert.throws(() => f.verify(), /Legacy Helpers\/OBS runtime layout/);
});

test('runtime BNDL metadata requires identity and versions and excludes every executable declaration', t => {
  const f = fixture(t);
  for (const patch of [
    { CFBundleExecutable: 'saucebunny-obs-capture-service' },
    { CFBundleExecutable: '' },
    { CFBundleExecutable: null },
    { CFBundlePackageType: 'APPL' },
    { CFBundlePackageType: null },
    { CFBundleIdentifier: 'com.example.other' },
    { CFBundleVersion: undefined },
    { CFBundleVersion: '' },
    { CFBundleShortVersionString: undefined },
    { CFBundleShortVersionString: '' },
  ]) {
    json(f.runtimePlist, { ...f.runtimeInfo, ...patch });
    assert.throws(() => f.verify(), /resource-only OBS BNDL/);
  }
  json(f.runtimePlist, f.runtimeInfo);
  assert.equal(f.verify().profile, 'application');
});

test('nested bundle, Resources and metadata paths cannot be symlink aliases', t => {
  for (const relative of ['Contents/Helpers/OBS.bundle', 'Contents/Helpers/OBS.bundle/Contents/Resources',
    'Contents/Helpers/OBS.bundle/Contents/Info.plist',
    'Contents/Helpers/OBS.bundle/Contents/Resources/runtime-inventory.json']) {
    const f = fixture(t);
    const original = path.join(f.app, relative);
    const moved = path.join(f.root, `moved-${path.basename(original)}`);
    renameSync(original, moved);
    symlinkSync(moved, original);
    assert.throws(() => f.verify(), /escapes|real directory|real file/, relative);
  }
});

test('component paths cannot traverse outside the runtime', t => {
  const f = fixture(t);
  f.inventory.components[0].dependencies.push('@rpath/../outside.dylib');
  f.saveInventory();
  assert.throws(() => f.verify(), /Unsafe library path/);
});

test('stale build IDs and source UUIDs fail while signing may change executable bytes', t => {
  const f = fixture(t);
  f.record.buildId = 'old-build';
  f.saveRecord();
  assert.throws(() => f.verify(), /stale internal application build record/);
  f.record.buildId = f.buildId;
  f.record.executableUuid = '00000000-0000-0000-0000-000000000000';
  f.saveRecord();
  assert.throws(() => f.verify(), /stale internal application build record/);
  f.record.executableUuid = uuid;
  f.saveRecord();
  writeFileSync(f.executable, 'old application without current build id');
  assert.throws(() => f.verify(), /missing the expected build ID/);
  writeFileSync(f.executable, `new signature bytes\n${f.buildId}\n`);
  assert.notEqual(hash(f.executable), f.record.sourceExecutableSha256);
  assert.equal(f.verify().buildId, f.buildId);
  f.record.sourceExecutableSha256 = 'not-a-hash';
  f.saveRecord();
  assert.throws(() => f.verify(), /Invalid or stale/);
});

test('outer, nested bundle, executable, component and container signatures must share one signing team', t => {
  const f = fixture(t);
  for (const file of [f.app, f.runtimeBundle, f.executable, path.join(f.runtime, applicationRequiredCode[0]),
    path.join(f.runtime, 'PlugIns/sauce-obs-capture.plugin')]) {
    f.teams.set(file, 'DIFFER1234');
    assert.throws(() => f.verify(), /signing teams do not match|Signing team differs/);
    f.teams.clear();
  }
  f.record.signingTeam = 'DIFFER1234';
  f.saveRecord();
  assert.throws(() => f.verify(), /signing teams do not match/);
});

test('invalid signatures, ad-hoc signatures and missing hardened runtime fail', t => {
  const f = fixture(t);
  f.invalidSignatures.add(f.executable);
  assert.throws(() => f.verify(), /Invalid code signature/);
  f.invalidSignatures.clear();
  for (const signature of ['Signature=adhoc\nflags=0x10002(adhoc,runtime)\n', 'Signature size=9000\nflags=0x0(none)\n']) {
    f.state.signature = signature;
    assert.throws(() => inspectSignature(f.app, f), /Invalid signature/);
  }
  f.state.signature = 'flags=0x10000(runtime)\n';
  f.state.signatureStatus = 1;
  assert.throws(() => inspectSignature(f.app, f), /Invalid signature/);
});

test('wrong architecture and linking libobs into the enclosing executable fail', t => {
  const f = fixture(t);
  f.state.architecture = 'x86_64';
  assert.throws(() => f.verify(), /missing Apple Silicon/);
  f.state.architecture = 'arm64';
  f.state.dependencies = '@rpath/libobs.framework/Versions/A/libobs';
  assert.throws(() => f.verify(), /links libobs/);
});

test('a recorded sender gets independent bundle and existing NDI runtime verification', t => {
  const f = fixture(t), senderBundle = path.join(f.app, 'Contents/Helpers/NDISender.bundle');
  mkdirSync(senderBundle);
  f.record.senderInventorySha256 = 'a'.repeat(64); f.saveRecord();
  const result = f.verify({ verifySender: (bundle, options) => {
    assert.equal(bundle, senderBundle);
    assert.equal(options.run, f.run);
    assert.equal(options.signature(bundle).team, team);
    return { inventorySha256: 'a'.repeat(64), signingTeam: team, executable: { uuid } };
  } });
  assert.deepEqual(result.sender, { executableUuid: uuid, signingTeam: team, inventorySha256: 'a'.repeat(64) });
  assert.ok(f.calls.some(([command, args]) => command === process.execPath && args[0].endsWith('/verify-ndi-package.mjs')));
});
test('missing, unrecorded or mismatched sender cannot pass an otherwise valid OBS-only app', t => {
  const f = fixture(t), senderBundle = path.join(f.app, 'Contents/Helpers/NDISender.bundle');
  f.record.senderInventorySha256 = 'a'.repeat(64); f.saveRecord();
  assert.throws(() => f.verify(), /Missing or unrecorded/);
  mkdirSync(senderBundle);
  delete f.record.senderInventorySha256; f.saveRecord();
  assert.throws(() => f.verify(), /Missing or unrecorded/);
  f.record.senderInventorySha256 = 'a'.repeat(64); f.saveRecord();
  for (const patch of [{ inventorySha256: 'b'.repeat(64) }, { signingTeam: 'DIFFER1234' }]) {
    assert.throws(() => f.verify({ verifySender: () => ({ inventorySha256: 'a'.repeat(64), signingTeam: team, ...patch }) }), /inventory or signing team/);
  }
  f.state.ndiFailure = true;
  assert.throws(() => f.verify({ verifySender: () => ({ inventorySha256: 'a'.repeat(64), signingTeam: team, executable: { uuid } }) }), /NDI package verification failed/);
});
