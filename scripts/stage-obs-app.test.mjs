import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stageObsApp } from './stage-obs-app.mjs';

const buildId = 'test-obs-internal-build';
const uuid = '12345678-1234-1234-1234-123456789ABC';
const hash = data => createHash('sha256').update(data).digest('hex');
function fixture(t, overrides = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sauce-obs-app-stage-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'Source.app'), runtime = path.join(root, 'runtime');
  const destination = path.join(root, 'Internal.app');
  mkdirSync(path.join(source, 'Contents/MacOS'), { recursive: true });
  mkdirSync(path.join(source, 'Contents/Resources'));
  mkdirSync(runtime);
  const executable = path.join(source, 'Contents/MacOS/sauce-bunny');
  writeFileSync(executable, 'source fixture code');
  writeFileSync(path.join(source, 'Contents/Resources/existing.txt'), 'existing resource');
  const calls = [];
  const options = {
    identity: 'test-identity', buildId,
    signature: app => { calls.push(['signature', app]); return { team: 'TESTTEAM' }; },
    run(command, args, options) {
      calls.push([command, args, options]);
      if (command.endsWith('/strings')) return buildId;
      if (command.endsWith('/dwarfdump')) return `UUID: ${uuid} (arm64) fixture`;
      if (command.endsWith('/ditto')) cpSync(args[0], args[1], { recursive: true });
      if (command === process.execPath) {
        assert.deepEqual(args.slice(-2), ['--profile', 'application']);
        assert.equal(options.env.APPLE_SIGNING_IDENTITY, 'test-identity');
        writeFileSync(path.join(args[1], 'Resources/runtime-inventory.json'), '{"profile":"application","signed":true}');
      }
      if (command.endsWith('/codesign') && args.includes('--force')) {
        assert.ok(!args.includes('--deep'), 'never recursively re-sign nested code');
        // Real enclosing-app signing changes the main executable signature.
        writeFileSync(path.join(args.at(-1), 'Contents/MacOS/sauce-bunny'), 'signed fixture code');
      }
      return '';
    },
    stage(sourceRuntime, target) {
      calls.push(['stage', sourceRuntime, target]);
      assert.equal(target, path.join(destination, 'Contents/Helpers/OBS.bundle/Contents'));
      mkdirSync(target);
      mkdirSync(path.join(target, 'Resources'));
      writeFileSync(path.join(target, 'Resources/runtime-inventory.json'), '{"profile":"application"}');
    },
    verify(app, { buildId: checkedId }) {
      calls.push(['verify', app]);
      const record = JSON.parse(readFileSync(path.join(app, 'Contents/Resources/obs-internal-build.json')));
      assert.equal(checkedId, buildId);
      assert.equal(record.buildId, buildId);
      assert.equal(record.sourceExecutableSha256, hash('source fixture code'));
      assert.equal(record.executableUuid, uuid);
      assert.equal(record.runtimeInventorySha256, hash('{"profile":"application","signed":true}'));
      assert.equal(record.internalOnly, true);
      assert.equal(record.distributionReady, false);
      return { componentCount: 19, internalOnly: true, distributionReady: false };
    }, ...overrides,
  };
  return { root, source, runtime, executable, destination, calls, options,
    stage: () => stageObsApp(source, runtime, destination, options) };
}

test('stages and signs a separate internal app without modifying or launching the source', t => {
  const f = fixture(t), result = f.stage();
  assert.equal(result.app, f.destination);
  assert.equal(result.internalOnly, true);
  assert.equal(result.distributionReady, false);
  assert.equal(readFileSync(f.executable, 'utf8'), 'source fixture code');
  assert.ok(!existsSync(path.join(f.source, 'Contents/Helpers')));
  assert.equal(readFileSync(path.join(f.destination, 'Contents/Resources/existing.txt'), 'utf8'), 'existing resource');
  assert.match(readFileSync(path.join(f.destination, 'Contents/Resources/OBS-INTERNAL-TEST.txt'), 'utf8'), /Not for distribution/);
  assert.ok(f.calls.findIndex(([name]) => name === 'stage') < f.calls.findIndex(([name]) => name === 'verify'));
  assert.ok(f.calls.every(([name]) => !['open', '/usr/bin/open'].includes(name)));
});

test('refuses builds missing the expected ID before creating any destination', t => {
  const f = fixture(t, { run: () => 'previous-build' });
  assert.throws(f.stage, /missing the expected build ID/);
  assert.ok(!existsSync(f.destination));
});
test('refuses ad-hoc identity before creating any destination', t => {
  const f = fixture(t, { identity: '-' });
  assert.throws(f.stage, /stable Apple signing identity/);
  assert.ok(!existsSync(f.destination));
});
test('does not overwrite even an empty destination or follow its symlink', t => {
  const f = fixture(t);
  mkdirSync(f.destination);
  assert.throws(f.stage, /already exists/);
  const alias = path.join(f.root, 'Alias.app'); symlinkSync(f.source, alias);
  assert.throws(() => stageObsApp(f.source, f.runtime, alias, f.options), /already exists/);
  assert.equal(f.calls.length, 0);
});
test('does not stage inside source artifacts or install into Applications', t => {
  const f = fixture(t);
  for (const parent of [f.source, f.runtime]) {
    assert.throws(() => stageObsApp(f.source, f.runtime, path.join(parent, 'Nested.app'), f.options), /outside both source/);
  }
  const applications = path.join(f.root, 'Applications'); mkdirSync(applications);
  assert.throws(() => stageObsApp(f.source, f.runtime, path.join(applications, 'Installed.app'), f.options), /does not install/);
  assert.equal(f.calls.length, 0);
});
for (const name of ['OBS', 'OBS.bundle']) {
  test(`does not replace an existing ${name} runtime in the source app`, t => {
    const f = fixture(t);
    mkdirSync(path.join(f.source, 'Contents/Helpers', name), { recursive: true });
    assert.throws(f.stage, /already contains OBS/);
    assert.ok(!existsSync(f.destination));
  });
}
test('does not trust an invalid enclosing source signature', t => {
  const f = fixture(t, { signature: () => { throw new Error('invalid source signature'); } });
  assert.throws(f.stage, /invalid source signature/);
  assert.ok(!existsSync(f.destination));
});
test('rejects a main executable symlink before copying the app', t => {
  const f = fixture(t), outside = path.join(f.root, 'outside');
  writeFileSync(outside, 'external code'); rmSync(f.executable); symlinkSync(outside, f.executable);
  assert.throws(f.stage, /executable must not be a symlink/);
  assert.ok(!existsSync(f.destination));
});
test('failed runtime staging retains only an unverified artifact and never signs the app', t => {
  const f = fixture(t, { stage: () => { throw new Error('source runtime hash mismatch'); } });
  assert.throws(f.stage, /unverified artifact retained.*source runtime hash mismatch/);
  assert.ok(existsSync(f.destination));
  assert.ok(!f.calls.some(([name, args]) => name.endsWith('/codesign') && args.includes('--force')));
  assert.ok(!f.calls.some(([name]) => name === 'verify'));
});
test('a final verification failure cannot become a successful stage result', t => {
  const f = fixture(t, { verify: () => { throw new Error('nested signature mismatch'); } });
  assert.throws(f.stage, /unverified artifact retained.*nested signature mismatch/);
  assert.equal(readFileSync(f.executable, 'utf8'), 'source fixture code');
});

test('an explicit sender artifact is inspected, separately staged, recorded and signed before the enclosing app', t => {
  const f = fixture(t), sender = path.join(f.root, 'sender');
  mkdirSync(sender);
  f.options.sender = sender;
  f.options.inspectSender = (source, { run }) => {
    assert.equal(source, sender); assert.equal(run, f.options.run); f.calls.push(['inspect-sender']);
  };
  f.options.stageSender = (source, target, options) => {
    assert.equal(source, sender);
    assert.equal(target, path.join(f.destination, 'Contents/Helpers/NDISender.bundle'));
    assert.equal(options.identity, 'test-identity');
    f.calls.push(['stage-sender']);
    return { signingTeam: 'TESTTEAM', inventorySha256: 'a'.repeat(64) };
  };
  f.stage();
  const record = JSON.parse(readFileSync(path.join(f.destination, 'Contents/Resources/obs-internal-build.json')));
  assert.equal(record.senderInventorySha256, 'a'.repeat(64));
  const seal = f.calls.findIndex(([command, args]) => command.endsWith('/codesign') && args.includes('--force'));
  assert.ok(f.calls.findIndex(([command]) => command === 'inspect-sender') < f.calls.findIndex(([command]) => command === 'stage-sender'));
  assert.ok(f.calls.findIndex(([command]) => command === 'stage-sender') < seal);
  assert.match(readFileSync(path.join(f.destination, 'Contents/Resources/OBS-INTERNAL-TEST.txt'), 'utf8'), /NDISender.bundle/);
});
test('sender preflight and a pre-existing sender fail without creating or replacing an app', t => {
  const f = fixture(t), sender = path.join(f.root, 'sender'); mkdirSync(sender);
  f.options.sender = sender;
  f.options.inspectSender = () => { throw new Error('sender hash mismatch'); };
  assert.throws(f.stage, /sender hash mismatch/);
  assert.equal(existsSync(f.destination), false);
  mkdirSync(path.join(f.source, 'Contents/Helpers/NDISender.bundle'), { recursive: true });
  assert.throws(f.stage, /already contains an NDI sender/);
  assert.equal(existsSync(f.destination), false);
});
test('sender signing mismatch fails before sealing the enclosing app', t => {
  const f = fixture(t), sender = path.join(f.root, 'sender'); mkdirSync(sender);
  Object.assign(f.options, { sender, inspectSender: () => {},
    stageSender: () => ({ signingTeam: 'OTHERTEAM', inventorySha256: 'a'.repeat(64) }) });
  assert.throws(f.stage, /unverified artifact retained.*signing team/);
  assert.ok(!f.calls.some(([name, args]) => name.endsWith('/codesign') && args.includes('--force')));
});

for (const audioAcceptance of [undefined, '0', '1']) {
test(`internal builder keeps acceptance renderer/native opt-in matched (${audioAcceptance ?? 'default'}) and only builds an app`, t => {
  const f = fixture(t), scripts = path.join(f.root, 'scripts');
  mkdirSync(scripts);
  const wrapper = path.join(scripts, 'build-internal-app-with-obs.sh');
  writeFileSync(wrapper, readFileSync(new URL('./build-internal-app-with-obs.sh', import.meta.url)));
  writeFileSync(path.join(scripts, 'stable-signing.sh'), ': "${APPLE_SIGNING_IDENTITY:?}"\n');
  const credentials = ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_ISSUER', 'APPLE_API_KEY_PATH'];
  writeFileSync(path.join(scripts, 'build-app-with-ndi.sh'),
    'test "$1" = --bundles && test "$2" = app || exit 1\n' +
    `${JSON.stringify(process.execPath)} -e 'console.log(JSON.stringify({credentials:${JSON.stringify(credentials)}.filter(k=>process.env[k]),identity:process.env.APPLE_SIGNING_IDENTITY,target:process.env.CARGO_TARGET_DIR,acceptance:process.env.VITE_OBS_AUDIO_ACCEPTANCE,args:process.argv.slice(1)}))' -- "$@"\n`);
  writeFileSync(path.join(scripts, 'build-ndi-sender.sh'),
    'test "$1" = "$SAUCE_NDI_SDK_DIR/include" && test ! -e "$2" || exit 1\nmkdir "$2"\n');
  writeFileSync(path.join(scripts, 'stage-obs-app.mjs'),
    'import {statSync} from "node:fs"; if (process.argv.length !== 6 || !statSync(process.argv[5]).isDirectory()) process.exit(1); console.log("stage-called")\n');
  writeFileSync(path.join(f.runtime, 'runtime-inventory.json'), '{}');
  const environment = { ...process.env, APPLE_SIGNING_IDENTITY: 'test-identity', TMPDIR: f.root,
      SAUCE_NDI_SDK_DIR: path.join(f.root, 'sdk'),
      // An inherited renderer-only value must not escape the explicit switch.
      VITE_OBS_AUDIO_ACCEPTANCE: audioAcceptance === '1' ? '0' : '1',
      ...Object.fromEntries(credentials.map(key => [key, 'test-only-credential'])) };
  delete environment.SAUCE_OBS_AUDIO_ACCEPTANCE;
  if (audioAcceptance !== undefined) environment.SAUCE_OBS_AUDIO_ACCEPTANCE = audioAcceptance;
  const result = spawnSync('/bin/bash', [wrapper, f.runtime, f.destination], {
    encoding: 'utf8', env: environment,
  });
  assert.equal(result.status, 0, result.stderr);
  const [report, staged] = result.stdout.trim().split('\n');
  assert.deepEqual(JSON.parse(report), { credentials: [], identity: 'test-identity', target: path.join(f.root, 'src-tauri/target'),
    acceptance: audioAcceptance ?? '0',
    args: audioAcceptance === '1' ? ['--bundles', 'app', '--features', 'obs-audio-acceptance'] : ['--bundles', 'app'] });
  assert.equal(staged, 'stage-called');
});
}
