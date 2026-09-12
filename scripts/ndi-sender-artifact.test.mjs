import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectSenderBuild, recordSenderBuild, senderExecutable, senderSourceFiles, stageNdiSender, verifyNdiSender } from './ndi-sender-artifact.mjs';

const team = 'ABCDEF1234', uuid = '12345678-1234-1234-1234-123456789ABC';
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sauce-ndi-artifact-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const build = path.join(root, 'build'), bundle = path.join(root, 'NDISender.bundle');
  mkdirSync(path.join(build, 'MacOS'), { recursive: true });
  for (const name of senderSourceFiles) {
    const file = path.join(build, 'source', name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `MIT test-only source: ${name}\n`);
  }
  const executable = path.join(build, senderExecutable);
  writeFileSync(executable, 'mock arm64 executable'); chmodSync(executable, 0o755);
  writeFileSync(path.join(build, 'source-sha256.txt'), senderSourceFiles.map(name =>
    `${hash(path.join(build, 'source', name))}  ${name}\n`).join(''));
  writeFileSync(path.join(build, 'sdk-headers-sha256.txt'), `${'a'.repeat(64)}  Processing.NDI.Lib.h\n`);
  const state = { architecture: 'arm64', uuid, dependencies: ['/usr/lib/libSystem.B.dylib'],
    commands: 'cmd LC_BUILD_VERSION\nplatform 1\nminos 14.0\nsdk 26.0\n', mutateSeal: false, team };
  const calls = [];
  function run(command, args) {
    calls.push([command, args]);
    if (command === 'clang++') { assert.deepEqual(args, ['--version']); return 'Apple clang version test-only\n'; }
    if (command === '/usr/bin/lipo') return state.architecture;
    if (command === '/usr/bin/dwarfdump') return `UUID: ${state.uuid} (arm64)\n`;
    if (command === '/usr/bin/otool') return args[0] === '-l' ? state.commands :
      `${args.at(-1)}:\n${state.dependencies.map(value => `\t${value} (compatibility version 1.0.0, current version 1.0.0)\n`).join('')}`;
    if (command === '/usr/bin/plutil') {
      const plist = readFileSync(args.at(-1), 'utf8');
      return JSON.stringify(Object.fromEntries([...plist.matchAll(/<key>([^<]+)<\/key><string>([^<]*)<\/string>/g)].map(match => [match[1], match[2]])));
    }
    assert.equal(command, '/usr/bin/codesign', 'no sender/SDK/application may execute');
    assert.ok(!args.includes('--deep') || args.includes('--verify'), 'never recursively re-sign');
    if (args.includes('--force')) {
      if (args.at(-1).endsWith('saucebunny-ndi-sender')) appendFileSync(args.at(-1), '\nsigned');
      else if (state.mutateSeal) appendFileSync(path.join(args.at(-1), 'Contents', senderExecutable), '\nchanged during seal');
    }
    return '';
  }
  const signature = file => { calls.push(['signature', [file]]); return { team: state.team }; };
  const record = recordSenderBuild(build, { run });
  const options = { run, signature, identity: 'stable-test-only-identity' };
  return { root, build, bundle, executable, record, state, calls, options,
    inspect: () => inspectSenderBuild(build, { run }),
    stage: () => stageNdiSender(build, bundle, options),
    verify: () => verifyNdiSender(bundle, options) };
}

test('records frozen original source, external SDK header hashes and actual binary provenance without running it', t => {
  const f = fixture(t);
  assert.deepEqual(f.inspect(), f.record);
  assert.equal(f.record.internalOnly, true);
  assert.equal(f.record.distributionReady, false);
  assert.equal(f.record.executable.uuid, uuid);
  assert.equal(f.record.executable.minimumOs, '14.0');
  assert.equal(f.record.executable.sha256, hash(f.executable));
  assert.ok(senderSourceFiles.includes('scripts/build-ndi-sender.sh'));
  assert.ok(senderSourceFiles.includes('scripts/ndi-sender-artifact.mjs'));
  assert.throws(() => recordSenderBuild(f.build, f.options), /missing or unexpected file/);
});

test('stages the exact MIT snapshot and signs code then resource-only bundle without altering source', t => {
  const f = fixture(t), original = hash(f.executable), staged = f.stage();
  assert.equal(hash(f.executable), original);
  assert.equal(staged.signingTeam, team);
  assert.notEqual(staged.executable.sha256, original, 'signed checksum is recorded separately');
  assert.deepEqual(f.verify(), staged);
  const contents = path.join(f.bundle, 'Contents');
  for (const name of senderSourceFiles) assert.equal(hash(path.join(contents, 'Resources/source', name)), hash(path.join(f.build, 'source', name)));
  assert.equal(existsSync(path.join(contents, 'Frameworks')), false, 'use the enclosing app runtime, not a second copy');
  assert.ok(!readFileSync(path.join(contents, 'Info.plist'), 'utf8').includes('CFBundleExecutable'));
  const signs = f.calls.filter(([command, args]) => command === '/usr/bin/codesign' && args.includes('--sign'));
  assert.deepEqual(signs.map(([, args]) => args.at(-1)), [path.join(contents, senderExecutable), f.bundle]);
});

for (const relative of ['source/LICENSE', 'source/scripts/build-ndi-sender.sh', 'source/obs-sidecar/raw-frame.hpp',
  'source-sha256.txt', 'sdk-headers-sha256.txt', senderExecutable]) {
  test(`changed unsigned ${relative} cannot be staged`, t => {
    const f = fixture(t);
    appendFileSync(path.join(f.build, relative), 'tampered');
    assert.throws(f.stage, /modified|manifest|provenance/);
    assert.equal(existsSync(f.bundle), false);
  });
}
test('unexpected source/SDK files and symlinks cannot enter the snapshot', t => {
  const f = fixture(t);
  const extra = path.join(f.build, 'source/Processing.NDI.Lib.h');
  writeFileSync(extra, 'must not ship SDK headers');
  assert.throws(f.inspect, /unexpected file/); rmSync(extra);
  const file = path.join(f.build, 'source/LICENSE'), outside = path.join(f.root, 'license');
  renameSync(file, outside); symlinkSync(outside, file);
  assert.throws(f.inspect, /aliases/);
});
test('build metadata cannot relabel an executable or SDK/source input', t => {
  for (const patch of [{ sourceSha256: '0'.repeat(64) }, { sdkHeadersSha256: '0'.repeat(64) },
    { distributionReady: true }, { flags: [] }, { compiler: 'private\npath' }, { unexpected: 'must not be copied' }]) {
    const f = fixture(t);
    writeFileSync(path.join(f.build, 'sender-build.json'), JSON.stringify({ ...f.record, ...patch }));
    assert.throws(f.inspect, /provenance/);
  }
});
test('sender linkage, architecture, minimum OS and search-path violations fail before signing', t => {
  for (const patch of [{ architecture: 'arm64 x86_64' }, { architecture: 'x86_64' },
    { dependencies: ['@rpath/libobs.dylib'] }, { dependencies: ['@rpath/libndi.dylib'] },
    { dependencies: ['/opt/homebrew/lib/libother.dylib'] },
    { commands: 'cmd LC_BUILD_VERSION\nplatform 2\nminos 14.0\n' },
    { commands: 'cmd LC_BUILD_VERSION\nminos 13.0\n' },
    { commands: 'cmd LC_BUILD_VERSION\nminos 14.0\ncmd LC_RPATH\npath /private/tmp/ndi\n' },
    { uuid: '00000000-0000-0000-0000-000000000000' }]) {
    const f = fixture(t); Object.assign(f.state, patch);
    assert.throws(f.stage, /arm64|linkage|macOS|search paths|provenance/);
    assert.equal(existsSync(f.bundle), false);
  }
});
test('existing destinations, aliases and nesting never replace artifacts', t => {
  const f = fixture(t);
  mkdirSync(f.bundle); assert.throws(f.stage, /new absolute bundle/); rmSync(f.bundle, { recursive: true });
  symlinkSync(f.build, f.bundle); assert.throws(f.stage, /new absolute bundle/);
  assert.throws(() => stageNdiSender(f.build, path.join(f.build, 'nested.bundle'), f.options), /new absolute bundle/);
  assert.throws(() => stageNdiSender(f.build, path.join(f.root, 'unsigned.bundle'), { ...f.options, identity: '-' }), /Stable sender/);
});
for (const relative of ['Resources/source/LICENSE', 'Resources/source/scripts/build-ndi-sender.sh',
  'Resources/source-sha256.txt', 'Resources/sdk-headers-sha256.txt', 'Resources/sender-build.json',
  'Resources/sender-inventory.json', senderExecutable]) {
  test(`signed ${relative} tampering fails independent reinspection`, t => {
    const f = fixture(t); f.stage();
    appendFileSync(path.join(f.bundle, 'Contents', relative), relative.endsWith('.json') ? ' ' : 'tampered');
    if (relative === 'Resources/sender-inventory.json') {
      // Enclosing app pins inventory bytes; its own parsed fields also reject a changed hash.
      const file = path.join(f.bundle, 'Contents', relative);
      const inventory = JSON.parse(readFileSync(file, 'utf8'));
      inventory.buildSha256 = '0'.repeat(64); writeFileSync(file, JSON.stringify(inventory));
    }
    assert.throws(f.verify, /modified|manifest|provenance|inventory/);
  });
}
test('bundle sealing cannot silently re-sign code and inventory teams cannot drift', t => {
  const f = fixture(t); f.state.mutateSeal = true;
  assert.throws(f.stage, /inventory/);
  const clean = fixture(t); clean.stage(); clean.state.team = 'DIFFER1234';
  assert.throws(clean.verify, /signing team/);
});
test('signed bundle paths and metadata cannot become aliases or executable bundles', t => {
  const f = fixture(t); f.stage();
  const plist = path.join(f.bundle, 'Contents/Info.plist');
  appendFileSync(plist, '<key>CFBundleExecutable</key><string>saucebunny-ndi-sender</string>');
  assert.throws(f.verify, /resource-only/);
  const clean = fixture(t); clean.stage();
  const source = path.join(clean.bundle, 'Contents/Resources/source'), moved = path.join(clean.root, 'outside');
  renameSync(source, moved); symlinkSync(moved, source);
  assert.throws(clean.verify, /aliases/);
});

test('resource-only detached signature files are accepted without allowing unrelated material', t => {
  const f = fixture(t); f.stage();
  const signature = path.join(f.bundle, 'Contents/_CodeSignature');
  mkdirSync(signature);
  const names = ['CodeDirectory', 'CodeRequirements', 'CodeResources', 'CodeSignature'];
  for (const name of names) writeFileSync(path.join(signature, name), `mock signed ${name}`);
  assert.equal(f.verify().signingTeam, team);
  const unexpected = path.join(signature, 'unexpected.txt');
  writeFileSync(unexpected, 'must fail');
  assert.throws(f.verify, /Unexpected sender signature material/); rmSync(unexpected);
  for (const name of names) {
    const file = path.join(signature, name), outside = path.join(f.root, `outside-${name}`);
    renameSync(file, outside); symlinkSync(outside, file);
    assert.throws(f.verify, /bounded real sender file/);
    rmSync(file); renameSync(outside, file);
  }
  rmSync(path.join(signature, 'CodeDirectory'));
  assert.throws(f.verify, /Unexpected sender signature material/);
  rmSync(path.join(signature, 'CodeRequirements')); rmSync(path.join(signature, 'CodeSignature'));
  assert.equal(f.verify().signingTeam, team, 'single resource seal remains supported');
});

test('CLI entry through directory/file aliases and doubled separators cannot silently skip argument validation', t => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sauce-ndi-cli-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = fileURLToPath(new URL('./ndi-sender-artifact.mjs', import.meta.url));
  const alias = path.join(root, 'scripts'), fileAlias = path.join(root, 'entry.mjs');
  symlinkSync(path.dirname(source), alias); symlinkSync(source, fileAlias);
  for (const entry of [source, `${alias}/ndi-sender-artifact.mjs`, `${alias}//ndi-sender-artifact.mjs`, fileAlias]) {
    for (const flags of [[], ['--preserve-symlinks-main']]) {
      for (const args of [[], ['invalid', root], ['record']]) {
        const result = spawnSync(process.execPath, [...flags, entry, ...args], { encoding: 'utf8', timeout: 5000 });
        assert.equal(result.status, 1, `CLI skipped validation for ${entry}: ${result.stderr}`);
        assert.match(result.stderr, /usage: node ndi-sender-artifact\.mjs/);
        assert.equal(result.stdout, '');
      }
    }
  }
});

test('importing the sender artifact through an alias never invokes its CLI', t => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sauce-ndi-import-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = fileURLToPath(new URL('./ndi-sender-artifact.mjs', import.meta.url));
  const alias = path.join(root, 'entry.mjs'), importer = path.join(root, 'importer.mjs');
  symlinkSync(source, alias);
  writeFileSync(importer, `const module = await import(${JSON.stringify(pathToFileURL(alias).href)}); console.log(typeof module.recordSenderBuild);\n`);
  for (const flags of [[], ['--preserve-symlinks-main', '--preserve-symlinks']]) {
    const result = spawnSync(process.execPath, [...flags, importer], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'function\n');
  }
});
