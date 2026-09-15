import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const signingScript = fileURLToPath(new URL('./stable-signing.sh', import.meta.url));
const firstHash = 'A'.repeat(40);
const secondHash = 'B'.repeat(40);
const developmentIdentity = (hash, name = 'Fixture Developer') =>
  `  1) ${hash} "Apple Development: ${name} (TESTTEAM)"\n`;

function selectIdentity(t, { identity, output = '', lookupStatus = 0 } = {}) {
  const fixture = mkdtempSync(path.join(tmpdir(), 'sauce-stable-signing-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const calls = path.join(fixture, 'security-args');
  // Do not inherit signing credentials, shell startup hooks, or the user's PATH.
  // This function shadows security while the unchanged production file runs.
  const env = {
    PATH: '/usr/bin:/bin', LC_ALL: 'C',
    SAUCE_TEST_SECURITY_CALLS: calls,
    SAUCE_TEST_SECURITY_OUTPUT: output,
    SAUCE_TEST_SECURITY_STATUS: String(lookupStatus),
  };
  if (identity !== undefined) env.APPLE_SIGNING_IDENTITY = identity;
  const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', `
set -euo pipefail
security() {
  printf '%s\\n' "$@" >> "$SAUCE_TEST_SECURITY_CALLS"
  printf '%s' "$SAUCE_TEST_SECURITY_OUTPUT"
  return "$SAUCE_TEST_SECURITY_STATUS"
}
source "$1"
# A child shell proves the selected identity is exported to downstream builds.
exec /bin/bash --noprofile --norc -uc 'printf "selected:%s\\n" "$APPLE_SIGNING_IDENTITY"'
`, 'stable-signing-test', signingScript], {
    cwd: fixture, env, encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return { ...result, calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '' };
}

function assertLookup(result) {
  assert.equal(result.calls, 'find-identity\n-v\n-p\ncodesigning\n');
}

function assertRejected(result) {
  assert.notEqual(result.status, 0, 'signing policy must stop the build');
  assert.equal(result.stdout, '', 'downstream identity consumer must not run');
}

test('rejects an explicit ad-hoc identity before consulting the keychain', t => {
  const result = selectIdentity(t, { identity: '-', output: developmentIdentity(firstHash) });
  assertRejected(result);
  assert.match(result.stderr, /Ad-hoc signing is not supported/);
  assert.equal(result.calls, '');
});

test('rejects a lookup with no available identities', t => {
  const result = selectIdentity(t, { output: '     0 valid identities found\n' });
  assertRejected(result);
  assertLookup(result);
  assert.match(result.stderr, /No ad-hoc fallback/);
});

test('does not auto-select a non-development certificate', t => {
  const result = selectIdentity(t, {
    output: `  1) ${firstHash} "Developer ID Application: Fixture (TESTTEAM)"\n     1 valid identities found\n`,
  });
  assertRejected(result);
  assertLookup(result);
  assert.match(result.stderr, /Set APPLE_SIGNING_IDENTITY/);
});

for (const identity of [undefined, '']) {
  test(`exports the only detected development identity when ${identity === undefined ? 'unset' : 'empty'}`, t => {
    const result = selectIdentity(t, {
      identity,
      output: developmentIdentity(firstHash) +
        `  2) ${secondHash} "Developer ID Application: Fixture (TESTTEAM)"\n     2 valid identities found\n`,
    });
    assert.equal(result.status, 0, result.stderr);
    assertLookup(result);
    assert.equal(result.stdout, `selected:${firstHash}\n`);
    assert.equal(result.stderr, '');
  });
}

test('rejects multiple development identities instead of choosing the first', t => {
  const result = selectIdentity(t, {
    output: developmentIdentity(firstHash) + developmentIdentity(secondHash, 'Second Developer'),
  });
  assertRejected(result);
  assertLookup(result);
  assert.match(result.stderr, /Set APPLE_SIGNING_IDENTITY/);
});

for (const output of ['', developmentIdentity(firstHash)]) {
  test(`rejects a failed lookup even ${output ? 'with a plausible partial identity' : 'without output'}`, t => {
    const result = selectIdentity(t, { output, lookupStatus: 42 });
    assertRejected(result);
    assertLookup(result);
    assert.equal(result.status, 42, 'the build entrypoints enable pipefail');
  });
}

for (const identity of ['Apple Development: Fixture Developer (TESTTEAM)',
  'Developer ID Application: Fixture Company (TESTTEAM)', firstHash]) {
  test(`preserves explicit identity ${identity} without a lookup`, t => {
    const result = selectIdentity(t, { identity, lookupStatus: 42 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls, '');
    assert.equal(result.stdout, `selected:${identity}\n`);
    assert.equal(result.stderr, '');
  });
}
