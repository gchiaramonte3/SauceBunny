import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { serviceTestTarget } from './obs-service-test-target.mjs';

// Argument parsing only. The verifier is injected; no code signing, native
// helper, generated application, or capture is executed by these tests.
const modes = [
  { name: 'replacement', flags: [], rawOutput: false, actions: [''] },
  { name: 'raw output', flags: ['--raw-output'], rawOutput: true, actions: [''] },
  { name: 'all source lifecycle actions', flags: ['--source-lifecycle'], rawOutput: false, actions: ['M', 'R', 'H', 'C', 'Q'] },
  ...['M', 'R', 'H', 'C', 'Q'].map(action => ({
    name: `source lifecycle ${action}`, flags: ['--source-lifecycle', action], rawOutput: false, actions: [action],
  })),
];

for (const { name, flags, rawOutput, actions } of modes) {
  test(`legacy diagnostic runtime retains ${name}`, () => {
    const input = 'generated fixtures/../private diagnostic runtime';
    let verificationCalls = 0;
    const target = serviceTestTarget([input, ...flags], {
      verifyApplication() { verificationCalls++; throw new Error('diagnostic mode must not verify an application'); },
    });
    assert.deepEqual(target, { runtime: resolve(input), profile: 'diagnostic', rawOutput, actions, appProof: null });
    assert.equal(verificationCalls, 0);
  });

  test(`explicit application retains ${name} and uses only the verified canonical app`, () => {
    const input = 'generated fixtures/Requested App.app';
    const proof = Object.freeze({ app: resolve('canonical fixtures/Verified App.app'), profile: 'application',
      signingTeam: 'TESTTEAM00', internalOnly: true, distributionReady: false });
    const calls = [];
    const target = serviceTestTarget([input, '--application', ...flags], {
      verifyApplication(app) { calls.push(app); return proof; },
    });
    assert.deepEqual(calls, [resolve(input)]);
    assert.deepEqual(target, { runtime: join(proof.app, 'Contents/Helpers/OBS.bundle/Contents'),
      profile: 'application', rawOutput, actions, appProof: proof });
    assert.notEqual(target.runtime, join(resolve(input), 'Contents/Helpers/OBS.bundle/Contents'));
  });
}

test('application selection is explicit and never inferred from an app path', () => {
  for (const input of ['Generated.app', 'Generated.app/', resolve('Generated App.app')]) {
    for (const flags of [[], ['--raw-output'], ['--source-lifecycle'], ['--source-lifecycle', 'Q']]) {
      let calls = 0;
      assert.throws(() => serviceTestTarget([input, ...flags], {
        verifyApplication() { calls++; return { app: resolve(input) }; },
      }), `missing --application accepted for ${JSON.stringify([input, ...flags])}`);
      assert.equal(calls, 0, 'missing explicit profile must fail before application verification');
    }
  }
});

test('malformed arguments fail before any application verifier can run', () => {
  const invalid = [
    [], [''], ['--application'], ['--raw-output'], ['--source-lifecycle'],
    ['--application', 'Generated.app'],
    ['runtime', 'extra'], ['runtime', '--unknown'], ['runtime', '--application'],
    ['runtime', '--raw-output', 'M'], ['runtime', '--raw-output', '--raw-output'],
    ['runtime', '--source-lifecycle', 'X'], ['runtime', '--source-lifecycle', 'm'],
    ['runtime', '--source-lifecycle', 'MR'], ['runtime', '--source-lifecycle', 'M', 'R'],
    ['runtime', '--source-lifecycle', '--raw-output'], ['runtime', '--raw-output', '--source-lifecycle'],
    ['runtime', '--source-lifecycle', '--source-lifecycle'],
    ['Generated.app', '--application', '--application'],
    ['Generated.app', '--application', '--unknown'],
    ['Generated.app', '--application', 'M'],
    ['Generated.app', '--application', '--raw-output', 'M'],
    ['Generated.app', '--application', '--raw-output', '--raw-output'],
    ['Generated.app', '--application', '--raw-output', '--source-lifecycle'],
    ['Generated.app', '--application', '--source-lifecycle', '--raw-output'],
    ['Generated.app', '--application', '--source-lifecycle', 'X'],
    ['Generated.app', '--application', '--source-lifecycle', 'M', 'Q'],
    ['Generated.app', '--application', '--source-lifecycle', 'Q', '--application'],
    ['Generated.app', '--raw-output', '--application'],
    ['Generated.app', '--source-lifecycle', 'M', '--application'],
  ];
  for (const args of invalid) {
    let calls = 0;
    assert.throws(() => serviceTestTarget(args, {
      verifyApplication() { calls++; return { app: resolve('Verified.app') }; },
    }), `invalid argument combination accepted: ${JSON.stringify(args)}`);
    assert.equal(calls, 0, `verification happened before rejecting ${JSON.stringify(args)}`);
  }
});

test('application verification failure is preserved without a diagnostic fallback', () => {
  const failure = new Error('generated application proof rejected');
  let calls = 0;
  assert.throws(() => serviceTestTarget(['Generated.app', '--application', '--raw-output'], {
    verifyApplication(app) { calls++; assert.equal(app, resolve('Generated.app')); throw failure; },
  }), error => error === failure);
  assert.equal(calls, 1);
});

test('neither profile can be redirected by developer or test runtime environment variables', t => {
  const keys = ['SAUCE_OBS_DEV_RUNTIME', 'SAUCE_OBS_TEST_RUNTIME'];
  const previous = keys.map(key => [key, process.env[key]]);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const key of keys) process.env[key] = resolve(`unverified overrides/${key}`);
  const diagnostic = serviceTestTarget(['explicit runtime'], {
    verifyApplication() { assert.fail('a diagnostic runtime cannot become an application through the environment'); },
  });
  assert.equal(diagnostic.runtime, resolve('explicit runtime'));
  assert.equal(diagnostic.profile, 'diagnostic');
  const proof = { app: resolve('canonical fixtures/Verified.app') };
  const application = serviceTestTarget(['Requested.app', '--application'], { verifyApplication: () => proof });
  assert.equal(application.runtime, join(proof.app, 'Contents/Helpers/OBS.bundle/Contents'));
  assert.equal(application.profile, 'application');
  assert.deepEqual(application.appProof, proof);
});
