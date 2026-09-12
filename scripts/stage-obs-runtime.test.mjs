import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applicationRequiredCode, inspectRuntime, runtimeResourcePath } from './inspect-obs-runtime.mjs';
import { applicationCopyPlan, stageRuntime, stagingDestination, validateCopyLinks,
  validateSourceInventory } from './stage-obs-runtime.mjs';

function temporary(t) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'sauce-obs-staging-test-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const component = file => ({ path: file, architectures: ['arm64'], dependencies: [], rpaths: [], sha256: 'a'.repeat(64) });
const observed = { schema: 1, profile: 'diagnostic', internalOnly: true, distributionReady: false,
  components: applicationRequiredCode.map(component) };

test('source inventory must exactly match actual binary hashes and dependency metadata', () => {
  validateSourceInventory(observed, observed);
  const legacy = structuredClone(observed);
  delete legacy.profile; delete legacy.internalOnly;
  validateSourceInventory(legacy, observed);
  for (const field of ['sha256', 'path', 'dependencies', 'rpaths', 'architectures']) {
    const changed = structuredClone(observed);
    changed.components[0][field] = field === 'sha256' || field === 'path' ? 'changed' : ['changed'];
    assert.throws(() => validateSourceInventory(changed, observed), /does not match/);
  }
  for (const changes of [{ profile: 'application' }, { schema: 2 }, { distributionReady: true },
    { internalOnly: false }, { components: null }]) {
    assert.throws(() => validateSourceInventory({ ...observed, ...changes }, observed), /diagnostic/);
  }
  assert.throws(() => validateSourceInventory({ ...observed, components: [...observed.components, observed.components[0]] }, observed), /does not match/);
});

test('copy plan excludes every diagnostic executable and retains dependency resources', () => {
  const components = structuredClone(observed.components);
  components[0].dependencies.push('@rpath/libavcodec.dylib');
  components.push(component('Frameworks/libavcodec.dylib'), component('MacOS/saucebunny-obs-capture-worker'),
    component('MacOS/obs-capture-config-tests'), component('Frameworks/diagnostic-only.dylib'));
  const plan = applicationCopyPlan(components);
  assert.equal(plan.components.length, applicationRequiredCode.length + 1);
  assert(plan.units.includes('Frameworks/libobs.framework'));
  assert(plan.units.includes('Frameworks/libavcodec.dylib'));
  assert(plan.units.includes('PlugIns/sauce-obs-capture.plugin'));
  assert(plan.units.includes('source') && plan.units.includes('licenses'));
  assert(!plan.units.some(file => /worker|tests|diagnostic-only/.test(file)));
  assert.throws(() => applicationCopyPlan(components.filter(value => value.path !== applicationRequiredCode[0])), /missing/);
});

test('destination must be new and outside source even through parent aliases', t => {
  const directory = temporary(t);
  const source = path.join(directory, 'source');
  mkdirSync(source);
  assert.equal(stagingDestination(source, path.join(directory, 'new')), path.join(directory, 'new'));
  for (const target of [source, path.join(source, 'nested'), directory, 'relative', `${directory}/sub/../new`]) {
    assert.throws(() => stagingDestination(source, target));
  }
  const alias = path.join(directory, 'alias');
  symlinkSync(source, alias);
  assert.throws(() => stagingDestination(source, path.join(alias, 'nested')), /outside/);
  const dangling = path.join(directory, 'dangling');
  symlinkSync(path.join(directory, 'absent'), dangling);
  assert.throws(() => stagingDestination(source, dangling), /exists/);
});

test('relocatable resource links are preserved, external, absolute and excluded links are rejected', t => {
  const root = temporary(t);
  mkdirSync(path.join(root, 'source'));
  mkdirSync(path.join(root, 'licenses'));
  writeFileSync(path.join(root, 'source/file'), 'source');
  const link = path.join(root, 'licenses/link');
  symlinkSync('../source/file', link);
  validateCopyLinks(root, ['source', 'licenses']);
  assert.throws(() => validateCopyLinks(root, ['licenses']), /relocated/);
  rmSync(link);
  symlinkSync(path.join(root, 'source/file'), link);
  assert.throws(() => validateCopyLinks(root, ['source', 'licenses']), /relocated/);
  rmSync(link);
  symlinkSync('/usr/bin/true', link);
  assert.throws(() => validateCopyLinks(root, ['source', 'licenses']), /escapes/);
});

test('old flat application layout and nonempty bundle parents are rejected before staging', t => {
  const root = temporary(t);
  const source = path.join(root, 'diagnostic'); mkdirSync(source);
  const flat = path.join(root, 'flat');
  assert.throws(() => stageRuntime(source, flat), /empty .bundle/);
  mkdirSync(flat);
  assert.throws(() => inspectRuntime(flat, { profile: 'application' }), /real .bundle\/Contents/);
  const bundle = path.join(root, 'OBS.bundle'); mkdirSync(bundle);
  writeFileSync(path.join(bundle, 'unexpected.txt'), 'outside Contents');
  assert.throws(() => stageRuntime(source, path.join(bundle, 'Contents')), /empty .bundle/);
});

test('real runtime stages without mutating source and rejects added diagnostic code or aliases',
  { skip: !process.env.SAUCE_OBS_TEST_RUNTIME }, t => {
    const root = temporary(t);
    const source = realpathSync(process.env.SAUCE_OBS_TEST_RUNTIME);
    const before = readFileSync(path.join(source, 'runtime-inventory.json'));
    const bundle = path.join(root, 'OBS.bundle'); mkdirSync(bundle);
    const target = path.join(bundle, 'Contents');
    const staged = stageRuntime(source, target);
    assert.equal(staged.profile, 'application');
    assert.equal(staged.internalOnly, true);
    assert.equal(staged.distributionReady, false);
    const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(target, 'Info.plist')], { encoding: 'utf8' }));
    assert.equal(info.CFBundlePackageType, 'BNDL');
    assert.equal(info.CFBundleIdentifier, 'com.saucebunny.obs-runtime');
    assert.equal(Object.hasOwn(info, 'CFBundleExecutable'), false);
    assert.deepEqual(readdirSync(bundle), ['Contents']);
    assert.deepEqual(readdirSync(path.join(target, 'Resources')).sort(), ['licenses', 'runtime-inventory.json', 'source']);
    assert.deepEqual(readdirSync(path.join(target, 'MacOS')).sort(), [
      'saucebunny-obs-capture-service', 'saucebunny-obs-window-probe',
    ]);
    assert.deepEqual(readFileSync(path.join(source, 'runtime-inventory.json')), before);
    assert(lstatSync(path.join(target, 'Frameworks/libobs.framework/Versions/Current')).isSymbolicLink());
    assert.deepEqual(inspectRuntime(target, { profile: 'application' }), staged);
    assert.throws(() => stageRuntime(source, target), /exists/);
    writeFileSync(path.join(target, 'runtime-inventory.json'), 'old flat placement');
    assert.throws(() => inspectRuntime(target, { profile: 'application' }), /data must be in Resources/);
    rmSync(path.join(target, 'runtime-inventory.json'));
    const extra = path.join(target, 'MacOS/saucebunny-obs-capture-worker');
    symlinkSync('saucebunny-obs-capture-service', extra);
    assert.throws(() => inspectRuntime(target, { profile: 'application' }), /Unexpected application/);
    rmSync(extra);
    copyFileSync(path.join(target, 'MacOS/saucebunny-obs-capture-service'), extra);
    assert.throws(() => inspectRuntime(target, { profile: 'application' }), /Unexpected application/);
  });

test('signed resource-only runtime preserves inventory code hashes and rejects resource tampering',
  { skip: !process.env.SAUCE_OBS_TEST_RUNTIME || process.env.SAUCE_OBS_TEST_SIGNING !== '1' }, t => {
    const root = temporary(t);
    const source = realpathSync(process.env.SAUCE_OBS_TEST_RUNTIME);
    const sourceInventory = readFileSync(path.join(source, runtimeResourcePath()));
    const bundle = path.join(root, 'OBS.bundle'); mkdirSync(bundle);
    const target = path.join(bundle, 'Contents');
    stageRuntime(source, target);
    const signer = fileURLToPath(new URL('./sign-obs-runtime.mjs', import.meta.url));
    execFileSync(process.execPath, [signer, target, '--profile', 'application'], { stdio: 'pipe' });
    const signed = JSON.parse(readFileSync(path.join(target, runtimeResourcePath('application')), 'utf8'));
    assert.match(signed.signingTeam, /^[A-Z0-9]{10}$/);
    assert.deepEqual(inspectRuntime(target, { profile: 'application' }).components, signed.components);
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'pipe' });
    appendFileSync(path.join(target, 'Resources/licenses/OBS-COPYING'), '\nTemporary tampering negative control.\n');
    assert.throws(() => execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'pipe' }));
    assert.deepEqual(readFileSync(path.join(source, runtimeResourcePath())), sourceInventory);
  });
